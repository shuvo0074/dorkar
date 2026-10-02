import { randomUUID } from 'node:crypto';
import { createDatabase, migrateDown, migrateUp } from '@dorkar/kernel';
import {
  dropSchema,
  ensureTestDatabase,
  TEST_DATABASE_URL,
  uniqueSchema,
} from '@dorkar/kernel/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';

/** 0002 on a database that already holds MVP data. */
const schema = uniqueSchema('txnmig');
let db: Kysely<unknown>;
let close: () => Promise<void>;
const before0002 = migrations.filter((m) => m.name < '0002');

const q = (text: string) => sql.raw(text.replaceAll('$S', `"${schema}"`));

beforeAll(async () => {
  await ensureTestDatabase();
  const database = createDatabase({
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    DATABASE_POOL_MAX: 2,
    DATABASE_SSL: 'disable',
    DATABASE_SSL_CA: undefined,
    DATABASE_STATEMENT_TIMEOUT_MS: 10_000,
    SERVICE_NAME: 'transaction-migration-test',
  });
  db = database.root;
  close = () => database.close();
  await migrateUp({ db, schema, migrations: before0002 });
});

afterAll(async () => {
  await dropSchema(db, schema);
  await close();
});

describe('0002_phase2_sources_returns_disputes', () => {
  const disputedId = randomUUID();
  const offerId = randomUUID();
  const listingId = randomUUID();

  const insertTx = (id: string, sourceType: string, sourceId: string, state = 'CREATED') =>
    q(`insert into $S.transactions (id, source_type, source_id, buyer_id, seller_id, mode, amount, quantity, state)
       values ('${id}', '${sourceType}', '${sourceId}', '${randomUUID()}', '${randomUUID()}', 'BUY', 1000, 1, '${state}')`).execute(
      db,
    );

  it('keeps MVP rows and recovers the state to restore for open disputes', async () => {
    await insertTx(disputedId, 'OFFER', offerId, 'DISPUTED');
    await insertTx(randomUUID(), 'LISTING', listingId);
    await insertTx(randomUUID(), 'LISTING', listingId);
    for (const [from, to] of [
      ['CREATED', 'CONFIRMED'],
      ['CONFIRMED', 'DELIVERY_PENDING'],
      ['DELIVERY_PENDING', 'DELIVERED'],
      ['DELIVERED', 'DISPUTED'],
    ])
      await q(`insert into $S.transaction_transitions (id, transaction_id, from_state, to_state, command, actor_role)
               values ('${randomUUID()}', '${disputedId}', '${from}', '${to}', 'x', 'BUYER')`).execute(
        db,
      );

    expect(await migrateUp({ db, schema, migrations })).toEqual([
      '0002_phase2_sources_returns_disputes',
    ]);

    const rows = await q(
      `select source_type, state, pre_dispute_state, dispute_category from $S.transactions order by source_type`,
    ).execute(db);
    expect(rows.rows).toEqual([
      { source_type: 'LISTING', state: 'CREATED', pre_dispute_state: null, dispute_category: null },
      { source_type: 'LISTING', state: 'CREATED', pre_dispute_state: null, dispute_category: null },
      {
        source_type: 'OFFER',
        state: 'DISPUTED',
        pre_dispute_state: 'DELIVERED',
        dispute_category: 'OTHER',
      },
    ]);
  });

  it('makes every source but LISTING unique and accepts the new states', async () => {
    await expect(insertTx(randomUUID(), 'OFFER', offerId)).rejects.toThrow(/unique/);
    const auctionId = randomUUID();
    await insertTx(randomUUID(), 'AUCTION', auctionId, 'CONFIRMED');
    await expect(insertTx(randomUUID(), 'AUCTION', auctionId)).rejects.toThrow(/unique/);
    await insertTx(randomUUID(), 'BOOKING', randomUUID(), 'HANDED_OVER');
    await insertTx(randomUUID(), 'LOAN', randomUUID(), 'RETURNED');
    await insertTx(randomUUID(), 'LISTING', listingId);
    await expect(insertTx(randomUUID(), 'SWAP', randomUUID())).rejects.toThrow(/check/);
  });

  it('rolls back and forward again once Phase 2 rows are gone', async () => {
    await q(
      `delete from $S.transactions where source_type in ('AUCTION','BOOKING','LOAN')`,
    ).execute(db);
    expect(await migrateDown({ db, schema, migrations })).toEqual([
      '0002_phase2_sources_returns_disputes',
    ]);
    expect(await migrateUp({ db, schema, migrations })).toEqual([
      '0002_phase2_sources_returns_disputes',
    ]);
  });
});
