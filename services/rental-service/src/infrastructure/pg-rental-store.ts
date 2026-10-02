import { AppError, appendAudit, appendToOutbox, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction as Trx } from 'kysely';
import type {
  ListQuery,
  RentalStore,
  RentalUnitOfWork,
  Transition,
  TransitionPatch,
} from '../application/ports';
import type { Booking, RentalListing, RentalTerms } from '../domain/booking';
import type { RentalDB } from './db-schema';

type Executor = Kysely<RentalDB> | Trx<RentalDB>;
type BookingRow = Selectable<RentalDB['bookings']>;

const toBooking = (r: BookingRow): Booking => ({
  id: r.id,
  listingId: r.listing_id,
  ownerId: r.owner_id,
  renterId: r.renter_id,
  startAt: r.start_at,
  endAt: r.end_at,
  status: r.status,
  holdExpiresAt: r.hold_expires_at,
  amount: Number(r.amount),
  currency: r.currency,
  deposit: r.deposit_amount === null ? null : Number(r.deposit_amount),
  terms: r.terms_snapshot,
  note: r.note,
  declineReason: r.decline_reason,
  cancelReason: r.cancel_reason,
  transactionId: r.transaction_id,
  transactionState: r.transaction_state,
  disputed: r.disputed,
  overdueNotifiedAt: r.overdue_notified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toListing = (r: Selectable<RentalDB['listing_projection']>): RentalListing => ({
  listingId: r.listing_id,
  sellerId: r.seller_id,
  categoryId: r.category_id,
  title: r.title,
  district: r.district,
  price: Number(r.price_amount),
  currency: r.currency,
  priceUnit: r.price_unit,
  available: r.available,
});

const toTerms = (r: Selectable<RentalDB['rental_terms']>): RentalTerms => ({
  listingId: r.listing_id,
  instantBook: r.instant_book,
  minDurationHours: r.min_duration_hours,
  maxDurationDays: r.max_duration_days,
  deposit: r.deposit_amount === null ? null : { amount: Number(r.deposit_amount), currency: 'BDT' },
  advanceNoticeHours: r.advance_notice_hours,
  bufferHours: r.buffer_hours,
  cancellationNote: r.cancellation_note,
  updatedAt: r.updated_at,
});

/** Postgres error codes that mean "the period overlaps an active slot". */
const OVERLAP_CODES = new Set([
  '23P01', // exclusion_violation
  '40P01', // deadlock_detected: two inserters waiting on each other's conflicting slot
]);

const range = (from: Date, to: Date) => sql<string>`tstzrange(${from}, ${to}, '[)')`;

const patchSet = (p: TransitionPatch) => ({
  ...(p.clearHold ? { hold_expires_at: null } : {}),
  ...(p.declineReason !== undefined ? { decline_reason: p.declineReason } : {}),
  ...(p.cancelReason !== undefined ? { cancel_reason: p.cancelReason } : {}),
  ...(p.transactionId !== undefined ? { transaction_id: p.transactionId } : {}),
  ...(p.transactionState !== undefined ? { transaction_state: p.transactionState } : {}),
  ...(p.disputed !== undefined ? { disputed: p.disputed } : {}),
});

export function pgRentalStore(db: Executor): RentalStore {
  const page = (q: ListQuery) => {
    let query = db.selectFrom('bookings').selectAll();
    if (q.status) query = query.where('status', '=', q.status);
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

  const listing = async (listingId: string, lock: boolean) => {
    let q = db.selectFrom('listing_projection').selectAll().where('listing_id', '=', listingId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? toListing(r) : null;
  };

  return {
    async now() {
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
      return rows[0]!.now;
    },

    // ---- listings and terms

    listing: (id) => listing(id, false),
    lockListing: (id) => listing(id, true),

    async upsertListing(l, publish) {
      const row = {
        seller_id: l.sellerId,
        category_id: l.categoryId,
        title: l.title,
        district: l.district,
        price_amount: l.price,
        currency: l.currency,
        price_unit: l.priceUnit,
      };
      await db
        .insertInto('listing_projection')
        .values({ listing_id: l.listingId, ...row, available: true })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet({
            ...row,
            // An update to a paused/withdrawn listing does not make it bookable again.
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

    async terms(listingId) {
      const r = await db
        .selectFrom('rental_terms')
        .selectAll()
        .where('listing_id', '=', listingId)
        .executeTakeFirst();
      return r ? toTerms(r) : null;
    },

    async putTerms(listingId, t) {
      const row = {
        instant_book: t.instantBook,
        min_duration_hours: t.minDurationHours,
        max_duration_days: t.maxDurationDays,
        deposit_amount: t.deposit?.amount ?? null,
        deposit_currency: t.deposit ? t.deposit.currency : null,
        advance_notice_hours: t.advanceNoticeHours,
        buffer_hours: t.bufferHours,
        cancellation_note: t.cancellationNote,
      };
      const r = await db
        .insertInto('rental_terms')
        .values({ listing_id: listingId, ...row })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet((eb) => ({
            ...row,
            updated_at: sql<Date>`now()`,
            version: eb('rental_terms.version', '+', 1),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTerms(r);
    },

    // ---- calendar

    async insertSlot(s) {
      try {
        await db
          .insertInto('calendar_slots')
          .values({
            id: s.id,
            listing_id: s.listingId,
            period: range(s.startAt, s.endAt),
            kind: s.kind,
            ref_id: s.refId,
            reason: s.reason,
            created_by: s.createdBy,
          })
          .execute();
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && OVERLAP_CODES.has(code)) {
          throw new AppError(
            'CONFLICT',
            s.kind === 'BOOKING'
              ? 'Those dates are no longer available. Pick another period.'
              : 'That period overlaps a booking or another block.',
            { rule: 'BOOKING_CONFLICT' },
          );
        }
        throw err;
      }
    },

    async releaseBookingSlot(bookingId) {
      await db
        .updateTable('calendar_slots')
        .set({ active: false, updated_at: sql<Date>`now()` })
        .where('kind', '=', 'BOOKING')
        .where('ref_id', '=', bookingId)
        .where('active', '=', true)
        .execute();
    },

    async busy(listingId, from, to) {
      const rows = await db
        .selectFrom('calendar_slots')
        .select([sql<Date>`lower(period)`.as('start_at'), sql<Date>`upper(period)`.as('end_at')])
        .where('listing_id', '=', listingId)
        .where('active', '=', true)
        .where(sql<boolean>`period && ${range(from, to)}`)
        .orderBy(sql`lower(period)`)
        .execute();
      return rows.map((r) => ({ startAt: r.start_at, endAt: r.end_at }));
    },

    async blocks(listingId, from, to) {
      const rows = await db
        .selectFrom('calendar_slots')
        .select([
          'id',
          'listing_id',
          'reason',
          'created_at',
          sql<Date>`lower(period)`.as('start_at'),
          sql<Date>`upper(period)`.as('end_at'),
        ])
        .where('listing_id', '=', listingId)
        .where('kind', '=', 'BLOCK')
        .where('active', '=', true)
        .where(sql<boolean>`period && ${range(from, to)}`)
        .orderBy(sql`lower(period)`)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        listingId: r.listing_id,
        startAt: r.start_at,
        endAt: r.end_at,
        reason: r.reason,
        createdAt: r.created_at,
      }));
    },

    async removeBlock(listingId, blockId) {
      const r = await db
        .updateTable('calendar_slots')
        .set({ active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', blockId)
        .where('listing_id', '=', listingId)
        .where('kind', '=', 'BLOCK')
        .where('active', '=', true)
        .executeTakeFirst();
      return r.numUpdatedRows === 1n;
    },

    // ---- bookings

    async insert(b) {
      const r = await db
        .insertInto('bookings')
        .values({
          id: b.id,
          listing_id: b.listingId,
          owner_id: b.ownerId,
          renter_id: b.renterId,
          start_at: b.startAt,
          end_at: b.endAt,
          status: b.status,
          hold_expires_at: b.holdExpiresAt,
          amount: b.amount,
          deposit_amount: b.deposit,
          terms_snapshot: JSON.stringify(b.terms),
          note: b.note,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toBooking(r);
    },

    async load(id, opts = {}) {
      let q = db
        .selectFrom('bookings')
        .selectAll()
        .select(sql<Date>`now()`.as('db_now'))
        .where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? { booking: toBooking(r), now: r.db_now } : null;
    },

    async transition(id, guard, to, p) {
      const r = await db
        .updateTable('bookings')
        .set((eb) => ({
          status: to,
          ...patchSet(p),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('status', '=', guard.from)
        .where('version', '=', guard.version)
        .returningAll()
        .executeTakeFirst();
      return r ? toBooking(r) : null;
    },

    async patch(id, version, p) {
      const r = await db
        .updateTable('bookings')
        .set((eb) => ({
          ...patchSet(p),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('version', '=', version)
        .returningAll()
        .executeTakeFirst();
      return r ? toBooking(r) : null;
    },

    async appendTransition(t) {
      await db
        .insertInto('booking_transitions')
        .values({
          id: uuidv7(),
          booking_id: t.bookingId,
          from_status: t.from,
          to_status: t.to,
          command: t.command,
          actor_id: t.actorId,
          actor_role: t.actorRole,
          reason: t.reason,
        })
        .execute();
    },

    async transitions(bookingId) {
      const rows = await db
        .selectFrom('booking_transitions')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map((r): Transition => ({
        id: r.id,
        bookingId: r.booking_id,
        from: r.from_status,
        to: r.to_status,
        command: r.command,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        reason: r.reason,
        at: r.at,
      }));
    },

    async listForParty(accountId, role, q) {
      let query = page(q);
      if (role === 'renter') query = query.where('renter_id', '=', accountId);
      else if (role === 'owner') query = query.where('owner_id', '=', accountId);
      else
        query = query.where((eb) =>
          eb.or([eb('renter_id', '=', accountId), eb('owner_id', '=', accountId)]),
        );
      return (await query.execute()).map(toBooking);
    },

    async listAll(q) {
      return (await page(q).execute()).map(toBooking);
    },

    // ---- jobs

    async dueForExpiry(limit, listingId) {
      let q = db
        .selectFrom('bookings')
        .select('id')
        .where('status', 'in', ['HELD', 'PENDING_APPROVAL'])
        .where('hold_expires_at', '<=', sql<Date>`now()`);
      if (listingId) q = q.where('listing_id', '=', listingId);
      const rows = await q
        .orderBy('hold_expires_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map((r) => r.id);
    },

    async dueForOverdue(graceHours, limit) {
      const rows = await db
        .selectFrom('bookings')
        .select('id')
        .where('status', '=', 'ACTIVE')
        .where('overdue_notified_at', 'is', null)
        .where(sql<boolean>`end_at + ${graceHours} * interval '1 hour' < now()`)
        // The renter says it is back; the owner just has not confirmed yet.
        .where(sql<boolean>`transaction_state is distinct from 'RETURN_REPORTED'`)
        .orderBy('end_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map((r) => r.id);
    },

    async markOverdueNotified(id) {
      const r = await db
        .updateTable('bookings')
        .set({ overdue_notified_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', 'ACTIVE')
        .where('overdue_notified_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return r ? toBooking(r) : null;
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgRentalUnitOfWork(db: Kysely<RentalDB>): RentalUnitOfWork {
  return {
    store: pgRentalStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgRentalStore(trx))),
  };
}
