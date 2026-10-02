import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { ErrorBody } from '@dorkar/contracts';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { isProductionLike, type BaseConfig } from '../config';
import type { RequestContext } from '../context';
import { pseudonymize, safeEqual, sha256, uuidv7 } from '../crypto';
import { AppError } from '../errors';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import { childTraceparent, runInScope, traceIdOf, TRACEPARENT_HEADER } from '../trace';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

export interface HttpServerOptions {
  config: Pick<
    BaseConfig,
    | 'NODE_ENV'
    | 'SERVICE_NAME'
    | 'SERVICE_VERSION'
    | 'TRUST_PROXY'
    | 'CORS_ORIGINS'
    | 'API_DOCS_ENABLED'
  >;
  logger: Logger;
  /** Key used to pseudonymize client IPs for audit/rate limits. */
  ipHashKey: string;
  readiness: ReadinessCheck[];
  openapi?: { title: string; description?: string };
  /** Request metrics (`http_request_duration_seconds`, rate-limit rejections). */
  metrics?: Metrics;
  /**
   * Enables `GET /metrics` (Prometheus text format) for callers presenting
   * `Authorization: Bearer <token>`. Without a token the route does not exist (404).
   */
  metricsToken?: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    ctx: RequestContext;
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
export const METRICS_PATH = '/metrics';

/** Operational endpoints that are neither logged per request nor measured as traffic. */
const isOperational = (url: string) =>
  url.startsWith('/health/') || url === METRICS_PATH || url.startsWith(`${METRICS_PATH}?`);

function errorBody(
  request: FastifyRequest,
  code: ErrorBody['error']['code'],
  message: string,
  details?: Record<string, unknown>,
): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}), requestId: request.id } };
}

/**
 * Builds a Fastify instance with the platform conventions every service shares:
 * request/correlation IDs, Zod validation for requests *and* responses, the standard error
 * envelope, security headers, CORS allowlist, health endpoints and OpenAPI.
 */
export async function createHttpServer(opts: HttpServerOptions): Promise<App> {
  const { config, logger } = opts;
  let shuttingDown = false;

  const app = Fastify({
    loggerInstance: logger,
    // Trust exactly N hops (proxy-addr semantics: hop index 0 is the closest proxy).
    ...(config.TRUST_PROXY === false
      ? {}
      : { trustProxy: (_addr: string, hop: number) => hop < (config.TRUST_PROXY as number) }),
    bodyLimit: 256 * 1024,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    return503OnClosing: true,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : uuidv7();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('correlationId', '');
  app.decorateRequest('ctx', null as unknown as RequestContext);

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-correlation-id'];
    request.correlationId =
      typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : request.id;
    // Continue the caller's trace (new span id for this hop) or start one: the gateway starts
    // the trace for public traffic that carries none.
    const traceparent = childTraceparent(request.headers[TRACEPARENT_HEADER]);
    request.ctx = {
      requestId: request.id,
      correlationId: request.correlationId,
      traceparent,
      ipHash: request.ip ? pseudonymize(opts.ipHashKey, request.ip) : null,
      userAgent: request.headers['user-agent']?.slice(0, 256) ?? null,
      actor: null,
    };
    request.log = request.log.child({
      correlationId: request.correlationId,
      traceId: traceIdOf(traceparent),
    });
    void reply.header('x-request-id', request.id);
    void reply.header('x-correlation-id', request.correlationId);
  });

  // Handlers (and everything they await) run in an execution scope carrying the trace and the
  // metrics, so events, internal calls and idempotency replays pick them up without plumbing.
  // A callback hook after body parsing, so the scope reliably reaches the handler.
  app.addHook('preHandler', (request, _reply, done) => {
    runInScope(
      {
        traceparent: request.ctx.traceparent ?? childTraceparent(),
        ...(opts.metrics ? { metrics: opts.metrics } : {}),
      },
      done,
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    if (isOperational(request.url)) return;
    opts.metrics?.observeHttp(
      request.method,
      request.routeOptions.url,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        actorId: request.ctx?.actor?.id,
      },
      'request completed',
    );
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    credentials: true,
    exposedHeaders: ['x-request-id', 'x-correlation-id', 'retry-after'],
    maxAge: 600,
  });

  const docsEnabled = config.API_DOCS_ENABLED ?? !isProductionLike(config);
  if (opts.openapi) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: opts.openapi.title,
          version: config.SERVICE_VERSION,
          ...(opts.openapi.description ? { description: opts.openapi.description } : {}),
        },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: jsonSchemaTransform,
    });
    if (docsEnabled) await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(errorBody(request, 'NOT_FOUND', 'Route not found.'));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.code === 'RATE_LIMITED') {
        opts.metrics?.rateLimitRejections.inc({ route: request.routeOptions.url ?? 'unmatched' });
      }
      if (error.headers) void reply.headers(error.headers);
      return reply
        .status(error.status)
        .send(errorBody(request, error.code, error.message, error.details));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send(
        errorBody(request, 'VALIDATION_FAILED', 'Request validation failed.', {
          in: error.validationContext,
          issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        }),
      );
    }
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, issues: error.cause.issues },
        'response failed schema validation',
      );
      return reply.status(500).send(errorBody(request, 'INTERNAL', 'Internal error.'));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) {
      return reply.status(413).send(errorBody(request, 'PAYLOAD_TOO_LARGE', 'Payload too large.'));
    }
    if (status === 415) {
      return reply
        .status(415)
        .send(errorBody(request, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type.'));
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(400).send(errorBody(request, 'BAD_REQUEST', 'Malformed request.'));
    }
    if (status === 503) {
      return reply.status(503).send(errorBody(request, 'UNAVAILABLE', 'Service unavailable.'));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(errorBody(request, 'INTERNAL', 'Internal error.'));
  });

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (request, reply) => {
    if (shuttingDown) return reply.status(503).send({ status: 'shutting_down' });
    const results = await Promise.all(
      opts.readiness.map(async (r) => {
        try {
          await r.check();
          return [r.name, 'ok'] as const;
        } catch (err) {
          request.log.warn({ err, check: r.name }, 'readiness check failed');
          return [r.name, 'fail'] as const;
        }
      }),
    );
    const ok = results.every(([, s]) => s === 'ok');
    return reply
      .status(ok ? 200 : 503)
      .send({ status: ok ? 'ok' : 'degraded', checks: Object.fromEntries(results) });
  });

  if (opts.metricsToken && opts.metrics) {
    const metrics = opts.metrics;
    // Compare digests: constant time and independent of the presented value's length.
    const expected = sha256(`Bearer ${opts.metricsToken}`);
    app.get(METRICS_PATH, { schema: { hide: true } }, async (request, reply) => {
      const got = request.headers.authorization;
      if (typeof got !== 'string' || !safeEqual(sha256(got), expected)) {
        return reply
          .status(401)
          .header('www-authenticate', 'Bearer')
          .send(errorBody(request, 'UNAUTHENTICATED', 'Authentication required.'));
      }
      const { contentType, body } = await metrics.render();
      return reply
        .header('content-type', contentType)
        .header('cache-control', 'no-store')
        .send(body);
    });
  }

  app.decorate('markShuttingDown', () => {
    shuttingDown = true;
  });

  return app as unknown as App;
}

declare module 'fastify' {
  interface FastifyInstance {
    markShuttingDown(): void;
  }
}

export type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/** `{ data }` envelope used by every success response. */
export const ok = <T>(data: T) => ({ data });
