import {
  findContactInfo,
  validateAttributes,
  type AttributeSchema,
  type AttributeValues,
  type Condition,
  type District,
  type NeedMode,
  type NeedStatus,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { z } from 'zod';

export const DeliveryPreferences = ['PICKUP', 'DELIVERY', 'EITHER'] as const;
export type DeliveryPreference = (typeof DeliveryPreferences)[number];

export const Visibilities = ['PUBLIC', 'MATCHED_ONLY'] as const;
export type Visibility = (typeof Visibilities)[number];

export interface Need {
  id: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  description: string | null;
  quantity: number;
  /** Poisha. */
  budgetMin: number | null;
  budgetMax: number | null;
  budgetFlexible: boolean;
  conditions: Condition[];
  attributes: AttributeValues;
  modeTerms: ModeTerms;
  district: District;
  area: string | null;
  deliveryPref: DeliveryPreference;
  /** YYYY-MM-DD. */
  requiredBy: string | null;
  /** Requested time-to-live in days (applied at publish/renew). */
  ttlDays: number | null;
  expiresAt: Date | null;
  renewals: number;
  maxOffers: number;
  visibility: Visibility;
  status: NeedStatus;
  statusBeforeHidden: NeedStatus | null;
  offerCount: number;
  acceptedQuantity: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface Category {
  id: string;
  parentId: string | null;
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  active: boolean;
}

/** Settings (env-driven; never hard-coded in use cases). */
export interface NeedPolicy {
  defaultTtlDays: number;
  maxTtlDays: number;
  maxRenewals: number;
  maxOpenPerUser: number;
  maxOffers: number;
}

// ---------------------------------------------------------------- mode terms

const shortText = (max: number) => z.string().trim().min(1).max(max);
const dateTime = z.iso.datetime({ offset: true });
const date = z.iso.date();

export const ServiceWindows = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'ANY'] as const;

/** Mode-specific terms (docs/architecture/02-data.md). Strict: unknown keys are rejected. */
export const ModeTermsSchemas = {
  BUY: z.strictObject({
    acceptsUsed: z.boolean().optional(),
    warrantyRequired: z.boolean().optional(),
  }),
  RENT: z
    .strictObject({
      startAt: dateTime,
      endAt: dateTime,
      depositAcceptable: z.boolean().optional(),
    })
    .refine((t) => Date.parse(t.endAt) > Date.parse(t.startAt), {
      message: 'endAt must be after startAt',
      path: ['endAt'],
    }),
  BORROW: z
    .strictObject({
      startAt: dateTime,
      returnBy: dateTime,
      purpose: shortText(500).optional(),
      depositOffered: z.boolean().optional(),
    })
    .refine((t) => Date.parse(t.returnBy) > Date.parse(t.startAt), {
      message: 'returnBy must be after startAt',
      path: ['returnBy'],
    }),
  HIRE: z.strictObject({
    serviceDate: date,
    serviceWindow: z.enum(ServiceWindows).optional(),
    durationEstimateHours: z.number().positive().max(720).optional(),
    onSite: z.boolean().optional(),
    skills: z.array(shortText(40)).max(20).optional(),
  }),
  SOURCE: z.strictObject({
    specifications: shortText(2000),
    customization: shortText(1000).optional(),
    qualityRequirements: shortText(1000).optional(),
    sampleRequired: z.boolean().optional(),
    supplierRequirements: shortText(1000).optional(),
    deliveryDeadline: date.optional(),
  }),
} as const;

export type ModeTerms = Record<string, unknown>;

/** Validates mode terms for `mode`; 422 INVALID_MODE_TERMS with issues on failure. */
export function parseModeTerms(mode: NeedMode, input: unknown): ModeTerms {
  const r = ModeTermsSchemas[mode].safeParse(input ?? {});
  if (!r.success) {
    throw new AppError('BUSINESS_RULE_VIOLATION', `The ${mode.toLowerCase()} terms are invalid.`, {
      rule: 'INVALID_MODE_TERMS',
      mode,
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

// ---------------------------------------------------------------- rules

/** Public text must not leak contact details (phone numbers stay private on Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from the ${field}. Sellers contact you through Dorkar.`,
      { rule: 'NO_CONTACT_INFO', field },
    );
  }
}

/** Checks every string inside a JSON value (mode terms, attributes) for contact details. */
export function assertNoContactInfoDeep(field: string, value: unknown): void {
  if (typeof value === 'string') assertNoContactInfo(field, value);
  else if (Array.isArray(value)) value.forEach((v) => assertNoContactInfoDeep(field, v));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoContactInfoDeep(`${field}.${k}`, v);
  }
}

/** The category must exist in the projection, be active and allow the mode. */
export function assertCategoryAllows(category: Category | null, mode: NeedMode): Category {
  if (!category || !category.active) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'This category is not available.', {
      rule: 'CATEGORY_UNAVAILABLE',
    });
  }
  if (!category.modes.includes(mode)) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `This category does not accept ${mode.toLowerCase()} needs.`,
      { rule: 'MODE_NOT_ALLOWED', mode, allowedModes: category.modes },
    );
  }
  return category;
}

export function parseAttributes(schema: AttributeSchema, input: unknown): AttributeValues {
  const r = validateAttributes(schema, input ?? {}, { partial: true });
  if (!r.ok) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'Some details are invalid for this category.', {
      rule: 'INVALID_ATTRIBUTES',
      issues: r.issues,
    });
  }
  return r.value;
}

export function assertBudget(min: number | null, max: number | null): void {
  if (min !== null && max !== null && min > max) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'The minimum budget is above the maximum.', {
      rule: 'BUDGET_RANGE',
    });
  }
}

/** Bangladesh has no DST: local date is UTC+6. */
export const dhakaDate = (now: Date): string =>
  new Date(now.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);

export function assertRequiredByNotPast(requiredBy: string | null, now: Date): void {
  if (requiredBy && requiredBy < dhakaDate(now)) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'The required-by date is in the past.', {
      rule: 'REQUIRED_BY_IN_PAST',
    });
  }
}

/**
 * Days a need stays open: the default TTL, or a shorter one the requester asked for, never
 * above the maximum TTL.
 */
export const effectiveTtlDays = (requested: number | null, p: NeedPolicy): number =>
  Math.max(1, Math.min(requested ?? p.defaultTtlDays, p.defaultTtlDays, p.maxTtlDays));

export const expiryFrom = (now: Date, ttlDays: number): Date =>
  new Date(now.getTime() + ttlDays * 86_400_000);

export function assertOpenNeedLimit(openCount: number, p: NeedPolicy): void {
  if (openCount >= p.maxOpenPerUser) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `You can have at most ${p.maxOpenPerUser} open needs. Close one first.`,
      { rule: 'OPEN_NEED_LIMIT', limit: p.maxOpenPerUser },
    );
  }
}

/** Once sellers have made offers, the need must keep meaning what they offered on. */
export function assertNoMaterialChange(
  need: Pick<Need, 'offerCount' | 'acceptedQuantity' | 'categoryId' | 'mode'>,
  next: { categoryId: string; mode: NeedMode; quantity: number },
): void {
  if (next.quantity < need.acceptedQuantity) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'Quantity cannot go below what you already accepted.',
      { rule: 'MATERIAL_CHANGE_WITH_OFFERS', field: 'quantity' },
    );
  }
  if (need.offerCount === 0) return;
  const field =
    next.categoryId !== need.categoryId ? 'categoryId' : next.mode !== need.mode ? 'mode' : null;
  if (field) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'This need already has offers; post a new need to change its category or type.',
      { rule: 'MATERIAL_CHANGE_WITH_OFFERS', field },
    );
  }
}

export const EDITABLE_STATUSES: readonly NeedStatus[] = ['DRAFT', 'OPEN', 'PAUSED'];
