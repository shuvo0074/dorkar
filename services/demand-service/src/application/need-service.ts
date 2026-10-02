import {
  DemandEvents,
  type Condition,
  type District,
  type EventEnvelope,
  type NeedMode,
  type NeedStatus,
} from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Cursor,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import {
  assertBudget,
  assertCategoryAllows,
  assertNoContactInfo,
  assertNoContactInfoDeep,
  assertNoMaterialChange,
  assertOpenNeedLimit,
  assertRequiredByNotPast,
  EDITABLE_STATUSES,
  effectiveTtlDays,
  expiryFrom,
  parseAttributes,
  parseModeTerms,
  type DeliveryPreference,
  type Need,
  type NeedPolicy,
  type Visibility,
} from '../domain/need';
import { canTransition, transition, type NeedAction } from '../domain/need-state-machine';
import type {
  FeedFilter,
  HistoryEntry,
  NeedEdit,
  NeedStore,
  NeedUnitOfWork,
  TransitionChanges,
  VerificationGateway,
} from './ports';

type EventFactory = ServiceRuntime<never>['event'];
/** The actor travels along so policy checks can use the caller's roles. */
type Ctx = Pick<RequestContext, 'requestId' | 'correlationId'> & {
  actor?: RequestContext['actor'] | undefined;
};

export interface NeedInput {
  mode: NeedMode;
  categoryId: string;
  title: string;
  description?: string | null | undefined;
  quantity: number;
  budget?:
    | {
        min?: number | null | undefined;
        max?: number | null | undefined;
        flexible?: boolean | undefined;
      }
    | null
    | undefined;
  conditions?: Condition[] | undefined;
  attributes?: Record<string, unknown> | undefined;
  modeTerms?: Record<string, unknown> | undefined;
  district: District;
  area?: string | null | undefined;
  deliveryPref?: DeliveryPreference | undefined;
  requiredBy?: string | null | undefined;
  expiresInDays?: number | undefined;
  visibility?: Visibility | undefined;
}

export type NeedPatch = Partial<Omit<NeedInput, 'expiresInDays'>>;

export interface NeedView {
  need: Need;
  isOwner: boolean;
  history: HistoryEntry[] | null;
}

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const concurrentChange = () =>
  Errors.conflict('This need was changed at the same time. Reload and try again.');

/** Context for work triggered by another service's event. */
export const eventContext = (e: EventEnvelope): Ctx => ({
  requestId: e.id,
  correlationId: e.correlationId ?? e.id,
});

/**
 * Need use cases. Every state change runs in one transaction with its history row and outbox
 * events; transitions are decided by the domain state machine and persisted with a guard.
 */
export class NeedService {
  constructor(
    private readonly uow: NeedUnitOfWork,
    private readonly event: EventFactory,
    private readonly policy: NeedPolicy,
    private readonly verification: VerificationGateway,
  ) {}

  // ------------------------------------------------------------------ owner commands

  async create(input: NeedInput & { publish?: boolean }, ctx: RequestContext): Promise<NeedView> {
    const actor = requireActor(ctx);
    const now = await this.uow.store.now();
    const draft = await this.validate(this.uow.store, input, now);
    if (input.publish) await this.checkVerification(actor.id, draft, ctx);

    const need = await this.uow.transaction(async (s) => {
      let n = await s.insert({
        ...draft,
        id: uuidv7(),
        requesterId: actor.id,
        ttlDays: input.expiresInDays ?? null,
        maxOffers: this.policy.maxOffers,
      });
      await s.appendHistory(n.id, {
        from: null,
        to: 'DRAFT',
        actorId: actor.id,
        reason: 'CREATED',
      });
      if (input.publish) n = await this.publishIn(s, n, actor.id, ctx);
      return n;
    });
    return { need, isOwner: true, history: await this.uow.store.history(need.id) };
  }

  async update(id: string, patch: NeedPatch, ctx: RequestContext): Promise<NeedView> {
    const actor = requireActor(ctx);
    const need = await this.uow.transaction(async (s) => {
      const cur = await this.owned(s, id, actor.id, true);
      if (!EDITABLE_STATUSES.includes(cur.status)) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          `A ${cur.status.toLowerCase()} need cannot be edited.`,
          {
            from: cur.status,
            action: 'edit',
          },
        );
      }
      const merged: NeedInput = {
        mode: patch.mode ?? cur.mode,
        categoryId: patch.categoryId ?? cur.categoryId,
        title: patch.title ?? cur.title,
        description: patch.description !== undefined ? patch.description : cur.description,
        quantity: patch.quantity ?? cur.quantity,
        budget: {
          min: patch.budget !== undefined ? (patch.budget?.min ?? null) : cur.budgetMin,
          max: patch.budget !== undefined ? (patch.budget?.max ?? null) : cur.budgetMax,
          flexible:
            patch.budget !== undefined ? (patch.budget?.flexible ?? false) : cur.budgetFlexible,
        },
        conditions: patch.conditions ?? cur.conditions,
        attributes: patch.attributes ?? cur.attributes,
        modeTerms: patch.modeTerms ?? cur.modeTerms,
        district: patch.district ?? cur.district,
        area: patch.area !== undefined ? patch.area : cur.area,
        deliveryPref: patch.deliveryPref ?? cur.deliveryPref,
        requiredBy: patch.requiredBy !== undefined ? patch.requiredBy : cur.requiredBy,
        visibility: patch.visibility ?? cur.visibility,
      };
      assertNoMaterialChange(cur, merged);
      const now = await s.now();
      const edit = await this.validate(s, merged, now, cur.requiredBy);
      let n = await s.update(cur.id, cur.version, edit);
      if (!n) throw concurrentChange();
      if (n.status === 'OPEN') {
        await s.outbox(this.event(DemandEvents.NeedUpdated, n.id, this.facts(n), ctx));
        if (n.acceptedQuantity > 0 && n.acceptedQuantity >= n.quantity) {
          n = await this.apply(s, n, 'fulfil', actor.id, 'ACCEPTED_QUANTITY_REACHED', ctx);
        }
      }
      return n;
    });
    return this.ownerView(need);
  }

  async publish(id: string, ctx: RequestContext): Promise<NeedView> {
    const actor = requireActor(ctx);
    const cur = await this.owned(this.uow.store, id, actor.id);
    if (!canTransition(cur.status, 'publish')) this.refuse(cur.status, 'publish');
    // Re-validate: the category or its schema may have changed since the draft was saved.
    const now = await this.uow.store.now();
    await this.validate(this.uow.store, this.asInput(cur), now);
    await this.checkVerification(actor.id, cur, ctx);
    const need = await this.uow.transaction((s) => this.publishIn(s, cur, actor.id, ctx));
    return this.ownerView(need);
  }

  pause(id: string, ctx: RequestContext) {
    return this.ownerTransition(id, 'pause', 'PAUSED_BY_OWNER', ctx);
  }

  resume(id: string, ctx: RequestContext) {
    return this.ownerTransition(id, 'resume', 'RESUMED_BY_OWNER', ctx);
  }

  close(id: string, ctx: RequestContext) {
    return this.ownerTransition(id, 'close', 'CLOSED_BY_OWNER', ctx);
  }

  async renew(id: string, ctx: RequestContext): Promise<NeedView> {
    const actor = requireActor(ctx);
    const need = await this.uow.transaction(async (s) => {
      const cur = await this.owned(s, id, actor.id);
      if (!canTransition(cur.status, 'renew')) this.refuse(cur.status, 'renew');
      assertCategoryAllows(await s.category(cur.categoryId), cur.mode);
      await s.lockRequester(actor.id);
      assertOpenNeedLimit(await s.countActive(actor.id), this.policy);
      return this.apply(s, cur, 'renew', actor.id, 'RENEWED_BY_OWNER', ctx);
    });
    return this.ownerView(need);
  }

  // ------------------------------------------------------------------ moderation

  async moderate(
    id: string,
    action: 'hide' | 'restore',
    reason: string,
    ctx: RequestContext,
  ): Promise<Need> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const cur = await s.get(id);
      if (!cur) throw Errors.notFound('Need');
      const n = await this.apply(s, cur, action, actor.id, `MODERATION: ${reason}`, ctx);
      await s.audit(ctx, {
        action: action === 'hide' ? 'need.hidden' : 'need.restored',
        actorType: 'ADMIN',
        targetType: 'NEED',
        targetId: id,
        metadata: { from: cur.status, to: n.status },
      });
      return n;
    });
  }

  /** ModerationEvents.ContentModerated (inbox transaction). Idempotent: no-op if already applied. */
  async onContentModerated(
    s: NeedStore,
    p: { targetId: string; action: 'HIDE' | 'RESTORE'; reason: string; moderatorId: string },
    ctx: Ctx,
  ): Promise<void> {
    const cur = await s.getForUpdate(p.targetId);
    const action: NeedAction = p.action === 'HIDE' ? 'hide' : 'restore';
    if (!cur || !canTransition(cur.status, action)) return;
    await this.apply(s, cur, action, p.moderatorId, `MODERATION: ${p.reason}`, ctx);
  }

  // ------------------------------------------------------------------ queries

  async get(id: string, ctx: RequestContext): Promise<NeedView> {
    const need = await this.uow.store.get(id);
    if (!need) throw Errors.notFound('Need');
    const viewer = ctx.actor?.id ?? null;
    if (viewer === need.requesterId) return this.ownerView(need);
    if (need.status === 'DRAFT' || need.status === 'HIDDEN') throw Errors.notFound('Need');
    if (
      need.visibility === 'MATCHED_ONLY' &&
      !(viewer && (await this.uow.store.isMatched(need.id, viewer)))
    ) {
      throw Errors.notFound('Need');
    }
    return { need, isOwner: false, history: null };
  }

  feed(f: FeedFilter, cursor: Cursor | null, limit: number): Promise<Need[]> {
    return this.uow.store.feed(f, cursor, limit);
  }

  mine(
    status: NeedStatus | undefined,
    cursor: Cursor | null,
    limit: number,
    ctx: RequestContext,
  ): Promise<Need[]> {
    return this.uow.store.listByRequester(requireActor(ctx).id, status, cursor, limit);
  }

  /** Facts for other services (offer validation). Any status; callers decide. */
  async internalFacts(id: string): Promise<Need> {
    const need = await this.uow.store.get(id);
    if (!need) throw Errors.notFound('Need');
    return need;
  }

  // ------------------------------------------------------------------ jobs

  /** Expires due OPEN/PAUSED needs (one batch). Runs inside the job's transaction. */
  async expireDue(s: NeedStore, batchSize: number): Promise<number> {
    const due = await s.dueForExpiry(batchSize);
    const ctx = { requestId: uuidv7(), correlationId: uuidv7() };
    let n = 0;
    for (const need of due) {
      await this.apply(s, need, 'expire', null, 'EXPIRED', ctx);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ projections (inbox transaction)

  async onOfferSubmitted(s: NeedStore, needId: string): Promise<void> {
    await s.incrementOfferCount(needId);
  }

  async onOfferAccepted(
    s: NeedStore,
    p: { offerId: string; needId: string; quantity: number },
    ctx: Ctx,
  ): Promise<void> {
    if (!(await s.addAcceptedOffer(p.offerId, p.needId, p.quantity))) return;
    const need = await s.adjustAcceptedQuantity(p.needId, p.quantity);
    if (need && need.status === 'OPEN' && need.acceptedQuantity >= need.quantity) {
      await this.apply(s, need, 'fulfil', null, 'ACCEPTED_QUANTITY_REACHED', ctx);
    }
  }

  async onOfferCancelled(s: NeedStore, offerId: string, ctx: Ctx): Promise<void> {
    const cancelled = await s.cancelAcceptedOffer(offerId);
    if (!cancelled) return;
    const need = await s.adjustAcceptedQuantity(cancelled.needId, -cancelled.quantity);
    if (need && need.status === 'FULFILLING' && need.acceptedQuantity < need.quantity) {
      await this.apply(s, need, 'reopen', null, 'ACCEPTED_OFFER_CANCELLED', ctx);
    }
  }

  async onTransactionCompleted(s: NeedStore, offerId: string, ctx: Ctx): Promise<void> {
    const needId = await s.completeAcceptedOffer(offerId);
    if (!needId) return;
    const need = await s.getForUpdate(needId);
    if (
      need &&
      need.status === 'FULFILLING' &&
      need.acceptedQuantity >= need.quantity &&
      (await s.allAcceptedOffersCompleted(needId))
    ) {
      await this.apply(s, need, 'complete', null, 'ALL_TRANSACTIONS_COMPLETED', ctx);
    }
  }

  // ------------------------------------------------------------------ internals

  private async ownerTransition(
    id: string,
    action: 'pause' | 'resume' | 'close',
    reason: string,
    ctx: RequestContext,
  ): Promise<NeedView> {
    const actor = requireActor(ctx);
    const need = await this.uow.transaction(async (s) => {
      const cur = await this.owned(s, id, actor.id);
      return this.apply(s, cur, action, actor.id, reason, ctx);
    });
    return this.ownerView(need);
  }

  private async publishIn(s: NeedStore, need: Need, actorId: string, ctx: Ctx): Promise<Need> {
    await s.lockRequester(need.requesterId);
    assertOpenNeedLimit(await s.countActive(need.requesterId), this.policy);
    return this.apply(s, need, 'publish', actorId, 'PUBLISHED_BY_OWNER', ctx);
  }

  /**
   * Decides the transition, persists it with a status/version guard, appends history and emits
   * NeedStatusChanged (+ NeedPublished when the need becomes OPEN).
   */
  private async apply(
    s: NeedStore,
    need: Need,
    action: NeedAction,
    actorId: string | null,
    reason: string,
    ctx: Ctx,
  ): Promise<Need> {
    const now = await s.now();
    const to = transition(need.status, action, {
      now,
      expiresAt: need.expiresAt,
      renewals: need.renewals,
      maxRenewals: this.policy.maxRenewals,
      statusBeforeHidden: need.statusBeforeHidden,
    });
    const changes: TransitionChanges = {};
    if (action === 'publish' || action === 'renew') {
      changes.expiresAt = expiryFrom(now, effectiveTtlDays(need.ttlDays, this.policy));
      changes.publishedAt = now;
      if (action === 'renew') changes.renewals = need.renewals + 1;
    }
    if (action === 'hide') changes.statusBeforeHidden = need.status;
    if (action === 'restore') changes.statusBeforeHidden = null;

    const next = await s.setStatus(need.id, need.status, need.version, to, changes);
    if (!next) throw concurrentChange();
    await s.appendHistory(need.id, { from: need.status, to, actorId, reason });
    const events: EventEnvelope<unknown>[] = [
      this.event(
        DemandEvents.NeedStatusChanged,
        need.id,
        { needId: need.id, requesterId: need.requesterId, from: need.status, to, reason },
        ctx,
      ),
    ];
    if (to === 'OPEN')
      events.push(this.event(DemandEvents.NeedPublished, need.id, this.facts(next), ctx));
    await s.outbox(events);
    // Offers accepted while it was paused or hidden may already cover the quantity.
    if (to === 'OPEN' && next.acceptedQuantity > 0 && next.acceptedQuantity >= next.quantity) {
      return this.apply(s, next, 'fulfil', null, 'ACCEPTED_QUANTITY_REACHED', ctx);
    }
    return next;
  }

  /** Validates and normalizes user-provided need content against the category and mode. */
  private async validate(
    s: NeedStore,
    input: NeedInput,
    now: Date,
    previousRequiredBy: string | null = null,
  ): Promise<NeedEdit> {
    assertNoContactInfo('title', input.title);
    assertNoContactInfo('description', input.description);
    assertNoContactInfo('area', input.area);
    const category = assertCategoryAllows(await s.category(input.categoryId), input.mode);
    const attributes = parseAttributes(category.attributeSchema, input.attributes);
    const modeTerms = parseModeTerms(input.mode, input.modeTerms);
    assertNoContactInfoDeep('details', attributes);
    assertNoContactInfoDeep('terms', modeTerms);
    const budgetMin = input.budget?.min ?? null;
    const budgetMax = input.budget?.max ?? null;
    assertBudget(budgetMin, budgetMax);
    const requiredBy = input.requiredBy ?? null;
    // An unchanged date on an edit is fine even if it has since passed.
    if (requiredBy !== previousRequiredBy) assertRequiredByNotPast(requiredBy, now);
    return {
      mode: input.mode,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description ?? null,
      quantity: input.quantity,
      budgetMin,
      budgetMax,
      budgetFlexible: input.budget?.flexible ?? false,
      conditions: [...new Set(input.conditions ?? [])],
      attributes,
      modeTerms,
      district: input.district,
      area: input.area ?? null,
      deliveryPref: input.deliveryPref ?? 'EITHER',
      requiredBy,
      visibility: input.visibility ?? 'PUBLIC',
    };
  }

  private asInput(n: Need): NeedInput {
    return {
      mode: n.mode,
      categoryId: n.categoryId,
      title: n.title,
      description: n.description,
      quantity: n.quantity,
      budget: { min: n.budgetMin, max: n.budgetMax, flexible: n.budgetFlexible },
      conditions: n.conditions,
      attributes: n.attributes,
      modeTerms: n.modeTerms,
      district: n.district,
      area: n.area,
      deliveryPref: n.deliveryPref,
      // Publishing a draft whose date has passed is refused.
      requiredBy: n.requiredBy,
      visibility: n.visibility,
    };
  }

  private async checkVerification(
    accountId: string,
    n: Pick<Need, 'categoryId' | 'mode' | 'budgetMax'>,
    ctx: Ctx,
  ): Promise<void> {
    const r = await this.verification.evaluate(
      {
        accountId,
        action: 'NEED_PUBLISH',
        categoryId: n.categoryId,
        mode: n.mode,
        amount: n.budgetMax,
      },
      ctx,
    );
    if (!r.satisfied) {
      throw new AppError('VERIFICATION_REQUIRED', 'Verify your account to post this need.', {
        missing: r.missing,
      });
    }
  }

  private async owned(s: NeedStore, id: string, ownerId: string, lock = false): Promise<Need> {
    const need = lock ? await s.getForUpdate(id) : await s.get(id);
    // Someone else's need is indistinguishable from a missing one (no IDOR leaks).
    if (!need || need.requesterId !== ownerId) throw Errors.notFound('Need');
    return need;
  }

  private refuse(from: NeedStatus, action: NeedAction): never {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `A ${from.toLowerCase()} need cannot ${action}.`,
      {
        from,
        action,
      },
    );
  }

  private async ownerView(need: Need): Promise<NeedView> {
    return { need, isOwner: true, history: await this.uow.store.history(need.id) };
  }

  private facts(n: Need) {
    const money = (amount: number | null) =>
      amount === null ? null : { amount, currency: 'BDT' as const };
    return {
      needId: n.id,
      requesterId: n.requesterId,
      mode: n.mode,
      categoryId: n.categoryId,
      title: n.title,
      quantity: n.quantity,
      budgetMin: money(n.budgetMin),
      budgetMax: money(n.budgetMax),
      conditions: n.conditions,
      district: n.district,
      attributes: n.attributes,
      requiredBy: n.requiredBy,
      expiresAt: (n.expiresAt ?? new Date()).toISOString(),
      maxOffers: n.maxOffers,
    };
  }
}
