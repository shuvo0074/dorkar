import type { CatalogEvents, ModerationEvents } from '@dorkar/contracts';
import { LendingEvents, type EventEnvelope } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Cursor,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertCategoryLendable,
  assertMaxLoanDays,
  assertNoContactInfo,
  dedupe,
  normalizeRequirements,
  type LenderStats,
  type LendItem,
} from '../domain/lend-item';
import { derivedContext, requireActor } from './context';
import type {
  ItemSearch,
  LendingStore,
  LendingUnitOfWork,
  LendItemPatch,
  NewLendItem,
  VerificationGateway,
} from './ports';

export type CreateItemInput = Omit<NewLendItem, 'id' | 'lenderId'>;

export interface ItemDetail {
  item: LendItem;
  lenderStats: LenderStats;
  viewerIsOwner: boolean;
}

/** The lender's shelf. Every change writes state, audit and LendItemPublished in one transaction. */
export class LendItemService {
  constructor(
    private readonly uow: LendingUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly verification: VerificationGateway,
    private readonly limits: { maxLoanDays: number },
  ) {}

  async create(input: CreateItemInput, ctx: RequestContext): Promise<LendItem> {
    const actor = requireActor(ctx);
    assertNoContactInfo('title', input.title);
    assertNoContactInfo('description', input.description);
    assertMaxLoanDays(input.maxLoanDays, this.limits.maxLoanDays);
    assertCategoryLendable(await this.uow.store.category(input.categoryId));
    await this.assertMayPublish(actor.id, input.categoryId, input.depositAmount, ctx);

    return this.uow.transaction(async (s) => {
      const item = await s.insertItem({
        ...input,
        id: uuidv7(),
        lenderId: actor.id,
        mediaIds: dedupe(input.mediaIds),
        requirements: normalizeRequirements(input.requirements),
      });
      await s.audit(ctx, {
        action: 'lending.item.created',
        targetType: 'lend_item',
        targetId: item.id,
        metadata: { categoryId: item.categoryId },
      });
      await s.outbox(this.published(item, ctx));
      return item;
    });
  }

  async update(id: string, patch: LendItemPatch, ctx: RequestContext): Promise<LendItem> {
    const actor = requireActor(ctx);
    const current = await this.uow.store.item(id);
    if (!current || current.lenderId !== actor.id) throw Errors.notFound('Item');
    assertNoContactInfo('title', patch.title);
    assertNoContactInfo('description', patch.description);
    if (patch.maxLoanDays !== undefined) {
      assertMaxLoanDays(patch.maxLoanDays, this.limits.maxLoanDays);
    }
    const categoryId = patch.categoryId ?? current.categoryId;
    if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
      assertCategoryLendable(await this.uow.store.category(patch.categoryId));
    }
    // Re-listing is publishing again: the same policy applies.
    if (patch.active === true && !current.active) {
      assertCategoryLendable(await this.uow.store.category(categoryId));
      const deposit =
        patch.depositAmount !== undefined ? patch.depositAmount : current.depositAmount;
      await this.assertMayPublish(actor.id, categoryId, deposit, ctx);
    }

    return this.uow.transaction(async (s) => {
      const locked = await s.item(id, { forUpdate: true });
      if (!locked || locked.lenderId !== actor.id) throw Errors.notFound('Item');
      const item = await s.updateItem(id, {
        ...patch,
        ...(patch.mediaIds ? { mediaIds: dedupe(patch.mediaIds) } : {}),
        ...(patch.requirements ? { requirements: normalizeRequirements(patch.requirements) } : {}),
      });
      await s.audit(ctx, {
        action: 'lending.item.updated',
        targetType: 'lend_item',
        targetId: id,
        metadata: { fields: Object.keys(patch).sort() },
      });
      await s.outbox(this.published(item, ctx));
      return item;
    });
  }

  async deactivate(id: string, ctx: RequestContext): Promise<LendItem> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const locked = await s.item(id, { forUpdate: true });
      if (!locked || locked.lenderId !== actor.id) throw Errors.notFound('Item');
      if (!locked.active) return locked;
      const item = await s.updateItem(id, { active: false });
      await s.audit(ctx, {
        action: 'lending.item.deactivated',
        targetType: 'lend_item',
        targetId: id,
      });
      await s.outbox(this.published(item, ctx));
      return item;
    });
  }

  /** Public detail. Hidden items exist only for their owner. */
  async get(id: string, ctx: RequestContext): Promise<ItemDetail> {
    const item = await this.uow.store.item(id);
    const viewerIsOwner = !!item && ctx.actor?.id === item.lenderId;
    if (!item || (item.hidden && !viewerIsOwner)) throw Errors.notFound('Item');
    return { item, lenderStats: await this.uow.store.lenderStats(item.lenderId), viewerIsOwner };
  }

  search(s: ItemSearch): Promise<LendItem[]> {
    return this.uow.store.searchItems(s);
  }

  mine(q: { cursor: Cursor | null; limit: number }, ctx: RequestContext): Promise<LendItem[]> {
    return this.uow.store.itemsOf(requireActor(ctx).id, q);
  }

  // ---- event handlers (inside the inbox transaction)

  async onCategoryUpserted(
    s: LendingStore,
    p: z.output<(typeof CatalogEvents)['CategoryUpserted']['schema']>,
  ): Promise<void> {
    await s.upsertCategory({ categoryId: p.categoryId, modes: p.modes, active: p.active });
  }

  async onContentModerated(
    s: LendingStore,
    p: z.output<(typeof ModerationEvents)['ContentModerated']['schema']>,
    e: EventEnvelope,
  ): Promise<void> {
    if (p.targetType !== 'LEND_ITEM') return;
    const before = await s.item(p.targetId, { forUpdate: true });
    if (!before) return;
    const hidden = p.action === 'HIDE';
    if (before.hidden === hidden) return;
    const item = (await s.setItemHidden(p.targetId, hidden))!;
    const ctx = derivedContext(e.id, e.correlationId);
    await s.audit(ctx, {
      action: hidden ? 'lending.item.hidden' : 'lending.item.restored',
      actorId: p.moderatorId,
      actorType: 'ADMIN',
      targetType: 'lend_item',
      targetId: item.id,
      metadata: { caseId: p.caseId },
    });
    await s.outbox(this.published(item, ctx));
  }

  // ---- helpers

  /** `active` tells consumers whether the item is discoverable (listed and not hidden). */
  private published(item: LendItem, ctx: RequestContext) {
    return this.event(
      LendingEvents.LendItemPublished,
      item.id,
      {
        itemId: item.id,
        lenderId: item.lenderId,
        categoryId: item.categoryId,
        title: item.title,
        district: item.district,
        active: item.active && !item.hidden,
      },
      ctx,
    );
  }

  private async assertMayPublish(
    accountId: string,
    categoryId: string,
    deposit: number | null,
    ctx: RequestContext,
  ): Promise<void> {
    const decision = await this.verification.evaluate(
      {
        accountId,
        action: 'LEND_ITEM_PUBLISH',
        categoryId,
        mode: 'BORROW',
        amount: deposit ?? 0,
      },
      ctx,
    );
    if (!decision.satisfied) {
      throw new AppError('VERIFICATION_REQUIRED', 'Verify your account to lend items here.', {
        action: 'LEND_ITEM_PUBLISH',
        missing: decision.missing,
      });
    }
  }
}
