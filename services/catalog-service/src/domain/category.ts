import type { AttributeSchema, NeedMode } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export interface Category {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  /** Need modes this category supports (a subset of NeedModes). */
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  sort: number;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryNode {
  id: string;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  sort: number;
  children: CategoryNode[];
}

/** Deepest tree we accept: root › group › leaf › variant. Keeps forms and filters sane. */
export const MAX_CATEGORY_DEPTH = 4;

const schemaViolation = (issues: Array<{ path: string; message: string }>) =>
  new AppError('BUSINESS_RULE_VIOLATION', 'The attribute schema is inconsistent.', {
    rule: 'INVALID_ATTRIBUTE_SCHEMA',
    issues,
  });

/**
 * Structural validity comes from `AttributeSchemaSchema`; this checks what a type cannot:
 * `required` names real properties, ranges are not inverted, enum values fit their maxLength.
 */
export function assertAttributeSchemaCoherent(schema: AttributeSchema): void {
  const issues: Array<{ path: string; message: string }> = [];
  for (const req of schema.required) {
    if (!(req in schema.properties))
      issues.push({ path: `required.${req}`, message: 'not a defined property' });
  }
  if (new Set(schema.required).size !== schema.required.length)
    issues.push({ path: 'required', message: 'duplicate entries' });
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (
      (spec.type === 'integer' || spec.type === 'number') &&
      spec.minimum !== undefined &&
      spec.maximum !== undefined &&
      spec.minimum > spec.maximum
    ) {
      issues.push({ path: `properties.${key}`, message: 'minimum is greater than maximum' });
    }
    if (spec.type === 'string' && spec.enum) {
      if (new Set(spec.enum).size !== spec.enum.length)
        issues.push({ path: `properties.${key}.enum`, message: 'duplicate values' });
      if (spec.maxLength !== undefined && spec.enum.some((v) => v.length > spec.maxLength!))
        issues.push({ path: `properties.${key}.enum`, message: 'value longer than maxLength' });
    }
  }
  if (issues.length) throw schemaViolation(issues);
}

/**
 * Re-parenting must keep the tree a tree. `parentChain` is the new parent followed by its
 * ancestors up to the root.
 */
export function assertValidParent(categoryId: string | null, parentChain: readonly string[]): void {
  if (categoryId !== null && parentChain.includes(categoryId)) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'A category cannot be placed under itself.', {
      rule: 'CATEGORY_CYCLE',
    });
  }
  if (parentChain.length + 1 > MAX_CATEGORY_DEPTH) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'The category tree is too deep here.', {
      rule: 'CATEGORY_TOO_DEEP',
      maxDepth: MAX_CATEGORY_DEPTH,
    });
  }
}

const bySortThenName = (a: Category, b: Category) =>
  a.sort - b.sort || a.nameEn.localeCompare(b.nameEn);

/** Active categories as a nested tree. Children of an inactive parent are unreachable, so omitted. */
export function buildTree(categories: readonly Category[]): CategoryNode[] {
  const active = categories.filter((c) => c.active);
  const byParent = new Map<string | null, Category[]>();
  for (const c of active) {
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  const build = (parentId: string | null, depth: number): CategoryNode[] =>
    depth > MAX_CATEGORY_DEPTH
      ? []
      : (byParent.get(parentId) ?? []).sort(bySortThenName).map((c) => ({
          id: c.id,
          slug: c.slug,
          nameEn: c.nameEn,
          nameBn: c.nameBn,
          modes: c.modes,
          sort: c.sort,
          children: build(c.id, depth + 1),
        }));
  return build(null, 1);
}

/** Payload for catalog.CategoryUpserted (consumers keep a projection of the tree). */
export const categoryUpsertedPayload = (c: Category) => ({
  categoryId: c.id,
  parentId: c.parentId,
  slug: c.slug,
  nameEn: c.nameEn,
  nameBn: c.nameBn,
  modes: c.modes,
  attributeSchema: c.attributeSchema,
  active: c.active,
});
