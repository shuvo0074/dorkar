import { IdentityEvents } from '@dorkar/contracts';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor, paginate } from '../src/cursor';
import type { KernelTables } from '../src/db/database';
import { kernelMigration } from '../src/db/kernel-migration';
import type { Migration } from '../src/db/migrator';
import { AppError } from '../src/errors';
import { INTERNAL_TOKEN_HEADER } from '../src/http/internal';
import { ok } from '../src/http/server';
import {
  kernelIdempotencyMigration,
  withIdempotency,
  requestFingerprint,
  type IdempotencyTables,
} from '../src/idempotency';
import { createServiceRuntime, serviceEnvSchema, type ServiceRuntime } from '../src/service';
import { loadConfig } from '../src/config';
import { envelope, startTestService, TEST_INTERNAL_TOKEN, type TestService } from '../src/testing';

interface DB extends KernelTables, IdempotencyTables {
  seen: { account_id: string };
}

const seenMigration: Migration = {
  name: '0001_seen',
  up: async (trx) => void (await sql`create table seen (account_id uuid primary key)`.execute(trx)),
  down: async (trx) => void (await sql`drop table seen`.execute(trx)),
};

let t: TestService<{ runtime: ServiceRuntime<DB> }>;
let runs = 0;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'kernelrt',
    migrations: [kernelMigration, kernelIdempotencyMigration, seenMigration],
    build: async (env, logger, verifier) => {
      const runtime = await createServiceRuntime<DB>({
        config: loadConfig(serviceEnvSchema, env),
        logger,
        producer: 'kernelrt',
        openapi: { title: 'test' },
        verifier,
        idempotency: true,
      });
      runtime.on(IdentityEvents.AccountCreated, async (p, _e, trx) => {
        runs++;
        await trx.insertInto('seen').values({ account_id: p.accountId }).execute();
      });
      runtime.app.get('/me', { preHandler: runtime.auth.authenticate }, async (req) =>
        ok({ id: req.ctx.actor!.id }),
      );
      runtime.app.get('/internal/v1/ping', { preHandler: runtime.internalOnly }, async () =>
        ok('pong'),
      );
      runtime.app.post(
        '/charge',
        {
          preHandler: runtime.auth.authenticate,
          schema: { body: z.object({ amount: z.number() }) },
        },
        async (req, reply) => {
          const r = await withIdempotency(
            runtime.db as unknown as Kysely<IdempotencyTables>,
            {
              actorId: req.ctx.actor!.id,
              scope: 'charge',
              key: req.headers['idempotency-key'] as string | undefined,
              fingerprint: requestFingerprint(req.body),
              required: true,
            },
            async () => {
              if (req.body.amount < 0) throw new AppError('BUSINESS_RULE_VIOLATION', 'negative');
              runs++;
              await new Promise((r) => setTimeout(r, 50));
              return { status: 201, body: { charged: req.body.amount, n: runs } };
            },
          );
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(ok(r.body));
        },
      );
      return { runtime };
    },
  });
});
afterAll(() => t.close());

describe('service runtime', () => {
  it('authenticates bearer tokens with the injected verifier', async () => {
    const res = await t.svc.runtime.app.inject({
      url: '/me',
      headers: await t.auth.as('0192f0c4-0000-7000-8000-000000000001'),
    });
    expect(res.json()).toEqual({ data: { id: '0192f0c4-0000-7000-8000-000000000001' } });
    expect((await t.svc.runtime.app.inject({ url: '/me' })).statusCode).toBe(401);
  });

  it('guards internal routes with the shared token', async () => {
    const app = t.svc.runtime.app;
    expect((await app.inject({ url: '/internal/v1/ping' })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/internal/v1/ping', headers: { [INTERNAL_TOKEN_HEADER]: 'nope' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/internal/v1/ping',
          headers: { [INTERNAL_TOKEN_HEADER]: TEST_INTERNAL_TOKEN },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('applies each event exactly once and validates payloads', async () => {
    const before = runs;
    const e = envelope(IdentityEvents.AccountCreated, {
      accountId: '0192f0c4-0000-7000-8000-0000000000aa',
    });
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    expect(runs).toBe(before + 1);
    const bad = {
      ...e,
      id: '0192f0c4-0000-7000-8000-0000000000ab',
      payload: { accountId: 'nope' },
    };
    await expect(t.svc.runtime.deliver(bad)).rejects.toThrow();
    // the failed attempt left no inbox row, so a corrected redelivery still runs
    const rows = await t.svc.runtime.db
      .selectFrom('inbox')
      .select('event_id')
      .where('event_id', '=', bad.id)
      .execute();
    expect(rows).toHaveLength(0);
  });
});

describe('idempotency keys', () => {
  const user = '0192f0c4-0000-7000-8000-0000000000bb';
  const charge = async (key: string | undefined, amount: number) =>
    t.svc.runtime.app.inject({
      method: 'POST',
      url: '/charge',
      headers: { ...(await t.auth.as(user)), ...(key ? { 'idempotency-key': key } : {}) },
      payload: { amount },
    });

  it('requires a key when configured', async () => {
    expect((await charge(undefined, 1)).statusCode).toBe(400);
  });

  it('replays the stored response for a retry and refuses a different body', async () => {
    const first = await charge('key-aaaaaaaa', 100);
    const again = await charge('key-aaaaaaaa', 100);
    expect(first.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.headers['idempotent-replayed']).toBe('true');
    const other = await charge('key-aaaaaaaa', 999);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('runs once under concurrent duplicates', async () => {
    const before = runs;
    const results = await Promise.all(Array.from({ length: 5 }, () => charge('key-bbbbbbbb', 7)));
    expect(runs).toBe(before + 1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(
      results.every(
        (r) => r.statusCode === 201 || r.json().error.code === 'IDEMPOTENCY_IN_PROGRESS',
      ),
    ).toBe(true);
  });

  it('replays business errors as the same error', async () => {
    const a = await charge('key-cccccccc', -1);
    const b = await charge('key-cccccccc', -1);
    expect(a.statusCode).toBe(422);
    expect(b.statusCode).toBe(422);
    expect(b.json().error.code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const c = { k: '2026-10-01T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('not-a-cursor')).toThrow();
  });

  it('paginates with limit + 1', () => {
    const rows = [1, 2, 3].map((n) => ({ n, id: String(n) }));
    const p = paginate(rows, 2, (r) => ({ k: r.n, id: r.id }));
    expect(p.items).toHaveLength(2);
    expect(decodeCursor(p.nextCursor!)).toEqual({ k: 2, id: '2' });
    expect(paginate(rows, 3, (r) => ({ k: r.n, id: r.id })).nextCursor).toBeNull();
  });
});
