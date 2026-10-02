import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Metrics } from './metrics';

/**
 * W3C Trace Context (`traceparent: 00-<trace-id>-<parent-id>-<flags>`), without an SDK.
 *
 * The gateway starts a trace when the client sent none; every hop keeps the trace id and
 * replaces the parent id with its own span id. The value travels on HTTP (`traceparent`
 * header, incl. the internal client) and on event envelopes (`traceparent` field, stored in
 * the outbox), so one trace id follows a request across services and the event bus.
 * An OpenTelemetry SDK can later adopt these ids unchanged (docs/architecture/07-operations.md).
 */
export const TRACEPARENT_HEADER = 'traceparent';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: string;
}

/** Parses a `traceparent` value; null when absent or invalid (all-zero ids, version ff). */
export function parseTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return null;
  const [, version = '', traceId = '', spanId = '', flags = ''] = m;
  // Lowercase only (the spec forbids uppercase); version ff is invalid; all-zero ids are invalid.
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, flags };
}

export const formatTraceparent = (t: TraceContext): string =>
  `00-${t.traceId}-${t.spanId}-${t.flags}`;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * A new span in the trace of `parent` (a `traceparent` value), or the root span of a new trace
 * when the parent is missing or invalid. New traces are sampled.
 */
export function childTraceparent(parent?: unknown): string {
  const ctx = parseTraceparent(parent);
  return formatTraceparent({
    traceId: ctx?.traceId ?? hex(16),
    spanId: hex(8),
    flags: ctx?.flags ?? '01',
  });
}

export const traceIdOf = (traceparent: string | undefined): string | undefined =>
  parseTraceparent(traceparent)?.traceId;

// ---------------------------------------------------------------------------------------------
// Ambient execution scope: set by the kernel around HTTP handlers and event handlers, so code
// that does not receive a context explicitly (events built from a reduced ctx, internal calls,
// withIdempotency) still propagates the trace and reaches the process metrics.

export interface ExecutionScope {
  traceparent: string;
  metrics?: Metrics;
}

const storage = new AsyncLocalStorage<ExecutionScope>();

export const runInScope = <T>(scope: ExecutionScope, fn: () => T): T => storage.run(scope, fn);
export const currentScope = (): ExecutionScope | undefined => storage.getStore();
export const currentTraceparent = (): string | undefined => storage.getStore()?.traceparent;
