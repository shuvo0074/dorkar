import { describe, expect, it } from 'vitest';
import {
  applies,
  assertPolicyConsistent,
  evaluate,
  parseSelector,
  type EvaluationContext,
  type Policy,
} from '../../src/domain/policy';

type P = Pick<
  Policy,
  'id' | 'action' | 'scope' | 'selector' | 'requirement' | 'kinds' | 'active' | 'priority'
>;

let seq = 0;
const policy = (p: Partial<P>): P => ({
  id: `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`,
  action: 'ANY',
  scope: 'GLOBAL',
  selector: {},
  requirement: 'NONE',
  kinds: [],
  active: true,
  priority: 0,
  ...p,
});

const CAT = '0192f0c4-0000-7000-8000-00000000c001';
const OTHER_CAT = '0192f0c4-0000-7000-8000-00000000c002';
const ctx = (c: Partial<EvaluationContext> = {}): EvaluationContext => ({
  action: 'LISTING_PUBLISH',
  roles: ['MEMBER'],
  ...c,
});

const base = policy({});
const nidForCategory = policy({
  scope: 'CATEGORY',
  selector: { categoryId: CAT },
  requirement: 'REQUIRED',
  kinds: ['NID'],
});

describe('evaluate: applicability', () => {
  it('requires nothing with no policies at all', () => {
    expect(evaluate([], ctx(), [])).toEqual({
      required: [],
      missing: [],
      satisfied: true,
      policyId: null,
    });
  });

  it('the seeded default (GLOBAL/ANY/NONE) requires nothing', () => {
    const r = evaluate([base], ctx(), []);
    expect(r).toMatchObject({ required: [], missing: [], satisfied: true, policyId: base.id });
  });

  it('applies a CATEGORY policy only to its category', () => {
    expect(evaluate([base, nidForCategory], ctx({ categoryId: CAT }), [])).toMatchObject({
      required: ['NID'],
      missing: ['NID'],
      satisfied: false,
    });
    expect(evaluate([base, nidForCategory], ctx({ categoryId: OTHER_CAT }), [])).toMatchObject({
      required: [],
      satisfied: true,
    });
    expect(evaluate([base, nidForCategory], ctx(), []).satisfied).toBe(true);
  });

  it('is satisfied when the account holds every required kind', () => {
    const both = policy({ requirement: 'REQUIRED', kinds: ['PHONE', 'NID'] });
    expect(evaluate([both], ctx(), ['PHONE'])).toMatchObject({
      required: ['PHONE', 'NID'],
      missing: ['NID'],
      satisfied: false,
    });
    expect(evaluate([both], ctx(), ['NID', 'PHONE'])).toMatchObject({
      missing: [],
      satisfied: true,
    });
  });

  it('ignores inactive policies', () => {
    const off = { ...nidForCategory, active: false };
    expect(evaluate([base, off], ctx({ categoryId: CAT }), [])).toMatchObject({
      satisfied: true,
      policyId: base.id,
    });
  });

  it('matches its own action or ANY, never another action', () => {
    const forOffers = policy({ action: 'OFFER_SUBMIT', requirement: 'REQUIRED', kinds: ['NID'] });
    expect(evaluate([forOffers], ctx({ action: 'OFFER_SUBMIT' }), []).satisfied).toBe(false);
    expect(evaluate([forOffers], ctx({ action: 'LISTING_PUBLISH' }), []).satisfied).toBe(true);
    const any = policy({ action: 'ANY', requirement: 'REQUIRED', kinds: ['NID'] });
    for (const action of [
      'LISTING_PUBLISH',
      'NEED_PUBLISH',
      'OFFER_SUBMIT',
      'TRANSACTION_CREATE',
    ] as const) {
      expect(evaluate([any], ctx({ action }), []).required).toEqual(['NID']);
    }
  });

  it('matches ROLE and MODE selectors', () => {
    const business = policy({
      scope: 'ROLE',
      selector: { role: 'BUSINESS' },
      requirement: 'REQUIRED',
      kinds: ['BUSINESS'],
    });
    expect(evaluate([business], ctx({ roles: ['MEMBER', 'BUSINESS'] }), []).missing).toEqual([
      'BUSINESS',
    ]);
    expect(evaluate([business], ctx({ roles: ['MEMBER'] }), []).satisfied).toBe(true);

    const sourcing = policy({
      scope: 'MODE',
      selector: { mode: 'SOURCE' },
      requirement: 'REQUIRED',
      kinds: ['NID'],
    });
    expect(evaluate([sourcing], ctx({ mode: 'SOURCE' }), []).satisfied).toBe(false);
    expect(evaluate([sourcing], ctx({ mode: 'BUY' }), []).satisfied).toBe(true);
    expect(evaluate([sourcing], ctx(), []).satisfied).toBe(true);
  });

  it('applies a VALUE_THRESHOLD at and above the boundary, not below or without an amount', () => {
    const big = policy({
      scope: 'VALUE_THRESHOLD',
      selector: { minAmount: 5_000_000 },
      requirement: 'REQUIRED',
      kinds: ['NID'],
    });
    expect(evaluate([big], ctx({ amount: 4_999_999 }), []).satisfied).toBe(true);
    expect(evaluate([big], ctx({ amount: 5_000_000 }), []).satisfied).toBe(false);
    expect(evaluate([big], ctx({ amount: 5_000_001 }), []).satisfied).toBe(false);
    expect(evaluate([big], ctx(), []).satisfied).toBe(true);
    expect(applies(big, ctx({ amount: 0 }))).toBe(false);
  });

  it('treats OPTIONAL and NONE as requiring nothing', () => {
    for (const requirement of ['OPTIONAL', 'NONE'] as const) {
      const p = policy({ requirement, kinds: ['NID'] });
      expect(evaluate([p], ctx(), [])).toMatchObject({
        required: [],
        missing: [],
        satisfied: true,
        policyId: p.id,
      });
    }
  });
});

describe('evaluate: the most specific policy wins', () => {
  const roleRequired = policy({
    scope: 'ROLE',
    selector: { role: 'MEMBER' },
    requirement: 'REQUIRED',
    kinds: ['PHONE'],
  });
  const globalRequired = policy({ requirement: 'REQUIRED', kinds: ['BUSINESS'], priority: 999 });

  it('ROLE beats GLOBAL regardless of priority', () => {
    expect(evaluate([globalRequired, roleRequired], ctx(), []).policyId).toBe(roleRequired.id);
  });

  it('CATEGORY beats ROLE and GLOBAL, even when it relaxes them', () => {
    const relaxed = policy({
      scope: 'CATEGORY',
      selector: { categoryId: CAT },
      requirement: 'NONE',
      priority: -5,
    });
    const r = evaluate([globalRequired, roleRequired, relaxed], ctx({ categoryId: CAT }), []);
    expect(r).toMatchObject({ policyId: relaxed.id, satisfied: true, required: [] });
  });

  it('MODE and VALUE_THRESHOLD each beat ROLE', () => {
    const mode = policy({ scope: 'MODE', selector: { mode: 'RENT' } });
    const value = policy({ scope: 'VALUE_THRESHOLD', selector: { minAmount: 100 } });
    expect(evaluate([roleRequired, mode], ctx({ mode: 'RENT' }), []).policyId).toBe(mode.id);
    expect(evaluate([roleRequired, value], ctx({ amount: 100 }), []).policyId).toBe(value.id);
  });

  it('breaks ties among equally specific policies by higher priority', () => {
    const catLow = policy({
      scope: 'CATEGORY',
      selector: { categoryId: CAT },
      requirement: 'REQUIRED',
      kinds: ['NID'],
      priority: 1,
    });
    const valueHigh = policy({
      scope: 'VALUE_THRESHOLD',
      selector: { minAmount: 0 },
      requirement: 'NONE',
      priority: 10,
    });
    const c = ctx({ categoryId: CAT, amount: 1 });
    expect(evaluate([catLow, valueHigh], c, []).policyId).toBe(valueHigh.id);
    expect(evaluate([valueHigh, catLow], c, []).policyId).toBe(valueHigh.id);
    const valueLow = { ...valueHigh, priority: 0 };
    expect(evaluate([catLow, valueLow], c, []).policyId).toBe(catLow.id);
  });

  it('on equal specificity and priority prefers the exact action, then the older id', () => {
    const anyP = policy({ action: 'ANY', requirement: 'NONE' });
    const exact = policy({ action: 'LISTING_PUBLISH', requirement: 'REQUIRED', kinds: ['NID'] });
    expect(evaluate([anyP, exact], ctx(), []).policyId).toBe(exact.id);
    expect(evaluate([exact, anyP], ctx(), []).policyId).toBe(exact.id);
    const a = policy({});
    const b = policy({});
    expect(evaluate([b, a], ctx(), []).policyId).toBe(a.id);
  });

  it('does not let an inactive more specific policy win', () => {
    const inactiveCat = { ...nidForCategory, active: false, priority: 100 };
    expect(evaluate([roleRequired, inactiveCat], ctx({ categoryId: CAT }), []).policyId).toBe(
      roleRequired.id,
    );
  });
});

describe('policy authoring rules', () => {
  it('validates selectors per scope and rejects extra keys', () => {
    expect(parseSelector('GLOBAL', {})).toEqual({});
    expect(() => parseSelector('GLOBAL', { role: 'X' })).toThrow();
    expect(parseSelector('ROLE', { role: 'BUSINESS' })).toEqual({ role: 'BUSINESS' });
    expect(() => parseSelector('ROLE', { role: 'business' })).toThrow();
    expect(parseSelector('CATEGORY', { categoryId: CAT.toUpperCase() })).toEqual({
      categoryId: CAT,
    });
    expect(() => parseSelector('CATEGORY', { categoryId: 'phones' })).toThrow();
    expect(() => parseSelector('CATEGORY', { categoryId: CAT, mode: 'BUY' })).toThrow();
    expect(parseSelector('MODE', { mode: 'SOURCE' })).toEqual({ mode: 'SOURCE' });
    expect(() => parseSelector('MODE', { mode: 'STEAL' })).toThrow();
    expect(parseSelector('VALUE_THRESHOLD', { minAmount: 5_000_000 })).toEqual({
      minAmount: 5_000_000,
    });
    expect(() => parseSelector('VALUE_THRESHOLD', { minAmount: -1 })).toThrow();
    expect(() => parseSelector('VALUE_THRESHOLD', { minAmount: 1.5 })).toThrow();
    expect(() => parseSelector('VALUE_THRESHOLD', { minAmount: '5000' })).toThrow();
  });

  it('requires kinds for a REQUIRED policy', () => {
    expect(() => assertPolicyConsistent({ requirement: 'REQUIRED', kinds: [] })).toThrow();
    expect(() => assertPolicyConsistent({ requirement: 'REQUIRED', kinds: ['NID'] })).not.toThrow();
    expect(() => assertPolicyConsistent({ requirement: 'NONE', kinds: [] })).not.toThrow();
  });
});
