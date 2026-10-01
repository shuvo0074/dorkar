import proxy, { type FastifyHttpProxyOptions } from '@fastify/http-proxy';
import type { ErrorBody } from '@dorkar/contracts';
import type { App } from '@dorkar/kernel';
import type { IncomingHttpHeaders } from 'node:http';
import type { RouteRule, Upstream } from '../../route-table';

export interface ProxyOptions {
  routes: readonly RouteRule[];
  upstreams: Record<Upstream, string>;
  timeoutMs: number;
}

/** Headers a client must never be able to set on the hop to an internal service. */
const STRIPPED_REQUEST_HEADERS = [/^x-forwarded-/, /^x-real-ip$/, /^forwarded$/, /^x-internal-/];
/** CORS is decided once, at the edge; upstream CORS headers would duplicate or contradict it. */
const STRIPPED_RESPONSE_HEADERS = /^access-control-/;

/** The request fields the header rewrite needs (works for HTTP/1 and HTTP/2 request types). */
interface EdgeRequest {
  ip: string;
  protocol: string;
  hostname: string;
  id: string;
  correlationId: string;
}

function requestHeaders(req: EdgeRequest, headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIPPED_REQUEST_HEADERS.some((re) => re.test(name))) out[name] = value;
  }
  // Replace, never append: services trust exactly one hop (the gateway).
  out['x-forwarded-for'] = req.ip;
  out['x-forwarded-proto'] = req.protocol;
  out['x-forwarded-host'] = req.hostname;
  out['x-request-id'] = req.id;
  out['x-correlation-id'] = req.correlationId;
  return out;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIPPED_RESPONSE_HEADERS.test(name)) out[name] = value;
  }
  return out;
}

function upstreamErrorBody(requestId: string, error: Error): { status: number; body: ErrorBody } {
  const timeout = (error as { statusCode?: number }).statusCode === 504;
  const body: ErrorBody = {
    error: {
      code: timeout ? 'UPSTREAM_TIMEOUT' : 'UNAVAILABLE',
      message: timeout
        ? 'The service took too long to respond.'
        : 'Service temporarily unavailable.',
      requestId,
    },
  };
  return { status: timeout ? 504 : 503, body };
}

export async function registerProxies(app: App, opts: ProxyOptions): Promise<void> {
  for (const route of opts.routes) {
    const options: FastifyHttpProxyOptions = {
      upstream: opts.upstreams[route.upstream],
      prefix: route.prefix,
      rewritePrefix: route.prefix,
      disableRequestLogging: true, // the edge logs one line per request itself
      undici: {
        connections: 64,
        pipelining: 1,
        keepAliveTimeout: 30_000,
        headersTimeout: opts.timeoutMs,
        bodyTimeout: opts.timeoutMs,
      },
      replyOptions: {
        rewriteRequestHeaders: requestHeaders,
        rewriteHeaders: responseHeaders,
        onError: (reply, { error }) => {
          reply.log.warn({ err: error }, 'upstream request failed');
          const { status, body } = upstreamErrorBody(reply.request.id, error);
          void reply.status(status).header('retry-after', '5').send(body);
        },
      },
    };
    await app.register(proxy, options);
  }
}
