import { CatalogEvents } from '@dorkar/contracts';
import { AppError, Errors, uuidv7, type RequestContext, type ServiceRuntime } from '@dorkar/kernel';
import {
  assertAttributeSchemaCoherent,
  assertValidParent,
  buildTree,
  categoryUpsertedPayload,
  type Category,
  type CategoryNode,
} from '../domain/category';
import type { CatalogStore, CatalogUnitOfWork, CategoryPatch, NewCategory } from './ports';

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/** Category tree use cases. Admin changes write the row, an audit record and the event together. */
export class CategoryService {
  constructor(
    private readonly uow: CatalogUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
  ) {}

  async tree(): Promise<CategoryNode[]> {
    return buildTree(await this.uow.store.allCategories());
  }

  /** Public view: inactive categories do not exist for clients. */
  async getActive(id: string): Promise<Category> {
    const c = await this.uow.store.category(id);
    if (!c?.active) throw Errors.notFound('Category');
    return c;
  }

  async create(input: Omit<NewCategory, 'id'>, ctx: RequestContext): Promise<Category> {
    requireActor(ctx);
    assertAttributeSchemaCoherent(input.attributeSchema);
    return this.uow.transaction(async (s) => {
      await this.assertParent(s, null, input.parentId);
      const c = await s.insertCategory({ ...input, id: uuidv7(), modes: dedupe(input.modes) });
      await this.emit(s, c, ctx, 'category.created');
      return c;
    });
  }

  async update(id: string, patch: CategoryPatch, ctx: RequestContext): Promise<Category> {
    requireActor(ctx);
    if (patch.attributeSchema) assertAttributeSchemaCoherent(patch.attributeSchema);
    return this.uow.transaction(async (s) => {
      const current = await s.categoryForUpdate(id);
      if (!current) throw Errors.notFound('Category');
      if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
        await this.assertParent(s, id, patch.parentId);
      }
      const c = await s.updateCategory(id, {
        ...patch,
        ...(patch.modes ? { modes: dedupe(patch.modes) } : {}),
      });
      await this.emit(s, c, ctx, 'category.updated');
      return c;
    });
  }

  private async assertParent(s: CatalogStore, id: string | null, parentId: string | null) {
    if (parentId === null) return;
    const chain = await s.categoryChain(parentId);
    if (chain.length === 0) {
      throw new AppError('BUSINESS_RULE_VIOLATION', 'The parent category does not exist.', {
        rule: 'PARENT_NOT_FOUND',
      });
    }
    assertValidParent(id, chain);
  }

  private async emit(s: CatalogStore, c: Category, ctx: RequestContext, action: string) {
    await s.outbox(
      this.event(CatalogEvents.CategoryUpserted, c.id, categoryUpsertedPayload(c), ctx),
    );
    await s.audit(ctx, {
      action,
      actorType: 'ADMIN',
      targetType: 'CATEGORY',
      targetId: c.id,
      metadata: { slug: c.slug, version: c.version, active: c.active },
    });
  }
}
