import {
  CatalogEvents,
  type EventEnvelope,
  type NeedMode,
  type TransactionState,
} from '@dorkar/contracts';
import {
  AppError,
  Errors,
  paginate,
  uuidv7,
  type Cursor,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Category } from '../domain/category';
import {
  assertCategoryAccepts,
  assertContentRules,
  assertPublishable,
  availabilityEffect,
  canTransition,
  CONSUMING_STATE,
  consumesStock,
  EditableStatuses,
  planRelease,
  planReserve,
  RELEASING_STATES,
  transition,
  validateDraftAttributes,
  type Listing,
  type ListingAction,
  type ListingContent,
  type ListingStatus,
  type OwnerAction,
  type StockPlan,
} from '../domain/listing';
import type { CatalogStore, CatalogUnitOfWork, ListingSearch, VerificationGateway } from './ports';

type Ctx = Pick<RequestContext, 'requestId' | 'correlationId' | 'ipHash' | 'actor'>;

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

export type ListingInput = Omit<ListingContent, 'attributes'> & { attributes: unknown };
export type ListingPatch = { [K in keyof ListingInput]?: ListingInput[K] | undefined };

/** Drop keys the client did not send (so they do not overwrite current values). */
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const listingFacts = (l: Listing) => ({
  listingId: l.id,
  sellerId: l.sellerId,
  categoryId: l.categoryId,
  kind: l.kind,
  condition: l.condition,
  title: l.title,
  price: l.price,
  priceUnit: l.priceUnit,
  quantityAvailable: l.quantityAvailable,
  district: l.district,
  attributes: l.attributes,
  deliveryModes: l.deliveryModes,
});

const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

const eventCtx = (e: EventEnvelope): Ctx => ({
  requestId: e.id,
  correlationId: e.correlationId ?? e.id,
  ipHash: null,
  actor: null,
});

const SYSTEM = { actorId: null, actorType: 'SYSTEM' as const };

/** Listing use cases: drafts, publishing, owner/moderator transitions, public search. */
export class ListingService {
  constructor(
    private readonly uow: CatalogUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
  ) {}

  // ------------------------------------------------------------ owner

  async create(input: ListingInput, ctx: RequestContext): Promise<Listing> {
    const actor = requireActor(ctx);
    const category = await this.requireCategory(this.uow.store, input.categoryId);
    assertCategoryAccepts(category, input.kind);
    const content = this.normalize(input, category);
    assertContentRules(content);
    return this.uow.transaction(async (s) => {
      const l = await s.insertListing({ id: uuidv7(), sellerId: actor.id, ...content });
      await s.appendHistory({
        listingId: l.id,
        from: null,
        to: 'DRAFT',
        actorId: actor.id,
        actorType: 'USER',
        reason: null,
      });
      return l;
    });
  }

  async update(id: string, patch: ListingPatch, ctx: RequestContext): Promise<Listing> {
    const actor = requireActor(ctx);
    const current = await this.uow.store.ownedListing(id, actor.id);
    if (!current) throw Errors.notFound('Listing');
    if (!EditableStatuses.includes(current.status)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `A ${current.status.toLowerCase().replace('_', ' ')} listing cannot be edited.`,
        { from: current.status, action: 'edit' },
      );
    }
    const category = await this.requireCategory(
      this.uow.store,
      patch.categoryId ?? current.categoryId,
    );
    const content = this.normalize({ ...current, ...defined(patch) }, category);
    if (current.status === 'DRAFT') {
      assertCategoryAccepts(category, content.kind);
      assertContentRules(content);
    } else {
      // Live (or paused) listings must stay publishable after every edit.
      assertPublishable(content, category);
      if (current.status === 'PUBLISHED') await this.assertSellerVerified(actor.id, content, ctx);
    }

    return this.uow.transaction(async (s) => {
      const l = await s.updateListingContent(
        id,
        { status: current.status, version: current.version },
        content,
      );
      if (!l) throw Errors.conflict('The listing changed meanwhile. Reload and try again.');
      if (l.status === 'PUBLISHED') {
        await s.outbox(this.event(CatalogEvents.ListingUpdated, l.id, listingFacts(l), ctx));
      }
      return l;
    });
  }

  async ownerAction(id: string, action: OwnerAction, ctx: RequestContext): Promise<Listing> {
    const actor = requireActor(ctx);
    const current = await this.uow.store.ownedListing(id, actor.id);
    if (!current) throw Errors.notFound('Listing');
    const t = transition(current, action);
    if (t.to === 'PUBLISHED') {
      // Publishing and resuming re-check everything: the category or policy may have changed.
      const category = await this.requireCategory(this.uow.store, current.categoryId);
      assertPublishable(current, category);
      await this.assertSellerVerified(actor.id, current, ctx);
    }
    return this.uow.transaction((s) =>
      this.apply(s, current, action, ctx, { actorId: actor.id, actorType: 'USER', reason: null }),
    );
  }

  // ------------------------------------------------------------ moderation

  async moderate(
    id: string,
    action: 'hide' | 'restore',
    reason: string,
    ctx: RequestContext,
  ): Promise<Listing> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const current = await s.listing(id);
      if (!current) throw Errors.notFound('Listing');
      const l = await this.apply(s, current, action, ctx, {
        actorId: actor.id,
        actorType: 'ADMIN',
        reason,
      });
      await s.audit(ctx, {
        action: action === 'hide' ? 'listing.hidden' : 'listing.restored',
        actorType: 'ADMIN',
        targetType: 'LISTING',
        targetId: id,
        metadata: { from: current.status, to: l.status, reason },
      });
      return l;
    });
  }

  /** moderation.ContentModerated, inside the inbox transaction. Never throws for stale decisions. */
  async onContentModerated(
    s: CatalogStore,
    p: {
      caseId: string;
      targetId: string;
      action: 'HIDE' | 'RESTORE';
      reason: string;
      moderatorId: string;
    },
    e: EventEnvelope,
  ): Promise<void> {
    const current = await s.listing(p.targetId);
    const action = p.action === 'HIDE' ? 'hide' : 'restore';
    if (!current || !canTransition(current, action)) return; // already applied, withdrawn, or unknown
    const ctx = eventCtx(e);
    const l = await this.apply(s, current, action, ctx, {
      actorId: p.moderatorId,
      actorType: 'ADMIN',
      reason: p.reason,
    });
    await s.audit(ctx, {
      action: action === 'hide' ? 'listing.hidden' : 'listing.restored',
      actorId: p.moderatorId,
      actorType: 'ADMIN',
      targetType: 'LISTING',
      targetId: l.id,
      metadata: { from: current.status, to: l.status, caseId: p.caseId },
    });
  }

  // ------------------------------------------------------------ stock reservations

  /**
   * transaction.TransactionCreated, inside the inbox transaction: a product bought from a
   * listing reserves what is left of the requested quantity (possibly nothing). The listing row
   * is locked, so concurrent deals for the last unit serialize and only one gets it.
   */
  async onTransactionCreated(
    s: CatalogStore,
    p: {
      transactionId: string;
      listingId?: string | null | undefined;
      sellerId: string;
      quantity: number;
      mode: NeedMode;
    },
    e: EventEnvelope,
  ): Promise<void> {
    if (!p.listingId || p.mode !== 'BUY') return;
    const l = await s.listingForUpdate(p.listingId);
    // Unknown listing, someone else's listing, or a kind that has no stock (rental, service).
    if (!l || l.sellerId !== p.sellerId || !consumesStock(l.kind, p.mode)) return;

    const { reserved, plan } = planReserve(l, p.quantity);
    const inserted = await s.insertReservation({
      transactionId: p.transactionId,
      listingId: l.id,
      requestedQuantity: p.quantity,
      quantity: reserved,
    });
    if (!inserted) return; // already reserved for this transaction
    await this.applyStock(s, l, plan, eventCtx(e), `reserved for transaction ${p.transactionId}`);
  }

  /** transaction.TransactionStateChanged: give stock back on cancel/expiry/refund; consume on completion. */
  async onTransactionStateChanged(
    s: CatalogStore,
    p: { transactionId: string; to: TransactionState },
    e: EventEnvelope,
  ): Promise<void> {
    const releasing = (RELEASING_STATES as readonly string[]).includes(p.to);
    if (!releasing && p.to !== CONSUMING_STATE) return;
    const r = await s.reservationForUpdate(p.transactionId);
    if (!r || r.status !== 'ACTIVE') return;
    if (!releasing) {
      await s.setReservationStatus(r.transactionId, 'CONSUMED');
      return;
    }
    await s.setReservationStatus(r.transactionId, 'RELEASED');
    if (r.quantity === 0) return;
    const l = await s.listingForUpdate(r.listingId);
    if (!l) return;
    await this.applyStock(
      s,
      l,
      planRelease(l, r.quantity),
      eventCtx(e),
      `released by transaction ${p.transactionId}`,
    );
  }

  /** Quantity change, then the stock-driven transition or ListingUpdated. Listing is locked. */
  private async applyStock(
    s: CatalogStore,
    current: Listing,
    plan: StockPlan,
    ctx: Ctx,
    reason: string,
  ): Promise<void> {
    if (
      plan.quantity === current.quantityAvailable &&
      plan.hiddenFrom === undefined &&
      plan.stockSoldOut === current.stockSoldOut
    ) {
      return;
    }
    const l = await s.changeStock(current.id, current.version, {
      quantity: plan.quantity,
      hiddenFrom: plan.hiddenFrom,
      stockSoldOut: plan.action ? current.stockSoldOut : plan.stockSoldOut,
    });
    // The row is locked by the caller, so the guard cannot fail short of a bug.
    if (!l) throw Errors.conflict('The listing changed meanwhile.');
    if (plan.action) {
      await this.apply(s, l, plan.action, ctx, { ...SYSTEM, reason });
    } else if (plan.announce) {
      await s.outbox(this.event(CatalogEvents.ListingUpdated, l.id, listingFacts(l), ctx));
    }
  }

  // ------------------------------------------------------------ reads

  /** Public when published; the owner sees their own in any state; everyone else gets 404. */
  async get(id: string, viewerId: string | null): Promise<Listing> {
    const l = await this.uow.store.listing(id);
    if (!l || (l.status !== 'PUBLISHED' && l.sellerId !== viewerId)) {
      throw Errors.notFound('Listing');
    }
    return l;
  }

  async search(s: Omit<ListingSearch, 'limit'> & { limit: number }): Promise<Page<Listing>> {
    if (s.cursor) {
      const numeric = s.sort !== 'newest';
      if ((typeof s.cursor.k === 'number') !== numeric) {
        throw Errors.validation('The cursor does not match the sort order.');
      }
    }
    const rows = await this.uow.store.searchListings({ ...s, limit: s.limit + 1 });
    return paginate(rows, s.limit, (l) => ({
      k: s.sort === 'newest' ? l.publishedAt!.toISOString() : l.price.amount,
      id: l.id,
    }));
  }

  async listMine(
    opts: { status?: ListingStatus | undefined; limit: number; cursor: Cursor | null },
    ctx: RequestContext,
  ): Promise<Page<Listing>> {
    const actor = requireActor(ctx);
    if (opts.cursor && typeof opts.cursor.k !== 'string')
      throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.listingsBySeller(actor.id, {
      ...opts,
      limit: opts.limit + 1,
    });
    return paginate(rows, opts.limit, (l) => ({ k: l.createdAt.toISOString(), id: l.id }));
  }

  // ------------------------------------------------------------ internals

  /** Guarded transition + history + event, in the caller's transaction. */
  private async apply(
    s: CatalogStore,
    current: Listing,
    action: ListingAction,
    ctx: Ctx,
    by: { actorId: string | null; actorType: 'USER' | 'ADMIN' | 'SYSTEM'; reason: string | null },
  ): Promise<Listing> {
    const t = transition(current, action);
    const l = await s.changeStatus({
      id: current.id,
      expectedStatus: current.status,
      expectedVersion: current.version,
      to: t.to,
      hiddenFrom: t.hiddenFrom,
      hiddenReason: t.to === 'HIDDEN' ? by.reason : null,
      stockSoldOut: t.stockSoldOut,
    });
    if (!l) {
      // Someone else moved it first (e.g. a concurrent publish): only one transition may win.
      throw new AppError('INVALID_STATE_TRANSITION', 'The listing changed meanwhile.', {
        from: current.status,
        action,
      });
    }
    await s.appendHistory({ listingId: l.id, from: t.from, to: t.to, ...by });
    const effect = availabilityEffect(t);
    if (effect.kind === 'AVAILABLE') {
      await s.outbox(this.event(CatalogEvents.ListingPublished, l.id, listingFacts(l), ctx));
    } else if (effect.kind === 'UNAVAILABLE') {
      await s.outbox(
        this.event(
          CatalogEvents.ListingUnavailable,
          l.id,
          { listingId: l.id, sellerId: l.sellerId, reason: effect.reason },
          ctx,
        ),
      );
    }
    return l;
  }

  private async requireCategory(s: CatalogStore, id: string): Promise<Category> {
    const c = await s.category(id);
    if (!c) {
      throw new AppError('BUSINESS_RULE_VIOLATION', 'This category does not exist.', {
        rule: 'CATEGORY_NOT_FOUND',
      });
    }
    return c;
  }

  private normalize(input: ListingInput, category: Category): ListingContent {
    return {
      categoryId: input.categoryId,
      kind: input.kind,
      condition: input.condition,
      title: input.title,
      description: input.description,
      price: input.price,
      priceUnit: input.priceUnit,
      quantityAvailable: input.quantityAvailable,
      attributes: validateDraftAttributes(category.attributeSchema, input.attributes),
      district: input.district,
      area: input.area,
      deliveryModes: dedupe(input.deliveryModes),
      mediaIds: dedupe(input.mediaIds),
    };
  }

  private async assertSellerVerified(
    sellerId: string,
    l: Pick<ListingContent, 'categoryId' | 'price'>,
    ctx: RequestContext,
  ): Promise<void> {
    const d = await this.verification.evaluate(
      {
        accountId: sellerId,
        action: 'LISTING_PUBLISH',
        categoryId: l.categoryId,
        amount: l.price.amount,
      },
      ctx,
    );
    if (!d.satisfied) {
      throw new AppError(
        'VERIFICATION_REQUIRED',
        'Verify your account before publishing this listing.',
        { missing: d.missing },
      );
    }
  }
}
