import {
  TransactionEvents,
  type BiddingEvents,
  type DisputeEvents,
  type DisputeReason,
  type EventEnvelope,
  type LendingEvents,
  type NeedMode,
  type RentalEvents,
} from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Actor,
  type AuditEntry,
  type Logger,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  availableCommands,
  decide,
  transitionPatch,
  type ActorRole,
  type TransactionCommand,
  type TransitionFacts,
} from '../domain/transaction-state-machine';
import {
  assertNoContactInfo,
  depositOutcome,
  listingTerms,
  priceListingPurchase,
  PRE_AGREED_SOURCES,
  type Delivery,
  type Deposit,
  type Payment,
  type Transaction,
  type TransactionPolicy,
  type Transition,
} from '../domain/transaction';
import type {
  DeliveryArrangement,
  DeliveryProvider,
  ListQuery,
  Loaded,
  NewTransaction,
  PaymentProvider,
  ProviderRegistry,
  ProviderSelection,
  TransactionStore,
  TransactionUnitOfWork,
} from './ports';

/** Commands a party runs over HTTP. */
export const PartyCommands = [
  'confirm',
  'cancel',
  'arrange-delivery',
  'mark-delivered',
  'confirm-receipt',
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
  'dispute',
] as const satisfies readonly TransactionCommand[];
export type PartyCommand = (typeof PartyCommands)[number];

/** What a viewer may do next, as exposed to clients. Dispute outcomes come from the dispute service. */
export const ActionNames = PartyCommands;
export type ActionName = PartyCommand;

export interface CommandInput {
  reason?: string | undefined;
  /** Dispute category (defaults to OTHER). */
  category?: DisputeReason | undefined;
  delivery?: DeliveryArrangement | undefined;
}

export interface TransactionDetail {
  tx: Transaction;
  payment: Payment | null;
  delivery: Delivery | null;
  deposit: Deposit | null;
  transitions: Transition[];
  viewerRole: 'BUYER' | 'SELLER' | null;
  actions: ActionName[];
}

export interface OfferAcceptedFacts {
  offerId: string;
  needId: string;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  mode: NeedMode;
  price: { amount: number; currency: 'BDT' };
  quantity: number;
  terms: Record<string, unknown>;
}
export type AuctionAwardedFacts = z.output<typeof BiddingEvents.AuctionAwarded.schema>;
export type BookingConfirmedFacts = z.output<typeof RentalEvents.BookingConfirmed.schema>;
export type LoanApprovedFacts = z.output<typeof LendingEvents.LoanApproved.schema>;
export type DisputeResolvedFacts = z.output<typeof DisputeEvents.DisputeResolved.schema>;
export type DisputeWithdrawnFacts = z.output<typeof DisputeEvents.DisputeWithdrawn.schema>;

type ServiceLog = Pick<Logger, 'info' | 'warn'>;

const requireActor = (ctx: RequestContext): Actor => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const partyRole = (tx: Transaction, accountId: string): 'BUYER' | 'SELLER' | null =>
  tx.buyerId === accountId ? 'BUYER' : tx.sellerId === accountId ? 'SELLER' : null;

const actorTypeOf = (role: ActorRole): NonNullable<AuditEntry['actorType']> =>
  role === 'SYSTEM' ? 'SYSTEM' : role === 'ADMIN' ? 'ADMIN' : 'USER';

/** Context for work that is not an HTTP request (event consumers, jobs). */
export const derivedContext = (requestId: string, correlationId?: string): RequestContext => ({
  requestId,
  correlationId: correlationId ?? requestId,
  ipHash: null,
  userAgent: null,
  actor: null,
});

/** Reasons are stored and published with a 500 character cap. */
const clip = (text: string | null | undefined): string | null => {
  const t = text?.trim();
  return t ? t.slice(0, 500) : null;
};

const RESOLUTION_COMMANDS = {
  RELEASE: 'resolve-release',
  CANCEL: 'resolve-cancel',
  REFUND: 'resolve-refund',
} as const satisfies Record<DisputeResolvedFacts['resolution'], TransactionCommand>;

const JOB_BATCH = 100;

/**
 * Transaction use cases. Each transition writes the guarded state change, its history row, the
 * payment/delivery/deposit side effects, an audit record and the outbox event in one DB
 * transaction.
 */
export class TransactionService {
  constructor(
    private readonly uow: TransactionUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly payments: ProviderRegistry<PaymentProvider>,
    private readonly deliveries: ProviderRegistry<DeliveryProvider>,
    private readonly select: ProviderSelection,
    private readonly policy: TransactionPolicy,
    private readonly log: ServiceLog,
  ) {}

  // ---- creation from other services' events (each runs inside the inbox transaction)

  /** A second OfferAccepted for the same offer is a no-op. */
  onOfferAccepted(s: TransactionStore, p: OfferAcceptedFacts, e: EventEnvelope): Promise<void> {
    return this.createFromEvent(s, e, {
      sourceType: 'OFFER',
      sourceId: p.offerId,
      listingId: p.listingId,
      needId: p.needId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: p.mode,
      amount: p.price.amount,
      currency: p.price.currency,
      quantity: p.quantity,
      terms: p.terms,
    });
  }

  /** The winner and the owner still confirm, as for an accepted offer. */
  onAuctionAwarded(s: TransactionStore, p: AuctionAwardedFacts, e: EventEnvelope): Promise<void> {
    return this.createFromEvent(s, e, {
      sourceType: 'AUCTION',
      sourceId: p.auctionId,
      listingId: p.listingId,
      needId: p.needId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: p.mode,
      amount: p.amount.amount,
      currency: p.amount.currency,
      quantity: p.quantity,
      terms: { ...p.terms, auctionKind: p.kind, winningBidId: p.winningBidId },
    });
  }

  /** Owner and renter already agreed in the rental service: the deal starts CONFIRMED. */
  onBookingConfirmed(
    s: TransactionStore,
    p: BookingConfirmedFacts,
    e: EventEnvelope,
  ): Promise<void> {
    return this.createFromEvent(
      s,
      e,
      {
        sourceType: 'BOOKING',
        sourceId: p.bookingId,
        listingId: p.listingId,
        needId: null,
        buyerId: p.renterId,
        sellerId: p.ownerId,
        mode: 'RENT',
        amount: p.amount.amount,
        currency: p.amount.currency,
        quantity: 1,
        terms: { startAt: p.startAt, endAt: p.endAt, deposit: p.deposit, terms: p.terms },
      },
      p.deposit?.amount ?? 0,
    );
  }

  /** Lender and borrower already agreed in the lending service: free, starts CONFIRMED. */
  onLoanApproved(s: TransactionStore, p: LoanApprovedFacts, e: EventEnvelope): Promise<void> {
    return this.createFromEvent(
      s,
      e,
      {
        sourceType: 'LOAN',
        sourceId: p.loanId,
        listingId: null,
        needId: null,
        buyerId: p.borrowerId,
        sellerId: p.lenderId,
        mode: 'BORROW',
        amount: 0,
        currency: 'BDT',
        quantity: 1,
        terms: {
          startAt: p.startAt,
          returnBy: p.returnBy,
          deposit: p.deposit,
          itemId: p.itemId,
          terms: p.terms,
        },
      },
      p.deposit?.amount ?? 0,
    );
  }

  private async createFromEvent(
    s: TransactionStore,
    e: EventEnvelope,
    input: Omit<NewTransaction, 'id'>,
    depositAmount = 0,
  ): Promise<void> {
    const source = { type: e.type, sourceType: input.sourceType, sourceId: input.sourceId };
    if (input.buyerId === input.sellerId) {
      // Retrying cannot fix it, so do not poison the stream.
      this.log.warn(source, 'deal with the same buyer and seller ignored');
      return;
    }
    const created = await s.insert({ id: uuidv7(), ...input });
    if (!created) {
      this.log.info(source, 'transaction for this source already exists');
      return;
    }
    const ctx = derivedContext(e.id, e.correlationId);
    await this.afterCreate(s, created, ctx, null, depositAmount);
    if (PRE_AGREED_SOURCES.includes(created.sourceType)) {
      // Same DB transaction: TransactionCreated, then CREATED → CONFIRMED with a history row.
      const loaded = await s.load(created.id);
      await this.apply(s, loaded!, 'auto-confirm', 'SYSTEM', null, {}, ctx);
    }
  }

  async purchaseListing(
    input: { listingId: string; quantity: number },
    ctx: RequestContext,
  ): Promise<TransactionDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const listing = await s.listing(input.listingId);
      if (!listing) throw Errors.notFound('Listing');
      const { mode, amount } = priceListingPurchase(listing, actor.id, input.quantity);
      if (!(await s.reserveListing(listing.listingId, input.quantity))) {
        throw new AppError('BUSINESS_RULE_VIOLATION', 'Not enough quantity available.', {
          rule: 'INSUFFICIENT_QUANTITY',
        });
      }
      const tx = await s.insert({
        id: uuidv7(),
        sourceType: 'LISTING',
        sourceId: listing.listingId,
        listingId: listing.listingId,
        needId: null,
        buyerId: actor.id,
        sellerId: listing.sellerId,
        mode,
        amount,
        currency: 'BDT',
        quantity: input.quantity,
        terms: listingTerms(listing, input.quantity),
      });
      if (!tx) throw Errors.conflict('Could not create the transaction.');
      await this.afterCreate(s, tx, ctx, actor.id, 0);
      return this.compose(s, (await s.load(tx.id))!, actor);
    });
  }

  /**
   * Payment, deposit, audit and TransactionCreated for a new deal. Free deals (loans) get no
   * payment record: there is nothing to pay or settle.
   */
  private async afterCreate(
    s: TransactionStore,
    tx: Transaction,
    ctx: RequestContext,
    actorId: string | null,
    depositAmount: number,
  ): Promise<void> {
    if (tx.amount > 0) {
      const provider = this.payments.get(this.select.paymentFor(tx));
      await s.insertPayment(tx, provider.name, await provider.initiate(tx));
    }
    if (depositAmount > 0) await s.insertDeposit(tx, depositAmount);
    await s.audit(ctx, {
      action: 'transaction.created',
      actorId,
      actorType: actorId ? 'USER' : 'SYSTEM',
      targetType: 'transaction',
      targetId: tx.id,
      metadata: { sourceType: tx.sourceType, sourceId: tx.sourceId, mode: tx.mode },
    });
    await s.outbox(
      this.event(
        TransactionEvents.TransactionCreated,
        tx.id,
        {
          transactionId: tx.id,
          sourceType: tx.sourceType,
          sourceId: tx.sourceId,
          needId: tx.needId,
          listingId: tx.listingId,
          buyerId: tx.buyerId,
          sellerId: tx.sellerId,
          amount: { amount: tx.amount, currency: tx.currency },
          quantity: tx.quantity,
          mode: tx.mode,
        },
        ctx,
      ),
    );
  }

  // ---- dispute outcomes (ADR-0009), inside the inbox transaction

  /** RELEASE → COMPLETED, CANCEL → CANCELLED, REFUND → REFUNDED (refundable providers only). */
  async onDisputeResolved(
    s: TransactionStore,
    p: DisputeResolvedFacts,
    e: EventEnvelope,
  ): Promise<void> {
    const loaded = await this.disputedOrNull(s, p, e);
    if (!loaded) return;
    const ctx = derivedContext(e.id, e.correlationId);
    const command = RESOLUTION_COMMANDS[p.resolution];
    if (command === 'resolve-refund' && !(await this.refundable(s, loaded.tx))) {
      // The dispute service refuses REFUND for cash; if one arrives anyway, record and ignore it.
      this.log.warn(
        { transactionId: loaded.tx.id, disputeId: p.disputeId },
        'dispute REFUND ignored: the payment cannot be refunded',
      );
      const payment = await s.payment(loaded.tx.id);
      await s.audit(ctx, {
        action: 'transaction.dispute-refund-ignored',
        actorId: p.resolvedBy,
        actorType: 'ADMIN',
        targetType: 'transaction',
        targetId: loaded.tx.id,
        metadata: { disputeId: p.disputeId, provider: payment?.provider ?? null },
      });
      return;
    }
    await this.apply(
      s,
      loaded,
      command,
      'ADMIN',
      p.resolvedBy,
      { reason: clip(p.note) ?? undefined },
      ctx,
      {
        disputeId: p.disputeId,
      },
    );
  }

  /** DISPUTED → the state before the dispute. */
  async onDisputeWithdrawn(
    s: TransactionStore,
    p: DisputeWithdrawnFacts,
    e: EventEnvelope,
  ): Promise<void> {
    const loaded = await this.disputedOrNull(s, p, e);
    if (!loaded) return;
    if (loaded.tx.preDisputeState !== p.previousState) {
      this.log.warn(
        {
          transactionId: loaded.tx.id,
          stored: loaded.tx.preDisputeState,
          reported: p.previousState,
        },
        'dispute withdrawal reports a different previous state; restoring the stored one',
      );
    }
    await this.apply(
      s,
      loaded,
      'withdraw-dispute',
      'SYSTEM',
      p.withdrawnBy,
      {},
      derivedContext(e.id, e.correlationId),
      { disputeId: p.disputeId },
    );
  }

  /** Dispute commands apply only to the right transaction while it is DISPUTED; else a no-op. */
  private async disputedOrNull(
    s: TransactionStore,
    p: { disputeId: string; transactionId: string; buyerId: string; sellerId: string },
    e: EventEnvelope,
  ): Promise<Loaded | null> {
    const loaded = await s.load(p.transactionId);
    const info = { type: e.type, transactionId: p.transactionId, disputeId: p.disputeId };
    if (!loaded) {
      this.log.warn(info, 'dispute outcome for an unknown transaction ignored');
      return null;
    }
    if (loaded.tx.buyerId !== p.buyerId || loaded.tx.sellerId !== p.sellerId) {
      this.log.warn(info, 'dispute outcome with mismatched parties ignored');
      return null;
    }
    if (loaded.tx.state !== 'DISPUTED') {
      this.log.warn({ ...info, state: loaded.tx.state }, 'transaction is not disputed; ignored');
      return null;
    }
    return loaded;
  }

  private async refundable(s: TransactionStore, tx: Transaction): Promise<boolean> {
    const payment = await s.payment(tx.id);
    return payment !== null && this.payments.get(payment.provider).supportsRefund;
  }

  // ---- reads

  async get(id: string, ctx: RequestContext): Promise<TransactionDetail> {
    const actor = requireActor(ctx);
    const loaded = await this.uow.store.load(id);
    if (!loaded) throw Errors.notFound('Transaction');
    if (!partyRole(loaded.tx, actor.id) && !actor.permissions.has('transaction:read:any')) {
      throw Errors.notFound('Transaction');
    }
    return this.compose(this.uow.store, loaded, actor);
  }

  listMine(
    role: 'buyer' | 'seller' | undefined,
    q: ListQuery,
    ctx: RequestContext,
  ): Promise<Transaction[]> {
    const actor = requireActor(ctx);
    return this.uow.store.listForParty(actor.id, role, q);
  }

  listAll(q: ListQuery): Promise<Transaction[]> {
    return this.uow.store.listAll(q);
  }

  // ---- commands

  async command(
    id: string,
    command: PartyCommand,
    input: CommandInput,
    ctx: RequestContext,
  ): Promise<TransactionDetail> {
    const actor = requireActor(ctx);
    if (input.delivery) assertNoContactInfo('delivery notes', input.delivery.notes);
    // Reasons travel in TransactionStateChanged: phone numbers and emails stay out.
    assertNoContactInfo('reason', input.reason);
    return this.uow.transaction(async (s) => {
      const loaded = await s.load(id);
      const role = loaded ? partyRole(loaded.tx, actor.id) : null;
      if (!loaded || !role) throw Errors.notFound('Transaction');
      const tx = await this.apply(s, loaded, command, role, actor.id, input, ctx);
      return this.compose(s, { tx: tx!, now: loaded.now }, actor);
    });
  }

  // ---- jobs (run inside the job's transaction; rows are locked by the due-query)

  async expireDue(s: TransactionStore): Promise<number> {
    const ids = await s.dueForExpiry(this.policy.confirmTtlMs, JOB_BATCH);
    return this.runSystem(s, ids, 'expire', 'transaction.expire-unconfirmed');
  }

  /** DELIVERED past the completion window and RETURNED past the damage-claim window. */
  async autoCompleteDue(s: TransactionStore): Promise<number> {
    const ids = await s.dueForAutoComplete(
      { deliveredMs: this.policy.autoCompleteMs, returnedMs: this.policy.returnCompleteMs },
      JOB_BATCH,
    );
    return this.runSystem(s, ids, 'auto-complete', 'transaction.auto-complete');
  }

  private async runSystem(
    s: TransactionStore,
    ids: string[],
    command: TransactionCommand,
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
          {},
          derivedContext(`${job}:${id}`),
          {
            lenient: true,
          },
        );
        if (done) n++;
      } catch (err) {
        // A guard said no (e.g. clocks disagree at the boundary): leave it for the next tick.
        if (!(err instanceof AppError)) throw err;
      }
    }
    return n;
  }

  // ---- the one place a transaction changes state

  private async apply(
    s: TransactionStore,
    { tx, now }: Loaded,
    command: TransactionCommand,
    role: ActorRole,
    actorId: string | null,
    input: CommandInput,
    ctx: RequestContext,
    opts: { lenient?: boolean; disputeId?: string } = {},
  ): Promise<Transaction | null> {
    const refundable = command === 'resolve-refund' && (await this.refundable(s, tx));
    const d = decide(this.facts(tx, now, refundable), command, role);
    const reason = input.reason ?? null;
    const updated = await s.transition(
      tx.id,
      { from: tx.state, version: tx.version },
      d.to,
      transitionPatch(command, role, d, { reason, category: input.category }),
    );
    if (!updated) {
      if (opts.lenient) return null;
      throw Errors.conflict('This transaction was just changed. Reload and try again.', {
        rule: 'CONCURRENT_UPDATE',
      });
    }
    await s.appendTransition({
      transactionId: tx.id,
      from: d.from,
      to: d.to,
      command,
      actorId,
      actorRole: role,
      reason,
    });
    await this.sideEffects(s, updated, command, input);
    await s.audit(ctx, {
      action: `transaction.${command}`,
      actorId,
      actorType: actorTypeOf(role),
      targetType: 'transaction',
      targetId: tx.id,
      metadata: {
        from: d.from,
        to: d.to,
        role,
        ...(opts.disputeId ? { disputeId: opts.disputeId } : {}),
      },
    });
    if (d.from !== d.to) {
      await s.outbox(
        this.event(
          TransactionEvents.TransactionStateChanged,
          tx.id,
          {
            transactionId: tx.id,
            needId: tx.needId,
            sourceType: tx.sourceType,
            sourceId: tx.sourceId,
            buyerId: tx.buyerId,
            sellerId: tx.sellerId,
            from: d.from,
            to: d.to,
            actorId,
            mode: tx.mode,
            ...(reason ? { reason } : {}),
            ...(d.to === 'DISPUTED' ? { disputeReason: updated.disputeCategory ?? 'OTHER' } : {}),
          },
          ctx,
        ),
      );
    }
    return updated;
  }

  /** Payment, delivery and deposit react to the outcome; the state machine never sees them. */
  private async sideEffects(
    s: TransactionStore,
    tx: Transaction,
    command: TransactionCommand,
    input: CommandInput,
  ): Promise<void> {
    if (command === 'arrange-delivery' && input.delivery) {
      const provider = this.deliveries.get(this.select.deliveryFor(tx, input.delivery.method));
      await s.insertDelivery(
        tx,
        provider.name,
        input.delivery,
        await provider.arrange(tx, input.delivery),
      );
    }
    if (command === 'mark-delivered') {
      const delivery = await s.delivery(tx.id);
      if (delivery) {
        const provider = this.deliveries.get(delivery.provider);
        await s.updateDelivery(delivery.id, await provider.markDelivered(tx, delivery));
      }
    }
    if (tx.state === 'COMPLETED') {
      const payment = await s.payment(tx.id);
      if (payment) {
        const provider = this.payments.get(payment.provider);
        await s.updatePayment(payment.id, await provider.onCompleted(tx, payment));
      }
    }
    if (tx.state === 'CANCELLED' || tx.state === 'EXPIRED' || tx.state === 'REFUNDED') {
      const payment = await s.payment(tx.id);
      if (payment) {
        const provider = this.payments.get(payment.provider);
        await s.updatePayment(payment.id, await provider.refund(tx, payment));
      }
      const delivery = await s.delivery(tx.id);
      if (delivery && delivery.status === 'ARRANGED') {
        const provider = this.deliveries.get(delivery.provider);
        await s.updateDelivery(delivery.id, await provider.cancel(tx, delivery));
      }
    }
    const deposit = await s.deposit(tx.id);
    if (deposit && deposit.status === 'HELD') {
      const opener = command === 'resolve-release' ? await this.disputeOpener(s, tx.id) : null;
      const outcome = depositOutcome(tx.state, command, opener);
      if (outcome) await s.updateDeposit(deposit.id, outcome.status, outcome.note);
    }
  }

  private async disputeOpener(
    s: TransactionStore,
    transactionId: string,
  ): Promise<'BUYER' | 'SELLER' | null> {
    const opened = (await s.transitions(transactionId)).findLast((t) => t.command === 'dispute');
    return opened?.actorRole === 'BUYER' || opened?.actorRole === 'SELLER'
      ? opened.actorRole
      : null;
  }

  private facts(tx: Transaction, now: Date, refundable = false): TransitionFacts {
    return {
      state: tx.state,
      mode: tx.mode,
      sourceType: tx.sourceType,
      buyerConfirmedAt: tx.buyerConfirmedAt,
      sellerConfirmedAt: tx.sellerConfirmedAt,
      createdAt: tx.createdAt,
      deliveredAt: tx.deliveredAt,
      returnedAt: tx.returnedAt,
      preDisputeState: tx.preDisputeState,
      refundable,
      now,
      policy: this.policy,
    };
  }

  private async compose(
    s: TransactionStore,
    { tx, now }: Loaded,
    viewer: Actor,
  ): Promise<TransactionDetail> {
    const [payment, delivery, deposit, transitions] = await Promise.all([
      s.payment(tx.id),
      s.delivery(tx.id),
      s.deposit(tx.id),
      s.transitions(tx.id),
    ]);
    const viewerRole = partyRole(tx, viewer.id);
    let actions: ActionName[] = [];
    if (viewerRole) {
      const allowed = new Set<TransactionCommand>(
        availableCommands(this.facts(tx, now), viewerRole),
      );
      actions = PartyCommands.filter((c) => allowed.has(c));
    }
    return {
      tx,
      payment,
      // Delivery notes are private to the two parties.
      delivery: delivery && !viewerRole ? { ...delivery, notes: null } : delivery,
      deposit,
      transitions,
      viewerRole,
      actions,
    };
  }
}
