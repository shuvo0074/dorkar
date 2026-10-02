import { NeedModes, type NeedMode } from '@dorkar/contracts';
import { Errors } from '@dorkar/kernel';
import type { VerificationKind } from './verification';

export const PolicyActions = [
  'LISTING_PUBLISH',
  'NEED_PUBLISH',
  'OFFER_SUBMIT',
  'TRANSACTION_CREATE',
  'ANY',
] as const;
export type PolicyAction = (typeof PolicyActions)[number];
/** What callers evaluate: a concrete action, never ANY. */
export type EvaluatedAction = Exclude<PolicyAction, 'ANY'>;
export const EvaluatedActions = PolicyActions.filter(
  (a): a is EvaluatedAction => a !== 'ANY',
) as readonly EvaluatedAction[];

export const PolicyScopes = ['GLOBAL', 'ROLE', 'CATEGORY', 'MODE', 'VALUE_THRESHOLD'] as const;
export type PolicyScope = (typeof PolicyScopes)[number];

export const Requirements = ['NONE', 'OPTIONAL', 'REQUIRED'] as const;
export type Requirement = (typeof Requirements)[number];

export type Selector =
  | Record<string, never>
  | { role: string }
  | { categoryId: string }
  | { mode: NeedMode }
  | { minAmount: number };

export interface Policy {
  id: string;
  name: string;
  action: PolicyAction;
  scope: PolicyScope;
  selector: Selector;
  requirement: Requirement;
  kinds: VerificationKind[];
  active: boolean;
  priority: number;
  version: number;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationContext {
  action: EvaluatedAction;
  roles: readonly string[];
  categoryId?: string | undefined;
  mode?: NeedMode | undefined;
  /** Poisha. */
  amount?: number | undefined;
}

export interface Evaluation {
  required: VerificationKind[];
  missing: VerificationKind[];
  satisfied: boolean;
  /** The policy that decided, or null when none applied. */
  policyId: string | null;
}

/** Narrow scopes beat broad ones. VALUE_THRESHOLD, CATEGORY and MODE are equally specific. */
export const SPECIFICITY: Readonly<Record<PolicyScope, number>> = {
  GLOBAL: 0,
  ROLE: 1,
  CATEGORY: 2,
  MODE: 2,
  VALUE_THRESHOLD: 2,
};

type PolicyShape = Pick<
  Policy,
  'id' | 'action' | 'scope' | 'selector' | 'requirement' | 'kinds' | 'active' | 'priority'
>;

export function selectorMatches(p: Pick<Policy, 'scope' | 'selector'>, c: EvaluationContext) {
  const s = p.selector as Partial<{
    role: string;
    categoryId: string;
    mode: string;
    minAmount: number;
  }>;
  switch (p.scope) {
    case 'GLOBAL':
      return true;
    case 'ROLE':
      return s.role !== undefined && c.roles.includes(s.role);
    case 'CATEGORY':
      return s.categoryId !== undefined && c.categoryId === s.categoryId;
    case 'MODE':
      return s.mode !== undefined && c.mode === s.mode;
    case 'VALUE_THRESHOLD':
      return s.minAmount !== undefined && c.amount !== undefined && c.amount >= s.minAmount;
  }
}

export const applies = (p: PolicyShape, c: EvaluationContext): boolean =>
  p.active && (p.action === c.action || p.action === 'ANY') && selectorMatches(p, c);

/**
 * Orders applicable policies: most specific scope, then higher priority, then a policy for the
 * exact action over an ANY policy, then the lower id (deterministic).
 */
function beats(a: PolicyShape, b: PolicyShape): boolean {
  if (SPECIFICITY[a.scope] !== SPECIFICITY[b.scope]) {
    return SPECIFICITY[a.scope] > SPECIFICITY[b.scope];
  }
  if (a.priority !== b.priority) return a.priority > b.priority;
  if ((a.action === 'ANY') !== (b.action === 'ANY')) return b.action === 'ANY';
  return a.id < b.id;
}

/**
 * Decides which verifications an action needs. Policies are data; nothing about NID or any
 * other kind is hard-coded here.
 */
export function evaluate(
  policies: readonly PolicyShape[],
  context: EvaluationContext,
  verifiedKinds: readonly VerificationKind[],
): Evaluation {
  let winner: PolicyShape | null = null;
  for (const p of policies) {
    if (applies(p, context) && (!winner || beats(p, winner))) winner = p;
  }
  const required = winner?.requirement === 'REQUIRED' ? [...new Set(winner.kinds)] : [];
  const have = new Set(verifiedKinds);
  const missing = required.filter((k) => !have.has(k));
  return { required, missing, satisfied: missing.length === 0, policyId: winner?.id ?? null };
}

// ---------------------------------------------------------------- authoring rules

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[A-Z][A-Z_]{1,39}$/;

/** Validates and normalizes a selector for its scope (unknown keys rejected). */
export function parseSelector(scope: PolicyScope, raw: Record<string, unknown>): Selector {
  const keys = Object.keys(raw);
  const only = (key: string) => keys.length === 1 && keys[0] === key;
  const bad = (hint: string) =>
    Errors.validation(`Selector for ${scope} must be ${hint}.`, { field: 'selector' });
  switch (scope) {
    case 'GLOBAL':
      if (keys.length !== 0) throw bad('{}');
      return {};
    case 'ROLE':
      if (!only('role') || typeof raw['role'] !== 'string' || !ROLE.test(raw['role'])) {
        throw bad('{"role": "<ROLE>"}');
      }
      return { role: raw['role'] };
    case 'CATEGORY':
      if (
        !only('categoryId') ||
        typeof raw['categoryId'] !== 'string' ||
        !UUID.test(raw['categoryId'])
      ) {
        throw bad('{"categoryId": "<uuid>"}');
      }
      return { categoryId: raw['categoryId'].toLowerCase() };
    case 'MODE':
      if (!only('mode') || !(NeedModes as readonly unknown[]).includes(raw['mode'])) {
        throw bad(`{"mode": ${NeedModes.join('|')}}`);
      }
      return { mode: raw['mode'] as NeedMode };
    case 'VALUE_THRESHOLD': {
      const v = raw['minAmount'];
      if (!only('minAmount') || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw bad('{"minAmount": <poisha, integer ≥ 0>}');
      }
      return { minAmount: v };
    }
  }
}

/** A REQUIRED policy must name what it requires. */
export function assertPolicyConsistent(p: {
  requirement: Requirement;
  kinds: readonly VerificationKind[];
}): void {
  if (p.requirement === 'REQUIRED' && p.kinds.length === 0) {
    throw Errors.validation('A REQUIRED policy needs at least one verification kind.', {
      field: 'kinds',
    });
  }
}
