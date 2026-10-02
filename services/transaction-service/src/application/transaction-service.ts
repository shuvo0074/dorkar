import { TransactionEvents, type EventEnvelope, type NeedMode } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Actor,
  type AuditEntry,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
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
  listingTerms,
  priceListingPurchase,
  type Delivery,
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
  'dispute',
] as const satisfies readonly TransactionCommand[];
export type PartyCommand = (typeof PartyCommands)[number];

/** What a viewer may do next, as exposed to clients (`resolve` covers both resolutions). */
export const ActionNames = [...PartyCommands, 'resolve'] as const;
export type ActionName = (typeof ActionNames)[number];

export type Resolution = 'RELEASE' | 'CANCEL';

export interface CommandInput {
  reason?: string | undefined;
  delivery?: DeliveryArrangement | undefined;
}

export interface TransactionDetail {
  tx: Transaction;
  payment: Payment | null;
  delivery: Delivery | null;
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

const JOB_BATCH = 100;

/**
 * Transaction use cases. Each transition writes the guarded state change, its history row, the
 * payment/delivery side effects, an audit record and the outbox event in one DB transaction.
 */
export class TransactionService {
  constructor(
    private readonly uow: TransactionUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly payments: ProviderRegistry<PaymentProvider>,
    private readonly deliveries: ProviderRegistry<DeliveryProvider>,
    private readonly select: ProviderSelection,
    private readonly policy: TransactionPolicy,
  ) {}

  // ---- creation

  /** Called inside the inbox transaction. A second OfferAccepted for the same offer is a no-op. */
  async onOfferAccepted(
    s: TransactionStore,
    p: OfferAcceptedFacts,
    e: EventEnvelope,
  ): Promise<void> {
    const created = await s.insert({
      id: uuidv7(),
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
    if (!created) return;
    await this.afterCreate(s, created, derivedContext(e.id, e.correlationId), null);
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
      await this.afterCreate(s, tx, ctx, actor.id);
      return this.compose(s, (await s.load(tx.id))!, actor);
    });
  }

  private async afterCreate(
    s: TransactionStore,
    tx: Transaction,
    ctx: RequestContext,
    actorId: string | null,
  ): Promise<void> {
    const provider = this.payments.get(this.select.paymentFor(tx));
    await s.insertPayment(tx, provider.name, await provider.initiate(tx));
    await s.audit(ctx, {
      action: 'transaction.created',
      actorId,
      actorType: actorId ? 'USER' : 'SYSTEM',
      targetType: 'transaction',
      targetId: tx.id,
      metadata: { sourceType: tx.sourceType, mode: tx.mode },
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
    return this.uow.transaction(async (s) => {
      const loaded = await s.load(id);
      const role = loaded ? partyRole(loaded.tx, actor.id) : null;
      if (!loaded || !role) throw Errors.notFound('Transaction');
      const tx = await this.apply(s, loaded, command, role, actor.id, input, ctx);
      return this.compose(s, { tx: tx!, now: loaded.now }, actor);
    });
  }

  /** Admin decision on a dispute. */
  async resolve(
    id: string,
    resolution: Resolution,
    note: string,
    ctx: RequestContext,
  ): Promise<TransactionDetail> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const loaded = await s.load(id);
      if (!loaded) throw Errors.notFound('Transaction');
      const command = resolution === 'RELEASE' ? 'resolve-release' : 'resolve-cancel';
      const tx = await this.apply(s, loaded, command, 'ADMIN', actor.id, { reason: note }, ctx);
      return this.compose(s, { tx: tx!, now: loaded.now }, actor);
    });
  }

  // ---- jobs (run inside the job's transaction; rows are locked by the due-query)

  async expireDue(s: TransactionStore): Promise<number> {
    const ids = await s.dueForExpiry(this.policy.confirmTtlMs, JOB_BATCH);
    return this.runSystem(s, ids, 'expire', 'transaction.expire-unconfirmed');
  }

  async autoCompleteDue(s: TransactionStore): Promise<number> {
    const ids = await s.dueForAutoComplete(this.policy.autoCompleteMs, JOB_BATCH);
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
    opts: { lenient?: boolean } = {},
  ): Promise<Transaction | null> {
    const d = decide(this.facts(tx, now), command, role);
    const reason = input.reason ?? null;
    const updated = await s.transition(
      tx.id,
      { from: tx.state, version: tx.version },
      d.to,
      transitionPatch(command, role, d.to, reason),
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
      metadata: { from: d.from, to: d.to, role },
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
          },
          ctx,
        ),
      );
    }
    return updated;
  }

  /** Payment and delivery react to the outcome; the state machine never sees them. */
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
    if (tx.state === 'CANCELLED' || tx.state === 'EXPIRED') {
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
  }

  private facts(tx: Transaction, now: Date): TransitionFacts {
    return {
      state: tx.state,
      buyerConfirmedAt: tx.buyerConfirmedAt,
      sellerConfirmedAt: tx.sellerConfirmedAt,
      createdAt: tx.createdAt,
      deliveredAt: tx.deliveredAt,
      now,
      policy: this.policy,
    };
  }

  private async compose(
    s: TransactionStore,
    { tx, now }: Loaded,
    viewer: Actor,
  ): Promise<TransactionDetail> {
    const [payment, delivery, transitions] = await Promise.all([
      s.payment(tx.id),
      s.delivery(tx.id),
      s.transitions(tx.id),
    ]);
    const viewerRole = partyRole(tx, viewer.id);
    const facts = this.facts(tx, now);
    let actions: ActionName[] = [];
    if (viewerRole) {
      const allowed = new Set<TransactionCommand>(availableCommands(facts, viewerRole));
      actions = PartyCommands.filter((c) => allowed.has(c));
    } else if (
      viewer.permissions.has('dispute:resolve') &&
      availableCommands(facts, 'ADMIN').length
    ) {
      actions = ['resolve'];
    }
    return {
      tx,
      payment,
      // Delivery notes are private to the two parties.
      delivery: delivery && !viewerRole ? { ...delivery, notes: null } : delivery,
      transitions,
      viewerRole,
      actions,
    };
  }
}
