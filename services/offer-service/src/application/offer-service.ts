import {
  OfferEvents,
  type CatalogEvents,
  type Condition,
  type DemandEvents,
  type EventEnvelope,
  type Money,
  type ModerationEvents,
  type NeedStatus,
  type OfferStatus,
  type TransactionEvents,
} from '@dorkar/contracts';
import {
  AppError,
  decodeCursor,
  Errors,
  paginate,
  uuidv7,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertCanAccept,
  assertCanAct,
  assertCanSubmit,
  assertNeedTakesOffersFrom,
  assertNoContactInfo,
  assertQuantityAvailable,
  availableActions,
  finalTerms,
  isLive,
  NEED_TERMINATING_STATUSES,
  nextStatus,
  offerExpiry,
  otherParty,
  parseModeTerms,
  partyOf,
  type DeliveryTerms,
  type Offer,
  type OfferAction,
  type OfferRound,
  type Party,
} from '../domain/offer';
import type {
  NeedFacts,
  OfferSort,
  OfferStore,
  OfferUnitOfWork,
  ProfileDirectory,
  StatusHistoryEntry,
  VerificationGateway,
} from './ports';

export interface OfferSettings {
  defaultTtlHours: number;
  maxTtlDays: number;
  maxRounds: number;
}

export interface SubmitInput {
  listingId?: string | null | undefined;
  price: Money;
  quantity: number;
  condition?: Condition | null | undefined;
  availabilityFrom?: string | null | undefined;
  deliveryTerms: DeliveryTerms;
  modeTerms?: unknown;
  description?: string | null | undefined;
  attachmentMediaIds?: string[] | undefined;
  expiresInHours?: number | undefined;
}

export interface CounterInput {
  price: Money;
  quantity: number;
  deliveryTerms?: DeliveryTerms | undefined;
  modeTerms?: unknown;
  condition?: Condition | null | undefined;
  availabilityFrom?: string | null | undefined;
  message?: string | null | undefined;
}

/** An offer as one caller sees it: what they may do now, and the seller's name when known. */
export interface OfferView {
  offer: Offer;
  actions: OfferAction[];
  sellerName: string | null;
}

export interface OfferDetail extends OfferView {
  rounds: OfferRound[];
}

export interface AdminOfferDetail {
  offer: Offer;
  rounds: OfferRound[];
  history: StatusHistoryEntry[];
}

type EventCtx = Pick<RequestContext, 'requestId' | 'correlationId'>;
type Payload<K extends keyof typeof DemandEvents> = z.output<(typeof DemandEvents)[K]['schema']>;

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const eventCtx = (e: EventEnvelope): EventCtx => ({
  requestId: e.id,
  correlationId: e.correlationId ?? e.id,
});

const raced = () =>
  new AppError('INVALID_STATE_TRANSITION', 'This offer just changed. Reload and try again.', {
    reason: 'CONCURRENT_UPDATE',
  });

/** Hidden by moderation: parties see a placeholder, not the content. */
const redact = (o: Offer): Offer =>
  o.hidden ? { ...o, description: null, attachmentMediaIds: [] } : o;

const AUDIT: Record<OfferAction, string> = {
  ACCEPT: 'offer.accept',
  COUNTER: 'offer.counter',
  REJECT: 'offer.reject',
  WITHDRAW: 'offer.withdraw',
};

/** Offer use cases. Every state change writes state, history, outbox and audit in one transaction. */
export class OfferService {
  constructor(
    private readonly uow: OfferUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
    private readonly profiles: ProfileDirectory,
    private readonly settings: OfferSettings,
  ) {}

  // ---------------------------------------------------------------- commands

  async submit(needId: string, input: SubmitInput, ctx: RequestContext): Promise<OfferDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('description', input.description);
    const need = await this.uow.store.need(needId);
    if (!need) throw Errors.notFound('Need');
    // Cheap checks first, so a closed need never costs a verification round-trip.
    assertNeedTakesOffersFrom(need, actor.id, await this.uow.store.now());
    const modeTerms = parseModeTerms(need.mode, input.modeTerms);

    const decision = await this.verification.evaluate(
      {
        accountId: actor.id,
        action: 'OFFER_SUBMIT',
        categoryId: need.categoryId,
        mode: need.mode,
        amount: input.price.amount,
      },
      ctx,
    );
    if (!decision.satisfied) {
      throw new AppError(
        'VERIFICATION_REQUIRED',
        'Verify your account to make offers in this category.',
        { action: 'OFFER_SUBMIT', missing: decision.missing },
      );
    }

    return this.uow.transaction(async (s) => {
      const now = await s.now();
      const locked = await s.lockNeed(needId);
      if (!locked) throw Errors.notFound('Need');
      const listingId = input.listingId ?? null;
      assertCanSubmit({
        need: locked,
        sellerId: actor.id,
        now,
        quantity: input.quantity,
        activeOfferCount: await s.countActiveOnNeed(needId),
        sellerHasLiveOffer: await s.hasLiveOffer(needId, actor.id),
        listingId,
        listing: listingId ? await s.listing(listingId) : null,
      });
      const expiresAt = offerExpiry(now, input.expiresInHours, this.settings, locked.expiresAt);

      const id = uuidv7();
      const condition = input.condition ?? null;
      const availabilityFrom = input.availabilityFrom ?? null;
      const offer = await s.insert(
        {
          id,
          needId,
          buyerId: locked.requesterId,
          sellerId: actor.id,
          listingId,
          status: 'SUBMITTED',
          price: input.price,
          quantity: input.quantity,
          condition,
          availabilityFrom,
          deliveryTerms: input.deliveryTerms,
          modeTerms,
          description: input.description ?? null,
          attachmentMediaIds: [...new Set(input.attachmentMediaIds ?? [])],
          expiresAt,
          currentRound: 1,
          awaiting: 'BUYER',
        },
        {
          offerId: id,
          round: 1,
          proposedBy: 'SELLER',
          price: input.price,
          quantity: input.quantity,
          terms: { delivery: input.deliveryTerms, mode: modeTerms, condition, availabilityFrom },
          message: null,
        },
      );
      await s.recordStatus(id, null, 'SUBMITTED', 'SUBMITTED', actor.id);
      await s.outbox(
        this.event(
          OfferEvents.OfferSubmitted,
          id,
          {
            offerId: id,
            needId,
            buyerId: offer.buyerId,
            sellerId: offer.sellerId,
            price: offer.price,
            quantity: offer.quantity,
          },
          ctx,
        ),
      );
      await s.audit(ctx, {
        action: 'offer.submit',
        targetType: 'OFFER',
        targetId: id,
        metadata: { needId },
      });
      return this.detail(s, offer, 'SELLER', now);
    });
  }

  async counter(offerId: string, input: CounterInput, ctx: RequestContext): Promise<OfferDetail> {
    const actor = requireActor(ctx);
    assertNoContactInfo('message', input.message);
    const { party } = await this.partyOrNotFound(offerId, actor.id);

    return this.uow.transaction(async (s) => {
      const now = await s.now();
      const offer = await this.mustGet(s, offerId, true);
      assertCanAct(offer, party, 'COUNTER', now, this.settings);
      const need = await s.need(offer.needId);
      if (!need) throw Errors.notFound('Need');
      assertQuantityAvailable(need, input.quantity);
      const latest = await s.latestRound(offerId);
      const terms = {
        delivery: input.deliveryTerms ?? latest.terms.delivery,
        mode:
          input.modeTerms !== undefined
            ? parseModeTerms(need.mode, input.modeTerms)
            : latest.terms.mode,
        condition: input.condition !== undefined ? input.condition : latest.terms.condition,
        availabilityFrom:
          input.availabilityFrom !== undefined
            ? input.availabilityFrom
            : latest.terms.availabilityFrom,
      };
      const round = offer.currentRound + 1;
      const to = nextStatus('COUNTER', party);
      const updated = await s.transition(offer, to, {
        awaiting: otherParty(party),
        price: input.price,
        quantity: input.quantity,
        deliveryTerms: terms.delivery,
        modeTerms: terms.mode,
        condition: terms.condition,
        availabilityFrom: terms.availabilityFrom,
        currentRound: round,
      });
      if (!updated) throw raced();
      await s.addRound({
        offerId,
        round,
        proposedBy: party,
        price: input.price,
        quantity: input.quantity,
        terms,
        message: input.message ?? null,
      });
      const reason = `COUNTERED_BY_${party}`;
      await s.recordStatus(offerId, offer.status, to, reason, actor.id);
      await s.outbox([
        this.event(
          OfferEvents.OfferCountered,
          offerId,
          {
            offerId,
            needId: offer.needId,
            buyerId: offer.buyerId,
            sellerId: offer.sellerId,
            by: party,
            round,
            price: input.price,
            quantity: input.quantity,
          },
          ctx,
        ),
        this.statusChanged(updated, offer.status, reason, ctx),
      ]);
      await s.audit(ctx, {
        action: AUDIT.COUNTER,
        targetType: 'OFFER',
        targetId: offerId,
        metadata: { round, by: party },
      });
      return this.detail(s, updated, party, now);
    });
  }

  /**
   * Exclusive acceptance: the need's projection row is locked FOR UPDATE, so concurrent accepts
   * on one need serialize and the remaining quantity can never be over-committed.
   */
  async accept(offerId: string, ctx: RequestContext): Promise<OfferDetail> {
    const actor = requireActor(ctx);
    const { party, needId } = await this.partyOrNotFound(offerId, actor.id);

    return this.uow.transaction(async (s) => {
      const now = await s.now();
      const need = await s.lockNeed(needId);
      if (!need) throw Errors.notFound('Need');
      const offer = await this.mustGet(s, offerId, true);
      assertCanAccept(offer, party, need, now, this.settings);

      const latest = await s.latestRound(offerId);
      const updated = await s.transition(offer, 'ACCEPTED', {});
      if (!updated) throw raced();
      await s.addAcceptedQuantity(needId, latest.quantity);
      const reason = `ACCEPTED_BY_${party}`;
      await s.recordStatus(offerId, offer.status, 'ACCEPTED', reason, actor.id);
      await s.outbox([
        this.event(
          OfferEvents.OfferAccepted,
          offerId,
          {
            offerId,
            needId,
            buyerId: offer.buyerId,
            sellerId: offer.sellerId,
            listingId: offer.listingId,
            mode: need.mode,
            price: latest.price,
            quantity: latest.quantity,
            terms: finalTerms(latest),
          },
          ctx,
        ),
        this.statusChanged(updated, offer.status, reason, ctx),
      ]);
      await s.audit(ctx, {
        action: AUDIT.ACCEPT,
        targetType: 'OFFER',
        targetId: offerId,
        metadata: { needId, by: party, round: latest.round, quantity: latest.quantity },
      });

      if (need.acceptedQuantity + latest.quantity >= need.quantity) {
        for (const other of await s.liveOnNeed(needId, offerId)) {
          await this.expire(s, other, 'NEED_FULFILLED', ctx);
        }
      }
      return this.detail(s, updated, party, now);
    });
  }

  reject(offerId: string, ctx: RequestContext): Promise<OfferDetail> {
    return this.close(offerId, 'REJECT', ctx);
  }

  withdraw(offerId: string, ctx: RequestContext): Promise<OfferDetail> {
    return this.close(offerId, 'WITHDRAW', ctx);
  }

  private async close(
    offerId: string,
    action: 'REJECT' | 'WITHDRAW',
    ctx: RequestContext,
  ): Promise<OfferDetail> {
    const actor = requireActor(ctx);
    const { party } = await this.partyOrNotFound(offerId, actor.id);
    return this.uow.transaction(async (s) => {
      const now = await s.now();
      const offer = await this.mustGet(s, offerId, true);
      assertCanAct(offer, party, action, now, this.settings);
      const to = nextStatus(action, party);
      const updated = await s.transition(offer, to, {});
      if (!updated) throw raced();
      const reason = action === 'REJECT' ? 'REJECTED_BY_BUYER' : 'WITHDRAWN_BY_SELLER';
      await s.recordStatus(offerId, offer.status, to, reason, actor.id);
      await s.outbox(this.statusChanged(updated, offer.status, reason, ctx));
      await s.audit(ctx, {
        action: AUDIT[action],
        targetType: 'OFFER',
        targetId: offerId,
        metadata: { from: offer.status },
      });
      return this.detail(s, updated, party, now);
    });
  }

  // ---------------------------------------------------------------- queries

  async getForParty(offerId: string, ctx: RequestContext): Promise<OfferDetail> {
    const actor = requireActor(ctx);
    const offer = await this.uow.store.get(offerId);
    const party = offer ? partyOf(offer, actor.id) : null;
    if (!offer || !party) throw Errors.notFound('Offer');
    return this.detail(this.uow.store, offer, party, await this.uow.store.now());
  }

  /** The requester's compare view. Anyone else gets 404 (no hint the need has offers). */
  async listForNeed(
    needId: string,
    q: { sort: OfferSort; cursor?: string | undefined; limit: number; status?: OfferStatus },
    ctx: RequestContext,
  ): Promise<{ items: OfferView[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const need = await this.uow.store.need(needId);
    if (!need || need.requesterId !== actor.id) throw Errors.notFound('Need');
    const cursor = decodeCursor(q.cursor);
    if (cursor && (typeof cursor.k === 'number') !== (q.sort === 'price_asc')) {
      throw Errors.validation('Cursor does not match the sort order.');
    }
    const rows = await this.uow.store.listForNeed(needId, q.sort, {
      status: q.status,
      cursor,
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (o) => ({
      k: q.sort === 'price_asc' ? o.price.amount : o.createdAt.toISOString(),
      id: o.id,
    }));
    const [now, names] = await Promise.all([
      this.uow.store.now(),
      this.profiles.displayNames([...new Set(page.items.map((o) => o.sellerId))], ctx),
    ]);
    return {
      items: page.items.map((o) => ({
        offer: o,
        actions: availableActions(o, 'BUYER', now, this.settings),
        sellerName: names.get(o.sellerId) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async listMine(
    q: { status?: OfferStatus; cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: OfferView[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const cursor = decodeCursor(q.cursor);
    if (cursor && typeof cursor.k !== 'string') throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.listForSeller(actor.id, {
      status: q.status,
      cursor,
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (o) => ({ k: o.createdAt.toISOString(), id: o.id }));
    const now = await this.uow.store.now();
    return {
      items: page.items.map((o) => ({
        offer: o,
        actions: availableActions(o, 'SELLER', now, this.settings),
        sellerName: null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Support view: full content (even if hidden), rounds and status history. Audited. */
  async getForAdmin(offerId: string, ctx: RequestContext): Promise<AdminOfferDetail> {
    const offer = await this.uow.store.get(offerId);
    if (!offer) throw Errors.notFound('Offer');
    const [rounds, history] = await Promise.all([
      this.uow.store.rounds(offerId),
      this.uow.store.history(offerId),
    ]);
    await this.uow.store.audit(ctx, {
      action: 'offer.admin_read',
      actorType: 'ADMIN',
      targetType: 'OFFER',
      targetId: offerId,
    });
    return { offer, rounds, history };
  }

  // ---------------------------------------------------------------- jobs

  /** Expires live offers past their deadline. Runs inside the job's transaction. */
  async expireDue(s: OfferStore, limit = 500): Promise<number> {
    const due = await s.dueForExpiry(limit);
    let n = 0;
    for (const o of due) if (await this.expire(s, o, 'OFFER_EXPIRED')) n++;
    return n;
  }

  // ---------------------------------------------------------------- event handlers (inbox trx)

  async onNeedFacts(
    s: OfferStore,
    p: Payload<'NeedPublished'>,
    kind: 'PUBLISHED' | 'UPDATED',
  ): Promise<void> {
    const facts: NeedFacts = {
      needId: p.needId,
      requesterId: p.requesterId,
      mode: p.mode,
      categoryId: p.categoryId,
      title: p.title,
      quantity: p.quantity,
      maxOffers: p.maxOffers,
      expiresAt: new Date(p.expiresAt),
    };
    // NeedPublished always means "became OPEN"; NeedUpdated never changes the status.
    await s.upsertNeedFacts(facts, kind === 'PUBLISHED' ? 'OPEN' : undefined);
  }

  async onNeedStatusChanged(
    s: OfferStore,
    p: Payload<'NeedStatusChanged'>,
    e: EventEnvelope,
  ): Promise<void> {
    const known = await s.setNeedStatus(p.needId, p.to);
    if (!known || !NEED_TERMINATING_STATUSES.includes(p.to)) return;
    for (const o of await s.liveOnNeed(p.needId)) {
      await this.expire(s, o, `NEED_${p.to satisfies NeedStatus}`, eventCtx(e));
    }
  }

  async onListing(
    s: OfferStore,
    p:
      | z.output<(typeof CatalogEvents)['ListingPublished']['schema']>
      | z.output<(typeof CatalogEvents)['ListingUnavailable']['schema']>,
  ): Promise<void> {
    const available = 'quantityAvailable' in p ? p.quantityAvailable > 0 : false;
    await s.upsertListing({ listingId: p.listingId, sellerId: p.sellerId, available });
  }

  /** A cancelled/expired transaction releases its offer's quantity back to the need. */
  async onTransactionStateChanged(
    s: OfferStore,
    p: z.output<(typeof TransactionEvents)['TransactionStateChanged']['schema']>,
    e: EventEnvelope,
  ): Promise<void> {
    if (p.sourceType !== 'OFFER' || (p.to !== 'CANCELLED' && p.to !== 'EXPIRED')) return;
    const found = await s.get(p.sourceId);
    if (!found) return;
    await s.lockNeed(found.needId); // same lock order as accept
    const offer = await s.get(p.sourceId, { forUpdate: true });
    if (offer?.status !== 'ACCEPTED') return;
    const updated = await s.transition(offer, 'CANCELLED', {});
    if (!updated) return;
    await s.addAcceptedQuantity(offer.needId, -offer.quantity);
    const reason = `TRANSACTION_${p.to}`;
    await s.recordStatus(offer.id, 'ACCEPTED', 'CANCELLED', reason, p.actorId);
    await s.outbox(this.statusChanged(updated, 'ACCEPTED', reason, eventCtx(e)));
  }

  async onContentModerated(
    s: OfferStore,
    p: z.output<(typeof ModerationEvents)['ContentModerated']['schema']>,
  ): Promise<void> {
    if (p.targetType !== 'OFFER') return;
    await s.setHidden(p.targetId, p.action === 'HIDE');
  }

  // ---------------------------------------------------------------- helpers

  private async partyOrNotFound(
    offerId: string,
    actorId: string,
  ): Promise<{ party: Party; needId: string }> {
    const offer = await this.uow.store.get(offerId);
    const party = offer ? partyOf(offer, actorId) : null;
    if (!offer || !party) throw Errors.notFound('Offer');
    return { party, needId: offer.needId };
  }

  private async mustGet(s: OfferStore, offerId: string, forUpdate: boolean): Promise<Offer> {
    const offer = await s.get(offerId, { forUpdate });
    if (!offer) throw Errors.notFound('Offer');
    return offer;
  }

  private async expire(
    s: OfferStore,
    offer: Offer,
    reason: string,
    ctx?: EventCtx,
  ): Promise<boolean> {
    if (!isLive(offer.status)) return false;
    const updated = await s.transition(offer, 'EXPIRED', {});
    if (!updated) return false;
    await s.recordStatus(offer.id, offer.status, 'EXPIRED', reason, null);
    await s.outbox(this.statusChanged(updated, offer.status, reason, ctx));
    return true;
  }

  private statusChanged(offer: Offer, from: OfferStatus, reason: string, ctx?: EventCtx) {
    return this.event(
      OfferEvents.OfferStatusChanged,
      offer.id,
      {
        offerId: offer.id,
        needId: offer.needId,
        buyerId: offer.buyerId,
        sellerId: offer.sellerId,
        from,
        to: offer.status,
        reason,
      },
      ctx,
    );
  }

  private async detail(s: OfferStore, offer: Offer, party: Party, now: Date): Promise<OfferDetail> {
    const rounds = await s.rounds(offer.id);
    return {
      offer: redact(offer),
      actions: availableActions(offer, party, now, this.settings),
      sellerName: null,
      rounds: offer.hidden ? rounds.map((r) => ({ ...r, message: null })) : rounds,
    };
  }
}
