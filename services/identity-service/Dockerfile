# syntax=docker/dockerfile:1.7
# Build from the repo root:  docker build -f services/identity-service/Dockerfile -t dorkar/identity:dev .
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/contracts/package.json packages/contracts/
COPY services/identity-service/package.json services/identity-service/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @dorkar/identity-service...
COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages packages
COPY services/identity-service services/identity-service
RUN pnpm --filter @dorkar/identity-service build \
 && pnpm --filter @dorkar/identity-service deploy --prod --legacy /out \
 && cp -r services/identity-service/dist /out/dist

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4001}/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Same image runs migrations: `docker run … node dist/migrate.js up`
CMD ["node", "--enable-source-maps", "dist/main.js"]
