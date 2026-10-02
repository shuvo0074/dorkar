import { randomUUID } from 'node:crypto';
import { CatalogEvents, type NeedMode, type Role } from '@dorkar/contracts';
import { Errors } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { migrations } from '../../migrations';
import type { VerificationGateway } from '../../src/application/ports';
import { buildLendingService } from '../../src/app';

export type Lending = TestService<Awaited<ReturnType<typeof buildLendingService>>>;

/** Controllable verification policy engine. */
export const verification = {
  mode: 'ok' as 'ok' | 'deny' | 'down',
  calls: [] as Array<{ accountId: string; action: string; amount: number }>,
};
const gateway: VerificationGateway = {
  async evaluate(q) {
    verification.calls.push({ accountId: q.accountId, action: q.action, amount: q.amount });
    if (verification.mode === 'down') throw Errors.unavailable('Verification is down.');
    return verification.mode === 'ok'
      ? { satisfied: true, missing: [] }
      : { satisfied: false, missing: ['NID'] };
  },
};

export async function startLending(prefix: string): Promise<Lending> {
  return startTestService({
    schemaPrefix: prefix,
    migrations,
    env: { LOAN_MAX_DAYS: '60', LOAN_REQUEST_TTL_HOURS: '48' },
    build: (env, logger, verifier) =>
      buildLendingService(env, logger, { verifier, verification: gateway }),
  });
}

export function helpers(get: () => Lending) {
  const app = () => get().svc.runtime.app;
  const db = () => get().svc.runtime.db;

  const headers = async (actorId: string, opts: { key?: string | null; roles?: Role[] } = {}) => {
    const h: Record<string, string> = await get().auth.as(actorId, opts.roles);
    if (opts.key !== null) h['idempotency-key'] = opts.key ?? randomUUID();
    return h;
  };

  const post = async (
    url: string,
    actorId: string,
    payload?: unknown,
    opts: { key?: string | null; roles?: Role[] } = {},
  ) =>
    app().inject({
      method: 'POST',
      url,
      headers: await headers(actorId, opts),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const getAs = async (url: string, actorId?: string, roles?: Role[]) =>
    app().inject({ url, ...(actorId ? { headers: await get().auth.as(actorId, roles) } : {}) });

  const category = async (modes: NeedMode[] = ['BORROW', 'RENT'], active = true) => {
    const categoryId = randomUUID();
    await get().svc.runtime.deliver(
      envelope(CatalogEvents.CategoryUpserted, {
        categoryId,
        parentId: null,
        slug: `cat-${categoryId.slice(0, 8)}`,
        nameEn: 'Tools',
        nameBn: 'যন্ত্রপাতি',
        modes,
        attributeSchema: { properties: {}, required: [] },
        active,
      }),
    );
    return categoryId;
  };

  const itemBody = (categoryId: string, over: Record<string, unknown> = {}) => ({
    categoryId,
    title: 'Bosch cordless drill',
    description: 'Two batteries and a charger. Please bring it back clean.',
    condition: 'USED',
    district: 'dhaka',
    mediaIds: [],
    deposit: { amount: 50_000, currency: 'BDT' },
    maxLoanDays: 14,
    ...over,
  });

  /** A lender with an active item in a lendable category. */
  const item = async (over: Record<string, unknown> = {}, lender = randomUUID()) => {
    const categoryId = (over['categoryId'] as string | undefined) ?? (await category());
    const res = await post('/api/v1/lend-items', lender, itemBody(categoryId, over));
    if (res.statusCode !== 201) throw new Error(`item: ${res.statusCode} ${res.body}`);
    return { id: res.json().data.id as string, lender, categoryId };
  };

  const DAY = 86_400_000;
  const window = (startInDays = 1, days = 3) => {
    const start = new Date(Date.now() + startInDays * DAY);
    return {
      startAt: start.toISOString(),
      returnBy: new Date(start.getTime() + days * DAY).toISOString(),
    };
  };

  const request = (itemId: string, borrower: string, w = window(), extra = {}) =>
    post('/api/v1/loans', borrower, { itemId, ...w, ...extra });

  const outbox = (aggregateId: string, type?: string) => {
    let q = db()
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('aggregate_id', '=', aggregateId);
    if (type) q = q.where('type', '=', type);
    return q.orderBy('occurred_at').orderBy('id').execute();
  };

  return { app, db, headers, post, getAs, category, itemBody, item, window, request, outbox, DAY };
}
