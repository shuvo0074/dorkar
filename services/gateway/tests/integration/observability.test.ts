import { parseTraceparent } from '@dorkar/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createGateway, startUpstream, type Harness, type Upstream } from './harness';

const TOKEN = 'gateway-metrics-token-0123456789abcdef';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let up: Upstream;
let h: Harness;
let plain: Harness;

beforeAll(async () => {
  up = await startUpstream();
  [h, plain] = await Promise.all([
    createGateway(up.url, { METRICS_TOKEN: TOKEN }),
    createGateway(up.url),
  ]);
});
afterAll(async () => {
  await Promise.all([h.close(), plain.close()]);
  await up.app.close();
});

const lastCall = () => up.calls[up.calls.length - 1]!;

describe('gateway /metrics', () => {
  it('does not exist without METRICS_TOKEN and is never proxied', async () => {
    const before = up.calls.length;
    const res = await plain.gw.app.inject({ url: '/metrics', headers: bearer(TOKEN) });
    expect(res.statusCode).toBe(404);
    expect(up.calls.length).toBe(before);
  });

  it('requires the metrics token (not an access token) and never reaches an upstream', async () => {
    const before = up.calls.length;
    for (const headers of [{}, bearer('wrong'), bearer(`${TOKEN}x`), bearer(await up.sign())]) {
      const res = await h.gw.app.inject({ url: '/metrics', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
    expect(up.calls.length).toBe(before);
  });

  it('serves gateway metrics with the right token', async () => {
    await h.gw.app.inject({ url: '/api/v1/me/account' });
    const res = await h.gw.app.inject({ url: '/metrics', headers: bearer(TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('process_cpu_user_seconds_total');
    expect(res.body).toContain(
      'http_request_duration_seconds_count{service="gateway",method="GET",route="/api/v1/me/account",status_code="200"}',
    );
    expect(res.body).not.toContain('route="/metrics"');
  });
});

describe('trace propagation', () => {
  it('forwards the client trace with the edge as parent span', async () => {
    await h.gw.app.inject({ url: '/api/v1/me/account', headers: { traceparent: TRACE } });
    const forwarded = parseTraceparent(lastCall().headers['traceparent']);
    expect(forwarded?.traceId).toBe(TRACE_ID);
    expect(forwarded?.spanId).not.toBe('00f067aa0ba902b7');
    expect(h.logLines.some((l) => l.includes(`"traceId":"${TRACE_ID}"`))).toBe(true);
  });

  it('starts a trace when the client sent none or an invalid one', async () => {
    await h.gw.app.inject({ url: '/api/v1/me/account' });
    const generated = parseTraceparent(lastCall().headers['traceparent']);
    expect(generated).not.toBeNull();

    await h.gw.app.inject({ url: '/api/v1/me/account', headers: { traceparent: 'bogus' } });
    const replaced = parseTraceparent(lastCall().headers['traceparent']);
    expect(replaced).not.toBeNull();
    expect(replaced!.traceId).not.toBe(generated!.traceId);
  });
});
