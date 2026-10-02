import {
  RentalEvents,
  type BookingStatus,
  type EventEnvelope,
  type TransactionEvents,
} from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Actor,
  type AuditEntry,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertBookable,
  assertNoContactInfo,
  bookingSlot,
  defaultTerms,
  initialState,
  quote,
  SLOT_RELEASING,
  termsSnapshot,
  type Booking,
  type BookingPolicy,
} from '../domain/booking';
import {
  availableCommands,
  decide,
  mirrorCommandFor,
  type ActorRole,
  type BookingCommand,
  type TransitionFacts,
} from '../domain/booking-state-machine';
import type {
  ListQuery,
  Loaded,
  RentalStore,
  RentalUnitOfWork,
  Transition,
  TransitionPatch,
  VerificationGateway,
} from './ports';

/** Commands a party runs over HTTP. */
export const PartyCommands = [
  'confirm',
  'approve',
  'decline',
  'cancel',
] as const satisfies readonly BookingCommand[];
export type PartyCommand = (typeof PartyCommands)[number];

export interface BookingDetail {
  booking: Booking;
  transitions: Transition[];
  viewerRole: 'RENTER' | 'OWNER' | null;
  actions: PartyCommand[];
}

export interface CreateBookingInput {
  listingId: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
}

type TxStateChanged = z.output<typeof TransactionEvents.TransactionStateChanged.schema>;
type TxCreated = z.output<typeof TransactionEvents.TransactionCreated.schema>;

const requireActor = (ctx: RequestContext): Actor => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const partyRole = (b: Booking, accountId: string): 'RENTER' | 'OWNER' | null =>
  b.renterId === accountId ? 'RENTER' : b.ownerId === accountId ? 'OWNER' : null;

const actorTypeOf = (role: ActorRole): NonNullable<AuditEntry['actorType']> =>
  role === 'SYSTEM' || role === 'TRANSACTION' ? 'SYSTEM' : 'USER';

/** Context for work that is not an HTTP request (event consumers, jobs). */
export const derivedContext = (requestId: string, correlationId?: string): RequestContext => ({
  requestId,
  correlationId: correlationId ?? requestId,
  ipHash: null,
  userAgent: null,
  actor: null,
});

/** Machine-readable reason for BookingStatusChanged when no human reason was given. */
const DEFAULT_REASON: Record<BookingCommand | 'request', string> = {
  request: 'REQUESTED',
  confirm: 'RENTER_CONFIRMED',
  approve: 'OWNER_APPROVED',
  decline: 'OWNER_DECLINED',
  cancel: 'RENTER_CANCELLED',
  expire: 'NOT_ANSWERED_IN_TIME',
  'mirror-handed-over': 'TRANSACTION_HANDED_OVER',
  'mirror-returned': 'TRANSACTION_RETURNED',
  'mirror-completed': 'TRANSACTION_COMPLETED',
  'mirror-cancelled': 'TRANSACTION_CANCELLED',
};

const JOB_BATCH = 100;
const iso = (d: Date) => d.toISOString();

/**
 * Booking use cases. Every status change writes the guarded update, its history row, the slot
 * release (when it ends the booking early), an audit record and its outbox events in one
 * DB transaction.
 */
export class BookingService {
  constructor(
    private readonly uow: RentalUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
    private readonly policy: BookingPolicy,
  ) {}

  // ---------------------------------------------------------------- create

  async create(input: CreateBookingInput, ctx: RequestContext): Promise<BookingDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('note', input.note);
    const req = { renterId: actor.id, startAt: input.startAt, endAt: input.endAt };

    // Cheap checks first, so a request that cannot succeed never costs a verification call.
    const listing = await this.uow.store.listing(input.listingId);
    if (!listing) throw Errors.notFound('Listing');
    const terms =
      (await this.uow.store.terms(listing.listingId)) ?? defaultTerms(listing.listingId);
    assertBookable(listing, terms, req, await this.uow.store.now(), this.policy);
    const q = quote(listing.priceUnit, listing.price, input.startAt, input.endAt);

    const decision = await this.verification.evaluate(
      {
        accountId: actor.id,
        action: 'BOOKING_CREATE',
        categoryId: listing.categoryId,
        mode: 'RENT',
        amount: q.amount,
      },
      ctx,
    );
    if (!decision.satisfied) {
      throw new AppError('VERIFICATION_REQUIRED', 'Verify your account to book this item.', {
        action: 'BOOKING_CREATE',
        missing: decision.missing,
      });
    }

    return this.uow.transaction(async (s) => {
      // Re-check against locked, current facts: the listing or its terms may have changed.
      const locked = await s.lockListing(input.listingId);
      if (!locked) throw Errors.notFound('Listing');
      const t = (await s.terms(locked.listingId)) ?? defaultTerms(locked.listingId);
      const now = await s.now();
      assertBookable(locked, t, req, now, this.policy);
      const price = quote(locked.priceUnit, locked.price, input.startAt, input.endAt);

      // Lapsed holds on this listing free their slots now rather than at the next job tick.
      await this.runSystem(
        s,
        await s.dueForExpiry(JOB_BATCH, locked.listingId),
        'expire',
        'rental.expire-on-request',
      );

      const init = initialState(t, input.startAt, now, this.policy);
      const booking = await s.insert({
        id: uuidv7(),
        listingId: locked.listingId,
        ownerId: locked.sellerId,
        renterId: actor.id,
        startAt: input.startAt,
        endAt: input.endAt,
        status: init.status,
        holdExpiresAt: init.holdExpiresAt,
        amount: price.amount,
        deposit: t.deposit?.amount ?? null,
        terms: termsSnapshot(locked, t, price),
        note: input.note,
      });
      const slot = bookingSlot(input.startAt, input.endAt, t.bufferHours);
      await s.insertSlot({
        id: uuidv7(),
        listingId: locked.listingId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        kind: 'BOOKING',
        refId: booking.id,
        reason: null,
        createdBy: actor.id,
      });
      await s.appendTransition({
        bookingId: booking.id,
        from: init.status,
        to: init.status,
        command: 'request',
        actorId: actor.id,
        actorRole: 'RENTER',
        reason: null,
      });
      await s.audit(ctx, {
        action: 'booking.requested',
        targetType: 'booking',
        targetId: booking.id,
        metadata: { listingId: booking.listingId, status: init.status, instantBook: t.instantBook },
      });
      // Creation is announced as a status "change" into the initial status so the owner (or
      // renter, for a hold) can be notified; see the contract note in the service summary.
      await s.outbox(this.statusChanged(booking, init.status, init.status, 'REQUESTED', ctx));
      return this.compose(s, { booking, now }, actor);
    });
  }

  // ---------------------------------------------------------------- reads

  async get(id: string, ctx: RequestContext): Promise<BookingDetail> {
    const actor = requireActor(ctx);
    const loaded = await this.uow.store.load(id);
    if (!loaded) throw Errors.notFound('Booking');
    if (!partyRole(loaded.booking, actor.id) && !actor.permissions.has('transaction:read:any')) {
      throw Errors.notFound('Booking');
    }
    return this.compose(this.uow.store, loaded, actor);
  }

  listMine(
    role: 'renter' | 'owner' | undefined,
    q: ListQuery,
    ctx: RequestContext,
  ): Promise<Booking[]> {
    const actor = requireActor(ctx);
    return this.uow.store.listForParty(actor.id, role, q);
  }

  listAll(q: ListQuery): Promise<Booking[]> {
    return this.uow.store.listAll(q);
  }

  // ---------------------------------------------------------------- party commands

  async command(
    id: string,
    command: PartyCommand,
    input: { reason?: string | undefined },
    ctx: RequestContext,
  ): Promise<BookingDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('reason', input.reason);
    return this.uow.transaction(async (s) => {
      const loaded = await s.load(id, { forUpdate: true });
      const role = loaded ? partyRole(loaded.booking, actor.id) : null;
      if (!loaded || !role) throw Errors.notFound('Booking');
      const booking = await this.apply(
        s,
        loaded,
        command,
        role,
        actor.id,
        input.reason ?? null,
        ctx,
      );
      return this.compose(s, { booking: booking!, now: loaded.now }, actor);
    });
  }

  // ---------------------------------------------------------------- transaction mirror

  /** Remember which transaction carries the booking. No status change. */
  async onTransactionCreated(s: RentalStore, p: TxCreated): Promise<void> {
    if (p.sourceType !== 'BOOKING') return;
    const loaded = await s.load(p.sourceId, { forUpdate: true });
    if (!loaded || loaded.booking.transactionId) return;
    await s.patch(loaded.booking.id, loaded.booking.version, {
      transactionId: p.transactionId,
      transactionState: 'CREATED',
    });
  }

  async onTransactionStateChanged(
    s: RentalStore,
    p: TxStateChanged,
    e: EventEnvelope,
  ): Promise<void> {
    if (p.sourceType !== 'BOOKING') return;
    const loaded = await s.load(p.sourceId, { forUpdate: true });
    if (!loaded) return;
    const { booking } = loaded;
    const ctx = derivedContext(e.id, e.correlationId);
    const facts: TransitionPatch = {
      transactionId: booking.transactionId ?? p.transactionId,
      transactionState: p.to,
      disputed: p.to === 'DISPUTED',
    };

    const command = mirrorCommandFor(p.to);
    if (command) {
      try {
        const done = await this.apply(s, loaded, command, 'TRANSACTION', p.actorId, null, ctx, {
          lenient: true,
          patch: facts,
        });
        if (done) return;
      } catch (err) {
        // Already there (or a stale/out-of-order fact): keep the status, record the facts.
        if (!(err instanceof AppError)) throw err;
      }
    }

    const updated = await s.patch(booking.id, booking.version, facts);
    if (updated && updated.disputed !== booking.disputed) {
      await s.audit(ctx, {
        action: updated.disputed ? 'booking.disputed' : 'booking.dispute-ended',
        actorId: null,
        actorType: 'SYSTEM',
        targetType: 'booking',
        targetId: booking.id,
        metadata: { transactionId: facts.transactionId, transactionState: p.to },
      });
    }
  }

  // ---------------------------------------------------------------- jobs

  /** HELD / PENDING_APPROVAL past their deadline → EXPIRED (frees the calendar). */
  async expireDue(s: RentalStore): Promise<number> {
    return this.runSystem(s, await s.dueForExpiry(JOB_BATCH), 'expire', 'rental.expire-bookings');
  }

  /** ACTIVE bookings past their end (plus grace): BookingOverdue, once per booking. */
  async notifyOverdue(s: RentalStore): Promise<number> {
    const ids = await s.dueForOverdue(this.policy.overdueGraceHours, JOB_BATCH);
    let n = 0;
    for (const id of ids) {
      const b = await s.markOverdueNotified(id);
      if (!b) continue;
      const ctx = derivedContext(`rental.notify-overdue:${id}`);
      await s.audit(ctx, {
        action: 'booking.overdue',
        actorId: null,
        actorType: 'SYSTEM',
        targetType: 'booking',
        targetId: id,
        metadata: { transactionId: b.transactionId },
      });
      await s.outbox(
        this.event(
          RentalEvents.BookingOverdue,
          b.id,
          {
            bookingId: b.id,
            listingId: b.listingId,
            ownerId: b.ownerId,
            renterId: b.renterId,
            transactionId: b.transactionId,
            endAt: iso(b.endAt),
          },
          ctx,
        ),
      );
      n++;
    }
    return n;
  }

  private async runSystem(
    s: RentalStore,
    ids: string[],
    command: BookingCommand,
    job: string,
  ): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const loaded = await s.load(id);
      if (!loaded) continue;
      try {
        const done = await this.apply(
          s,
          loaded,
          command,
          'SYSTEM',
          null,
          null,
          derivedContext(`${job}:${id}`),
          {
            lenient: true,
          },
        );
        if (done) n++;
      } catch (err) {
        // A guard said no (clocks disagree at the boundary): leave it for the next tick.
        if (!(err instanceof AppError)) throw err;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- the one place status changes

  private async apply(
    s: RentalStore,
    { booking, now }: Loaded,
    command: BookingCommand,
    role: ActorRole,
    actorId: string | null,
    reason: string | null,
    ctx: RequestContext,
    opts: { lenient?: boolean; patch?: TransitionPatch } = {},
  ): Promise<Booking | null> {
    const d = decide(this.facts(booking, now), command, role);
    const patch: TransitionPatch = { ...opts.patch, clearHold: true };
    if (command === 'decline' && reason) patch.declineReason = reason;
    if (command === 'cancel' && reason) patch.cancelReason = reason;

    const updated = await s.transition(
      booking.id,
      { from: booking.status, version: booking.version },
      d.to,
      patch,
    );
    if (!updated) {
      if (opts.lenient) return null;
      throw Errors.conflict('This booking was just changed. Reload and try again.', {
        rule: 'CONCURRENT_UPDATE',
      });
    }
    await s.appendTransition({
      bookingId: booking.id,
      from: d.from,
      to: d.to,
      command,
      actorId,
      actorRole: role,
      reason,
    });
    if (SLOT_RELEASING.has(d.to)) await s.releaseBookingSlot(booking.id);
    await s.audit(ctx, {
      action: `booking.${command}`,
      actorId,
      actorType: actorTypeOf(role),
      targetType: 'booking',
      targetId: booking.id,
      metadata: { from: d.from, to: d.to, role, transactionId: updated.transactionId },
    });
    const events: EventEnvelope<unknown>[] = [
      this.statusChanged(updated, d.from, d.to, reason ?? DEFAULT_REASON[command], ctx),
    ];
    if (d.to === 'CONFIRMED') events.push(this.confirmed(updated, ctx));
    await s.outbox(events);
    return updated;
  }

  private statusChanged(
    b: Booking,
    from: BookingStatus,
    to: BookingStatus,
    reason: string,
    ctx: RequestContext,
  ) {
    return this.event(
      RentalEvents.BookingStatusChanged,
      b.id,
      {
        bookingId: b.id,
        listingId: b.listingId,
        ownerId: b.ownerId,
        renterId: b.renterId,
        from,
        to,
        transactionId: b.transactionId,
        reason,
      },
      ctx,
    );
  }

  private confirmed(b: Booking, ctx: RequestContext) {
    return this.event(
      RentalEvents.BookingConfirmed,
      b.id,
      {
        bookingId: b.id,
        listingId: b.listingId,
        ownerId: b.ownerId,
        renterId: b.renterId,
        startAt: iso(b.startAt),
        endAt: iso(b.endAt),
        amount: { amount: b.amount, currency: b.currency },
        deposit: b.deposit === null ? null : { amount: b.deposit, currency: b.currency },
        terms: b.terms,
      },
      ctx,
    );
  }

  private facts(b: Booking, now: Date): TransitionFacts {
    return { status: b.status, holdExpiresAt: b.holdExpiresAt, now };
  }

  private async compose(
    s: RentalStore,
    { booking, now }: Loaded,
    viewer: Actor,
  ): Promise<BookingDetail> {
    const viewerRole = partyRole(booking, viewer.id);
    const allowed = new Set<BookingCommand>(
      viewerRole ? availableCommands(this.facts(booking, now), viewerRole) : [],
    );
    return {
      booking,
      transitions: await s.transitions(booking.id),
      viewerRole,
      actions: PartyCommands.filter((c) => allowed.has(c)),
    };
  }
}
