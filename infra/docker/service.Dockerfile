# syntax=docker/dockerfile:1.7
# One Dockerfile for every Node service. Build from the repo root:
#   docker build -f infra/docker/service.Dockerfile \
#     --build-arg SERVICE=identity-service --build-arg PACKAGE=@dorkar/identity-service \
#     -t dorkar/identity-service:dev .
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS build
ARG SERVICE
ARG PACKAGE
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/contracts/package.json packages/contracts/
COPY services/${SERVICE}/package.json services/${SERVICE}/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "${PACKAGE}..."
COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages packages
COPY services/${SERVICE} services/${SERVICE}
RUN pnpm --filter "${PACKAGE}" build \
 && pnpm --filter "${PACKAGE}" deploy --prod --legacy /out \
 && cp -r services/${SERVICE}/dist /out/dist

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Services with migrations run them from the same image: `node dist/migrate.js up`
CMD ["node", "--enable-source-maps", "dist/main.js"]
