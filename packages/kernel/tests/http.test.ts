import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/errors';
import { createHttpServer, ok, type App } from '../src/http/server';
import { captureLogger } from '../src/testing';

let app: App;
let ready = true;

beforeAll(async () => {
  app = await createHttpServer({
    config: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'test',
      SERVICE_VERSION: 't',
      TRUST_PROXY: false,
      CORS_ORIGINS: ['https://app.example'],
    },
    logger: captureLogger('silent').logger,
    ipHashKey: 'k'.repeat(32),
    readiness: [
      {
        name: 'db',
        check: async () => {
          if (!ready) throw new Error('down');
        },
      },
    ],
  });
  app.post(
    '/echo',
    {
      schema: {
        body: z.strictObject({ name: z.string().min(2) }),
        response: { 200: z.object({ data: z.object({ name: z.string() }) }) },
      },
    },
    async (req) => ok({ name: req.body.name, secret: 'must-not-leak' }),
  );
  app.get('/boom', async () => {
    throw new Error('db password is hunter2');
  });
  app.get('/domain', async () => {
    throw new AppError('CONFLICT', 'Already accepted.', { offerId: 'x' });
  });
  await app.ready();
});
afterAll(() => app.close());

describe('http server conventions', () => {
  it('echoes a valid incoming request id and sets correlation id', async () => {
    const res = await app.inject({
      url: '/health/live',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(res.headers['x-request-id']).toBe('req-12345678');
    expect(res.headers['x-correlation-id']).toBe('req-12345678');
  });

  it('replaces an unsafe request id', async () => {
    const res = await app.inject({ url: '/health/live', headers: { 'x-request-id': 'bad id\n' } });
    expect(res.headers['x-request-id']).not.toBe('bad id\n');
  });

  it('returns VALIDATION_FAILED and rejects unknown fields (mass assignment)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 'ab', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('strips fields not in the response schema', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { name: 'ab' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { name: 'ab' } });
  });

  it('maps AppError to the envelope', async () => {
    const res = await app.inject({ url: '/domain' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CONFLICT', details: { offerId: 'x' } });
  });

  it('hides internals of unexpected errors', async () => {
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().error.code).toBe('INTERNAL');
  });

  it('returns NOT_FOUND envelope for unknown routes', async () => {
    const res = await app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('maps malformed JSON to BAD_REQUEST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('readiness reflects dependency checks', async () => {
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    ready = false;
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toBe('fail');
    ready = true;
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://app.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');
    const denied = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
