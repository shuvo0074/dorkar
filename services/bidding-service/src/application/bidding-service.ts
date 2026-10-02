import {
  BiddingEvents,
  type AuctionKind,
  type AuctionStatus,
  type CatalogEvents,
  type DemandEvents,
  type EventEnvelope,
  type Money,
  type ModerationEvents,
  type TransactionEvents,
} from '@dorkar/contracts';
import {
  AppError,
  decodeCursor,
  Errors,
  paginate,
  systemContext,
  uuidv7,
  type RateLimiter,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertBidAcceptable,
  availableActions,
  biddingRefusal,
  canSee,
  closeOutcome,
  draftAuction,
  extendedEndsAt,
  isLive,
  NEED_GONE_STATUSES,
  nextBidBound,
  reserveMet,
  retractRefusal,
  transition,
  type Auction,
  type AuctionAction,
  type AuctionActor,
  type AuctionCommand,
  type Bid,
  type BidStatus,
  type CreateAuctionInput,
  type Viewer,
} from '../domain/auction';
import type {
  AuctionStore,
  AuctionUnitOfWork,
  MyBid,
  StatusHistoryEntry,
  VerificationGateway,
} from './ports';

export interface BiddingSettings {
  retractWindowSeconds: number;
  defaultAntiSnipeSeconds: number;
  maxDurationDays: number;
  /** Bids per bidder per auction per minute. */
  bidsPerMinute: number;
}

/** An auction as one caller sees it. */
export interface AuctionView {
  auction: Auction;
  reserveMet: boolean;
  /** The reserve itself: only the owner and staff ever see it. */
  reserveVisible: boolean;
  actions: AuctionAction[];
  myBid: Bid | null;
  /** Bound for the next valid bid, while bidding is possible. */
  nextBid: { minimum: Money; maximum: Money | null } | null;
  /** The winner's account id, shown to the owner, the winner and staff once awarded. */
  winnerId: string | null;
}

/** List row: no per-caller lookups (one query per page). */
export interface AuctionSummary {
  auction: Auction;
  reserveMet: boolean;
  reserveVisible: boolean;
}

export interface BidView {
  bid: Bid;
  isMine: boolean;
}

export interface BidResult {
  bid: Bid;
  auction: AuctionView;
}

export interface AdminAuctionDetail extends AuctionSummary {
  history: StatusHistoryEntry[];
}

type EventCtx = Pick<RequestContext, 'requestId' | 'correlationId'>;
type CatalogPayload<K extends keyof typeof CatalogEvents> = z.output<
  (typeof CatalogEvents)[K]['schema']
>;
type DemandPayload<K extends keyof typeof DemandEvents> = z.output<
  (typeof DemandEvents)[K]['schema']
>;

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

export const viewerOf = (ctx: RequestContext): Viewer => ({
  id: ctx.actor?.id ?? null,
  isStaff:
    !!ctx.actor &&
    (ctx.actor.permissions.has('auction:manage') ||
      ctx.actor.permissions.has('moderation:case:read')),
  canManage: !!ctx.actor?.permissions.has('auction:manage'),
  canBid: !!ctx.actor?.permissions.has('bid:create'),
});

const eventCtx = (e: EventEnvelope): RequestContext => ({
  ...systemContext(e.id),
  correlationId: e.correlationId ?? e.id,
});

const raced = () =>
  new AppError('INVALID_STATE_TRANSITION', 'This auction just changed. Reload and try again.', {
    reason: 'CONCURRENT_UPDATE',
  });

const iso = (d: Date) => d.toISOString();

/**
 * Auction and bid use cases. Every change writes state, history, outbox and audit in one
 * transaction. Network calls (verification) happen before the transaction opens, so the auction
 * row lock is held only for local work.
 */
export class BiddingService {
  constructor(
    private readonly uow: AuctionUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
    private readonly limiter: RateLimiter,
    private readonly settings: BiddingSettings,
  ) {}

  // ---------------------------------------------------------------- auctions

  async create(input: CreateAuctionInput, ctx: RequestContext): Promise<AuctionView> {
    const actor = requireActor(ctx);
    const subject = async (s: AuctionStore) =>
      input.kind === 'FORWARD'
        ? { listing: await s.listing(input.subjectId), need: null }
        : { listing: null, need: await s.need(input.subjectId) };

    // Cheap checks first, so an invalid request never costs a verification round-trip.
    const draft = draftAuction(
      actor.id,
      input,
      await subject(this.uow.store),
      await this.uow.store.now(),
      this.settings,
    );
    await this.requireVerified(
      'AUCTION_CREATE',
      actor.id,
      draft.categoryId,
      draft.mode,
      draft.startPrice.amount,
      ctx,
    );

    return this.uow.transaction(async (s) => {
      const now = await s.now();
      // Re-validate against the latest projection and clock.
      const d = draftAuction(actor.id, input, await subject(s), now, this.settings);
      const id = uuidv7();
      let auction = await s.insert({ ...d, id, ownerId: actor.id, status: 'SCHEDULED' });
      await s.recordStatus(id, null, 'SCHEDULED', 'CREATED', actor.id);
      if (auction.startsAt.getTime() <= now.getTime()) {
        auction = await this.open(s, auction, now, ctx);
      }
      await s.audit(ctx, {
        action: 'auction.create',
        targetType: 'AUCTION',
        targetId: id,
        metadata: { kind: d.kind, subjectType: d.subjectType, subjectId: d.subjectId },
      });
      return this.view(s, auction, viewerOf(ctx), now);
    });
  }

  /** Owner cancel: SCHEDULED any time, OPEN only without bids. */
  async cancel(
    auctionId: string,
    reason: string | null,
    ctx: RequestContext,
  ): Promise<AuctionView> {
    const actor = requireActor(ctx);
    const viewer = viewerOf(ctx);
    const pre = await this.visible(auctionId, viewer);
    if (pre.ownerId !== actor.id) throw Errors.forbidden('Only the owner can cancel this auction.');
    return this.uow.transaction(async (s) => {
      const a = await this.lock(s, auctionId);
      const now = await s.now();
      const updated = await this.cancelLocked(s, a, now, 'CANCEL', 'OWNER', {
        reason: reason ?? 'CANCELLED_BY_OWNER',
        actorId: actor.id,
        ctx,
      });
      await s.audit(ctx, {
        action: 'auction.cancel',
        targetType: 'AUCTION',
        targetId: auctionId,
        metadata: { from: a.status },
      });
      return this.view(s, updated, viewer, now);
    });
  }

  /** Staff cancel of any live auction, with a reason. */
  async adminCancel(auctionId: string, reason: string, ctx: RequestContext): Promise<AuctionView> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const a = await this.lock(s, auctionId);
      const now = await s.now();
      const updated = await this.cancelLocked(s, a, now, 'ADMIN_CANCEL', 'ADMIN', {
        reason,
        actorId: actor.id,
        ctx,
      });
      await s.audit(ctx, {
        action: 'auction.admin_cancel',
        actorType: 'ADMIN',
        targetType: 'AUCTION',
        targetId: auctionId,
        metadata: { from: a.status, bidCount: a.bidCount },
      });
      return this.view(s, updated, viewerOf(ctx), now);
    });
  }

  // ---------------------------------------------------------------- bids

  /** Sliding-window limit per bidder per auction. Checked before the Idempotency-Key claim. */
  async assertBidRate(auctionId: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    const r = await this.limiter.consume([
      { key: `bid:${actor.id}:${auctionId}`, limit: this.settings.bidsPerMinute, windowMs: 60_000 },
    ]);
    if (!r.allowed) throw Errors.rateLimited(r.retryAfterMs);
  }

  /**
   * Atomic bid placement (03-lifecycles §3): the auction row is locked FOR UPDATE, every rule is
   * checked against values read under the lock and the DB clock, and the bid, the previous
   * leader's OUTBID, the auction's leader/deadline and the events commit together.
   */
  async placeBid(
    auctionId: string,
    input: { amount: Money; idempotencyKey: string | null },
    ctx: RequestContext,
  ): Promise<BidResult> {
    const actor = requireActor(ctx);
    const viewer = viewerOf(ctx);
    const pre = await this.visible(auctionId, viewer);
    // Cheap pre-checks (re-checked under the lock) before the verification round-trip.
    const closed = biddingRefusal(pre, await this.uow.store.now());
    if (closed) throw closed;
    if (pre.ownerId === actor.id) {
      throw new AppError('BUSINESS_RULE_VIOLATION', 'You cannot bid on your own auction.', {
        rule: 'OWN_AUCTION',
      });
    }
    await this.requireVerified(
      'BID_PLACE',
      actor.id,
      pre.categoryId,
      pre.mode,
      input.amount.amount,
      ctx,
    );

    return this.uow.transaction(async (s) => {
      const a = await this.lock(s, auctionId);
      if (!canSee(a, viewer)) throw Errors.notFound('Auction');
      if (input.idempotencyKey) {
        const existing = await s.bidByKey(a.id, actor.id, input.idempotencyKey);
        if (existing)
          return { bid: existing, auction: await this.view(s, a, viewer, await s.now()) };
      }
      const now = await s.now();
      const leader = a.leadingBidId ? await s.getBid(a.leadingBidId) : null;
      assertBidAcceptable({
        auction: a,
        leaderId: leader?.bidderId ?? null,
        bidderId: actor.id,
        amount: input.amount,
        now,
      });

      // Demote first: the one-LEADING-per-auction index must hold at every statement.
      if (leader && !(await s.setBidStatus(leader.id, 'LEADING', 'OUTBID'))) throw raced();
      await s.ensureBidder(a.id, actor.id);
      const bid = await s.insertBid({
        id: uuidv7(),
        auctionId: a.id,
        bidderId: actor.id,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        placedAt: now,
      });
      if (!bid) throw raced();
      const endsAt = extendedEndsAt(a.endsAt, now, a.antiSnipeSeconds);
      const updated = await s.update(a, 'OPEN', {
        leadingBidId: bid.id,
        leadingAmount: input.amount,
        bidCount: a.bidCount + 1,
        endsAt,
      });
      if (!updated) throw raced();

      await s.outbox([
        this.event(
          BiddingEvents.BidPlaced,
          a.id,
          {
            auctionId: a.id,
            bidId: bid.id,
            bidderId: actor.id,
            ownerId: a.ownerId,
            amount: input.amount,
            endsAt: iso(endsAt),
          },
          ctx,
        ),
        ...(leader
          ? [
              this.event(
                BiddingEvents.BidOutbid,
                a.id,
                {
                  auctionId: a.id,
                  bidId: leader.id,
                  bidderId: leader.bidderId,
                  leadingAmount: input.amount,
                },
                ctx,
              ),
            ]
          : []),
      ]);
      await s.audit(ctx, {
        action: 'bid.place',
        targetType: 'AUCTION',
        targetId: a.id,
        metadata: {
          bidId: bid.id,
          amount: input.amount.amount,
          extended: endsAt.getTime() !== a.endsAt.getTime(),
        },
      });
      return { bid, auction: await this.view(s, updated, viewer, now) };
    });
  }

  /**
   * The bidder withdraws a bid shortly after placing it. If it was leading, the best remaining
   * bid leads again.
   */
  async retract(auctionId: string, bidId: string, ctx: RequestContext): Promise<BidResult> {
    const actor = requireActor(ctx);
    const viewer = viewerOf(ctx);
    const pre = await this.uow.store.getBid(bidId);
    if (!pre || pre.auctionId !== auctionId || pre.bidderId !== actor.id) {
      throw Errors.notFound('Bid');
    }
    await this.visible(auctionId, viewer);
    return this.uow.transaction(async (s) => {
      const a = await this.lock(s, auctionId); // same lock order as placement
      const bid = await s.getBid(bidId, { forUpdate: true });
      if (!bid) throw Errors.notFound('Bid');
      const now = await s.now();
      const refused = retractRefusal({
        auction: a,
        bid,
        now,
        windowSeconds: this.settings.retractWindowSeconds,
      });
      if (refused) throw refused;

      const wasLeading = bid.status === 'LEADING';
      if (!(await s.setBidStatus(bid.id, bid.status, 'RETRACTED'))) throw raced();
      let leader: Bid | null = null;
      if (wasLeading) {
        leader = await s.bestRemaining(a.id, a.kind);
        if (leader && !(await s.setBidStatus(leader.id, 'OUTBID', 'LEADING'))) throw raced();
      }
      const updated = await s.update(a, a.status, {
        bidCount: Math.max(0, a.bidCount - 1),
        ...(wasLeading
          ? { leadingBidId: leader?.id ?? null, leadingAmount: leader?.amount ?? null }
          : {}),
      });
      if (!updated) throw raced();
      await s.audit(ctx, {
        action: 'bid.retract',
        targetType: 'AUCTION',
        targetId: a.id,
        metadata: { bidId, wasLeading, restoredBidId: leader?.id ?? null },
      });
      const after = (await s.getBid(bidId))!;
      return { bid: after, auction: await this.view(s, updated, viewer, now) };
    });
  }

  // ---------------------------------------------------------------- queries

  async get(auctionId: string, ctx: RequestContext): Promise<AuctionView> {
    const a = await this.visible(auctionId, viewerOf(ctx));
    return this.view(this.uow.store, a, viewerOf(ctx), await this.uow.store.now());
  }

  async browse(q: {
    status: AuctionStatus;
    kind?: AuctionKind | undefined;
    categoryId?: string | undefined;
    district?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<{ items: AuctionSummary[]; nextCursor: string | null }> {
    const cursor = decodeCursor(q.cursor);
    if (cursor && typeof cursor.k !== 'string') throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.browse({
      status: q.status,
      kind: q.kind,
      categoryId: q.categoryId,
      district: q.district,
      cursor,
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (a) => ({ k: a.endsAt.toISOString(), id: a.id }));
    return { items: page.items.map((a) => summary(a, false)), nextCursor: page.nextCursor };
  }

  async listMine(
    q: { status?: AuctionStatus | undefined; cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: AuctionSummary[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const rows = await this.uow.store.listForOwner(actor.id, {
      status: q.status,
      cursor: timeCursor(q.cursor),
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (a) => ({ k: a.createdAt.toISOString(), id: a.id }));
    return { items: page.items.map((a) => summary(a, true)), nextCursor: page.nextCursor };
  }

  async listAdmin(q: {
    status?: AuctionStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<{ items: AuctionSummary[]; nextCursor: string | null }> {
    const rows = await this.uow.store.listAll({
      status: q.status,
      cursor: timeCursor(q.cursor),
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (a) => ({ k: a.createdAt.toISOString(), id: a.id }));
    return { items: page.items.map((a) => summary(a, true)), nextCursor: page.nextCursor };
  }

  /** Bid history: amounts and times are public; bidders appear only as per-auction aliases. */
  async listBids(
    auctionId: string,
    q: { cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: BidView[]; nextCursor: string | null }> {
    const viewer = viewerOf(ctx);
    await this.visible(auctionId, viewer);
    const rows = await this.uow.store.listBids(auctionId, {
      cursor: seqCursor(q.cursor),
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (b) => ({ k: b.seq, id: b.id }));
    return {
      items: page.items.map((bid) => ({
        bid,
        isMine: viewer.id !== null && bid.bidderId === viewer.id,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async listMyBids(
    q: { status?: BidStatus | undefined; cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: MyBid[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const rows = await this.uow.store.listBidsOf(actor.id, {
      status: q.status,
      cursor: seqCursor(q.cursor),
      take: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (r) => ({ k: r.bid.seq, id: r.bid.id }));
    return { items: page.items, nextCursor: page.nextCursor };
  }

  // ---------------------------------------------------------------- jobs (inside the job trx)

  /** SCHEDULED → OPEN once starts_at has passed (DB clock). */
  async openDue(s: AuctionStore, limit = 200): Promise<number> {
    const due = await s.dueToOpen(limit);
    const now = await s.now();
    const ctx = systemContext(uuidv7());
    for (const a of due) await this.open(s, a, now, ctx);
    return due.length;
  }

  /** OPEN → CLOSING → AWARDED | NO_WINNER once ends_at has passed (DB clock). */
  async closeDue(s: AuctionStore, limit = 200): Promise<number> {
    const due = await s.dueToClose(limit);
    let n = 0;
    for (const a of due) if (await this.close(s, a)) n++;
    return n;
  }

  // ---------------------------------------------------------------- event handlers (inbox trx)

  async onListing(
    s: AuctionStore,
    /** ListingPublished and ListingUpdated share one payload shape. */
    p: CatalogPayload<'ListingPublished'>,
  ): Promise<void> {
    await s.upsertListing({
      listingId: p.listingId,
      sellerId: p.sellerId,
      categoryId: p.categoryId,
      kind: p.kind,
      title: p.title,
      district: p.district,
      price: p.price,
      quantityAvailable: p.quantityAvailable,
      available: p.quantityAvailable > 0,
    });
  }

  async onListingUnavailable(
    s: AuctionStore,
    p: CatalogPayload<'ListingUnavailable'>,
    e: EventEnvelope,
  ): Promise<void> {
    await s.setListingUnavailable(p.listingId);
    await this.subjectGone(s, 'LISTING', p.listingId, `LISTING_${p.reason}`, eventCtx(e));
  }

  async onNeed(
    s: AuctionStore,
    p: DemandPayload<'NeedPublished'>,
    kind: 'PUBLISHED' | 'UPDATED',
  ): Promise<void> {
    await s.upsertNeed(
      {
        needId: p.needId,
        requesterId: p.requesterId,
        mode: p.mode,
        categoryId: p.categoryId,
        title: p.title,
        district: p.district,
        budgetMax: p.budgetMax,
        quantity: p.quantity,
      },
      // NeedPublished always means "became OPEN"; NeedUpdated never changes the status.
      kind === 'PUBLISHED' ? 'OPEN' : undefined,
    );
  }

  async onNeedStatusChanged(
    s: AuctionStore,
    p: DemandPayload<'NeedStatusChanged'>,
    e: EventEnvelope,
  ): Promise<void> {
    await s.setNeedStatus(p.needId, p.to);
    if (!NEED_GONE_STATUSES.includes(p.to)) return;
    await this.subjectGone(s, 'NEED', p.needId, `NEED_${p.to}`, eventCtx(e));
  }

  async onContentModerated(
    s: AuctionStore,
    p: z.output<(typeof ModerationEvents)['ContentModerated']['schema']>,
  ): Promise<void> {
    if (p.targetType !== 'AUCTION') return;
    await s.setHidden(p.targetId, p.action === 'HIDE');
  }

  /** The winner's transaction exists: AWARDED → SETTLED. */
  async onTransactionCreated(
    s: AuctionStore,
    p: z.output<(typeof TransactionEvents)['TransactionCreated']['schema']>,
  ): Promise<void> {
    if (p.sourceType !== 'AUCTION') return;
    const a = await s.get(p.sourceId, { forUpdate: true });
    if (a?.status !== 'AWARDED') return;
    const to = transition({ ...a, now: await s.now() }, 'SETTLE', 'SYSTEM');
    const updated = await s.update(a, to, { transactionId: p.transactionId });
    if (!updated) return;
    await s.recordStatus(a.id, a.status, to, 'TRANSACTION_CREATED', null);
  }

  // ---------------------------------------------------------------- admin

  async getForAdmin(auctionId: string): Promise<AdminAuctionDetail> {
    const a = await this.uow.store.get(auctionId);
    if (!a) throw Errors.notFound('Auction');
    return { ...summary(a, true), history: await this.uow.store.history(auctionId) };
  }

  // ---------------------------------------------------------------- helpers

  private async requireVerified(
    action: 'AUCTION_CREATE' | 'BID_PLACE',
    accountId: string,
    categoryId: string,
    mode: Auction['mode'],
    amount: number,
    ctx: RequestContext,
  ): Promise<void> {
    const decision = await this.verification.evaluate(
      { accountId, action, categoryId, mode, amount },
      ctx,
    );
    if (!decision.satisfied) {
      throw new AppError(
        'VERIFICATION_REQUIRED',
        action === 'BID_PLACE'
          ? 'Verify your account to bid in this category.'
          : 'Verify your account to run auctions in this category.',
        { action, missing: decision.missing },
      );
    }
  }

  /** The auction, or 404 when it does not exist or the caller may not see it (hidden). */
  private async visible(auctionId: string, viewer: Viewer): Promise<Auction> {
    const a = await this.uow.store.get(auctionId);
    if (!a || !canSee(a, viewer)) throw Errors.notFound('Auction');
    return a;
  }

  private async lock(s: AuctionStore, auctionId: string): Promise<Auction> {
    const a = await s.get(auctionId, { forUpdate: true });
    if (!a) throw Errors.notFound('Auction');
    return a;
  }

  private async open(s: AuctionStore, a: Auction, now: Date, ctx: EventCtx): Promise<Auction> {
    const to = transition({ ...a, now }, 'OPEN', 'SYSTEM');
    const updated = await s.update(a, to, {});
    if (!updated) throw raced();
    await s.recordStatus(a.id, a.status, to, 'STARTS_AT_REACHED', null);
    await s.outbox(
      this.event(
        BiddingEvents.AuctionOpened,
        a.id,
        {
          ...facts(updated),
          title: updated.title,
          district: updated.district,
          startPrice: updated.startPrice,
          startsAt: iso(updated.startsAt),
          endsAt: iso(updated.endsAt),
        },
        ctx,
      ),
    );
    return updated;
  }

  private async close(s: AuctionStore, a: Auction): Promise<boolean> {
    const now = await s.now();
    const ctx = systemContext(uuidv7());
    const closingTo = transition({ ...a, now }, 'BEGIN_CLOSE', 'SYSTEM');
    const closing = await s.update(a, closingTo, {});
    if (!closing) return false;
    await s.recordStatus(a.id, a.status, closingTo, 'ENDS_AT_REACHED', null);

    const outcome = closeOutcome({ ...closing, now });
    const to = transition({ ...closing, now }, outcome, 'SYSTEM');
    const closed = await s.update(closing, to, { closedAt: now });
    if (!closed) throw raced();
    const leader = closed.leadingBidId ? await s.getBid(closed.leadingBidId) : null;
    await s.recordStatus(
      a.id,
      closingTo,
      to,
      outcome === 'AWARD' ? 'AWARDED' : leader ? 'RESERVE_NOT_MET' : 'NO_BIDS',
      null,
    );

    const winner = outcome === 'AWARD' ? leader : null;
    if (winner) await s.setBidStatus(winner.id, 'LEADING', 'WON');
    await s.settleBids(a.id, 'LOST', winner?.id ?? null);
    const bidderIds = await s.distinctBidders(a.id);

    await s.outbox(
      this.event(
        BiddingEvents.AuctionClosed,
        a.id,
        {
          ...facts(closed),
          outcome: winner ? 'AWARDED' : 'NO_WINNER',
          winnerId: winner?.bidderId ?? null,
          winningBidId: winner?.id ?? null,
          amount: winner?.amount ?? null,
          bidderIds,
        },
        ctx,
      ),
    );
    if (winner) {
      const forward = closed.kind === 'FORWARD';
      await s.outbox(
        this.event(
          BiddingEvents.AuctionAwarded,
          a.id,
          {
            auctionId: a.id,
            winningBidId: winner.id,
            kind: closed.kind,
            needId: forward ? null : closed.subjectId,
            listingId: forward ? closed.subjectId : null,
            buyerId: forward ? winner.bidderId : closed.ownerId,
            sellerId: forward ? closed.ownerId : winner.bidderId,
            mode: forward ? 'BUY' : closed.mode,
            amount: winner.amount,
            quantity: closed.quantity,
            terms: { auctionKind: closed.kind, quantity: closed.quantity, closedAt: iso(now) },
          },
          ctx,
        ),
      );
    }
    await s.audit(ctx, {
      action: winner ? 'auction.award' : 'auction.close_no_winner',
      actorType: 'SYSTEM',
      targetType: 'AUCTION',
      targetId: a.id,
      metadata: { bidCount: closed.bidCount, winningBidId: winner?.id ?? null },
    });
    return true;
  }

  private async cancelLocked(
    s: AuctionStore,
    a: Auction,
    now: Date,
    command: AuctionCommand,
    actor: AuctionActor,
    o: { reason: string; actorId: string | null; ctx: EventCtx },
  ): Promise<Auction> {
    const to = transition({ ...a, now }, command, actor);
    const updated = await s.update(a, to, { cancelReason: o.reason, closedAt: now });
    if (!updated) throw raced();
    await s.recordStatus(a.id, a.status, to, o.reason, o.actorId);
    await s.settleBids(a.id, 'LOST');
    await s.outbox(
      this.event(
        BiddingEvents.AuctionClosed,
        a.id,
        {
          ...facts(updated),
          outcome: 'CANCELLED',
          winnerId: null,
          winningBidId: null,
          amount: null,
          bidderIds: await s.distinctBidders(a.id),
        },
        o.ctx,
      ),
    );
    return updated;
  }

  private async subjectGone(
    s: AuctionStore,
    subjectType: 'LISTING' | 'NEED',
    subjectId: string,
    reason: string,
    ctx: RequestContext,
  ): Promise<void> {
    const now = await s.now();
    for (const a of await s.liveForSubject(subjectType, subjectId)) {
      if (!isLive(a.status)) continue;
      await this.cancelLocked(s, a, now, 'SUBJECT_GONE', 'SYSTEM', { reason, actorId: null, ctx });
      await s.audit(ctx, {
        action: 'auction.cancel_subject_gone',
        actorType: 'SYSTEM',
        targetType: 'AUCTION',
        targetId: a.id,
        metadata: { reason },
      });
    }
  }

  private async view(s: AuctionStore, a: Auction, viewer: Viewer, now: Date): Promise<AuctionView> {
    const privileged = viewer.isStaff || viewer.id === a.ownerId;
    const [leader, myBid] = await Promise.all([
      a.leadingBidId ? s.getBid(a.leadingBidId) : Promise.resolve(null),
      viewer.id && viewer.id !== a.ownerId ? s.latestBidOf(a.id, viewer.id) : Promise.resolve(null),
    ]);
    const awarded = a.status === 'AWARDED' || a.status === 'SETTLED';
    const winnerId =
      awarded && leader && (privileged || leader.bidderId === viewer.id) ? leader.bidderId : null;
    const myRetractable =
      myBid && (myBid.status === 'LEADING' || myBid.status === 'OUTBID') ? myBid : null;
    const open = biddingRefusal(a, now) === null;
    return {
      auction: a,
      reserveMet: reserveMet(a),
      reserveVisible: privileged,
      actions: availableActions(a, viewer, {
        now,
        leaderId: leader?.bidderId ?? null,
        myRetractable,
        retractWindowSeconds: this.settings.retractWindowSeconds,
      }),
      myBid,
      nextBid: open ? nextBidBound(a) : null,
      winnerId,
    };
  }
}

// ---------------------------------------------------------------- module helpers

const facts = (a: Auction) => ({
  auctionId: a.id,
  kind: a.kind,
  ownerId: a.ownerId,
  subjectType: a.subjectType,
  subjectId: a.subjectId,
  categoryId: a.categoryId,
});

const summary = (a: Auction, reserveVisible: boolean): AuctionSummary => ({
  auction: a,
  reserveMet: reserveMet(a),
  reserveVisible,
});

const timeCursor = (raw: string | undefined) => {
  const c = decodeCursor(raw);
  if (c && (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k)))) {
    throw Errors.validation('Invalid cursor.');
  }
  return c;
};

const seqCursor = (raw: string | undefined) => {
  const c = decodeCursor(raw);
  if (c && (typeof c.k !== 'number' || !Number.isSafeInteger(c.k))) {
    throw Errors.validation('Invalid cursor.');
  }
  return c;
};
