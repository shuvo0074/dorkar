import { appendAudit, appendToOutbox, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction as Trx } from 'kysely';
import type {
  ListQuery,
  PaymentUpdate,
  TransactionStore,
  TransactionUnitOfWork,
} from '../application/ports';
import type {
  Delivery,
  ListingSnapshot,
  Payment,
  Transaction,
  Transition,
} from '../domain/transaction';
import type { TransactionDB } from './db-schema';

type Executor = Kysely<TransactionDB> | Trx<TransactionDB>;
type TxRow = Selectable<TransactionDB['transactions']>;

const toTransaction = (r: TxRow): Transaction => ({
  id: r.id,
  sourceType: r.source_type,
  sourceId: r.source_id,
  listingId: r.listing_id,
  needId: r.need_id,
  buyerId: r.buyer_id,
  sellerId: r.seller_id,
  mode: r.mode,
  amount: Number(r.amount),
  currency: r.currency,
  quantity: r.quantity,
  terms: r.terms_snapshot,
  state: r.state,
  buyerConfirmedAt: r.buyer_confirmed_at,
  sellerConfirmedAt: r.seller_confirmed_at,
  deliveredAt: r.delivered_at,
  completedAt: r.completed_at,
  cancelReason: r.cancel_reason,
  disputeReason: r.dispute_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toPayment = (r: Selectable<TransactionDB['payments']>): Payment => ({
  id: r.id,
  transactionId: r.transaction_id,
  provider: r.provider,
  status: r.status,
  amount: Number(r.amount),
  currency: r.currency,
  providerRef: r.provider_ref,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toDelivery = (r: Selectable<TransactionDB['deliveries']>): Delivery => ({
  id: r.id,
  transactionId: r.transaction_id,
  method: r.method,
  status: r.status,
  notes: r.notes,
  scheduledFor: r.scheduled_for,
  provider: r.provider,
  providerRef: r.provider_ref,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const paymentSet = (u: PaymentUpdate) => ({
  status: u.status,
  ...(u.providerRef !== undefined ? { provider_ref: u.providerRef } : {}),
  ...(u.note !== undefined ? { note: u.note } : {}),
});

export function pgTransactionStore(db: Executor): TransactionStore {
  const page = (q: ListQuery) => {
    let query = db.selectFrom('transactions').selectAll();
    if (q.state) query = query.where('state', '=', q.state);
    if (q.cursor) {
      const { k, id } = q.cursor;
      query = query.where(
        sql<boolean>`(created_at, id) < (${new Date(k)}::timestamptz, ${id}::uuid)`,
      );
    }
    return query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1);
  };

  const dueIds = async (
    state: 'CREATED' | 'DELIVERED',
    column: 'created_at' | 'delivered_at',
    afterMs: number,
    limit: number,
  ) => {
    const rows = await db
      .selectFrom('transactions')
      .select('id')
      .where('state', '=', state)
      .where(column, '<=', sql<Date>`now() - ${afterMs} * interval '1 millisecond'`)
      .orderBy(column)
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    return rows.map((r) => r.id);
  };

  return {
    async load(id) {
      const r = await db
        .selectFrom('transactions')
        .selectAll()
        .select(sql<Date>`now()`.as('db_now'))
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? { tx: toTransaction(r), now: r.db_now } : null;
    },

    async insert(t) {
      const r = await db
        .insertInto('transactions')
        .values({
          id: t.id,
          source_type: t.sourceType,
          source_id: t.sourceId,
          listing_id: t.listingId,
          need_id: t.needId,
          buyer_id: t.buyerId,
          seller_id: t.sellerId,
          mode: t.mode,
          amount: t.amount,
          currency: t.currency,
          quantity: t.quantity,
          terms_snapshot: JSON.stringify(t.terms),
        })
        // Exactly one transaction per accepted offer, even under concurrent redelivery.
        .onConflict((oc) =>
          oc.columns(['source_type', 'source_id']).where('source_type', '=', 'OFFER').doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      return r ? toTransaction(r) : null;
    },

    async transition(id, guard, to, p) {
      const now = sql<Date>`now()`;
      const r = await db
        .updateTable('transactions')
        .set((eb) => ({
          state: to,
          ...(p.buyerConfirmedAt ? { buyer_confirmed_at: now } : {}),
          ...(p.sellerConfirmedAt ? { seller_confirmed_at: now } : {}),
          ...(p.deliveredAt ? { delivered_at: now } : {}),
          ...(p.completedAt ? { completed_at: now } : {}),
          ...(p.cancelReason !== undefined ? { cancel_reason: p.cancelReason } : {}),
          ...(p.disputeReason !== undefined ? { dispute_reason: p.disputeReason } : {}),
          updated_at: now,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('state', '=', guard.from)
        .where('version', '=', guard.version)
        .returningAll()
        .executeTakeFirst();
      return r ? toTransaction(r) : null;
    },

    async appendTransition(t) {
      await db
        .insertInto('transaction_transitions')
        .values({
          id: uuidv7(),
          transaction_id: t.transactionId,
          from_state: t.from,
          to_state: t.to,
          command: t.command,
          actor_id: t.actorId,
          actor_role: t.actorRole,
          reason: t.reason,
        })
        .execute();
    },

    async transitions(transactionId) {
      const rows = await db
        .selectFrom('transaction_transitions')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map((r): Transition => ({
        id: r.id,
        transactionId: r.transaction_id,
        from: r.from_state,
        to: r.to_state,
        command: r.command,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        reason: r.reason,
        at: r.at,
      }));
    },

    async payment(transactionId) {
      const r = await db
        .selectFrom('payments')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .executeTakeFirst();
      return r ? toPayment(r) : null;
    },

    async insertPayment(tx, provider, u) {
      const r = await db
        .insertInto('payments')
        .values({
          id: uuidv7(),
          transaction_id: tx.id,
          provider,
          amount: tx.amount,
          currency: tx.currency,
          provider_ref: null,
          note: null,
          ...paymentSet(u),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toPayment(r);
    },

    async updatePayment(paymentId, u) {
      await db
        .updateTable('payments')
        .set({ ...paymentSet(u), updated_at: sql<Date>`now()` })
        .where('id', '=', paymentId)
        .execute();
    },

    async delivery(transactionId) {
      const r = await db
        .selectFrom('deliveries')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .executeTakeFirst();
      return r ? toDelivery(r) : null;
    },

    async insertDelivery(tx, provider, input, u) {
      const r = await db
        .insertInto('deliveries')
        .values({
          id: uuidv7(),
          transaction_id: tx.id,
          method: input.method,
          status: u.status,
          notes: input.notes,
          scheduled_for: input.scheduledFor,
          provider,
          provider_ref: u.providerRef ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDelivery(r);
    },

    async updateDelivery(deliveryId, u) {
      await db
        .updateTable('deliveries')
        .set({
          status: u.status,
          ...(u.providerRef !== undefined ? { provider_ref: u.providerRef } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', deliveryId)
        .execute();
    },

    async listForParty(accountId, role, q) {
      let query = page(q);
      if (role === 'buyer') query = query.where('buyer_id', '=', accountId);
      else if (role === 'seller') query = query.where('seller_id', '=', accountId);
      else
        query = query.where((eb) =>
          eb.or([eb('buyer_id', '=', accountId), eb('seller_id', '=', accountId)]),
        );
      return (await query.execute()).map(toTransaction);
    },

    async listAll(q) {
      return (await page(q).execute()).map(toTransaction);
    },

    dueForExpiry: (ttlMs, limit) => dueIds('CREATED', 'created_at', ttlMs, limit),
    dueForAutoComplete: (windowMs, limit) => dueIds('DELIVERED', 'delivered_at', windowMs, limit),

    async listing(listingId) {
      const r = await db
        .selectFrom('listing_projection')
        .selectAll()
        .where('listing_id', '=', listingId)
        .executeTakeFirst();
      return r
        ? {
            listingId: r.listing_id,
            sellerId: r.seller_id,
            kind: r.kind,
            title: r.title,
            price: Number(r.price_amount),
            currency: r.currency,
            priceUnit: r.price_unit,
            quantityAvailable: r.quantity_available,
            deliveryModes: r.delivery_modes,
            available: r.available,
          }
        : null;
    },

    async reserveListing(listingId, quantity) {
      const r = await db
        .updateTable('listing_projection')
        .set((eb) => ({
          quantity_available: eb('quantity_available', '-', quantity),
          updated_at: sql<Date>`now()`,
        }))
        .where('listing_id', '=', listingId)
        .where('available', '=', true)
        .where('quantity_available', '>=', quantity)
        .executeTakeFirst();
      return r.numUpdatedRows === 1n;
    },

    async upsertListing(l: Omit<ListingSnapshot, 'available'>, publish) {
      const row = {
        seller_id: l.sellerId,
        kind: l.kind,
        title: l.title,
        price_amount: l.price,
        currency: l.currency,
        price_unit: l.priceUnit,
        quantity_available: l.quantityAvailable,
        delivery_modes: l.deliveryModes,
      };
      await db
        .insertInto('listing_projection')
        .values({ listing_id: l.listingId, ...row, available: true })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet({
            ...row,
            // An update to a paused/withdrawn listing does not make it purchasable again.
            ...(publish ? { available: true } : {}),
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },

    async markListingUnavailable(listingId) {
      await db
        .updateTable('listing_projection')
        .set({ available: false, updated_at: sql<Date>`now()` })
        .where('listing_id', '=', listingId)
        .execute();
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgTransactionUnitOfWork(db: Kysely<TransactionDB>): TransactionUnitOfWork {
  return {
    store: pgTransactionStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgTransactionStore(trx))),
  };
}
