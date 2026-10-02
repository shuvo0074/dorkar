import { randomUUID } from 'node:crypto';
import { CatalogEvents, type NeedMode } from '@dorkar/contracts';
import { Errors } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { migrations } from '../../migrations';
import type { VerificationGateway } from '../../src/application/ports';
import { buildDemandService } from '../../src/app';

export type Svc = Awaited<ReturnType<typeof buildDemandService>>;

/** Controllable stand-in for verification-service. */
export class FakeVerification implements VerificationGateway {
  mode: 'ok' | 'missing' | 'down' = 'ok';
  calls: Array<Parameters<VerificationGateway['evaluate']>[0]> = [];
  async evaluate(q: Parameters<VerificationGateway['evaluate']>[0]) {
    this.calls.push(q);
    if (this.mode === 'down') throw Errors.unavailable('Verification is temporarily unavailable.');
    return this.mode === 'missing'
      ? { satisfied: false, missing: ['NID'] }
      : { satisfied: true, missing: [] };
  }
}

export async function startDemand(env: Record<string, string> = {}) {
  const verification = new FakeVerification();
  const t: TestService<Svc> = await startTestService({
    schemaPrefix: 'demand',
    migrations,
    env,
    build: (e, logger, verifier) => buildDemandService(e, logger, { verifier, verification }),
  });
  return { t, verification };
}

export const phoneSchema = {
  properties: {
    brand: { type: 'string' as const, label: { en: 'Brand', bn: 'ব্র্যান্ড' } },
    model: { type: 'string' as const, label: { en: 'Model', bn: 'মডেল' } },
    storageGb: {
      type: 'integer' as const,
      label: { en: 'Storage', bn: 'স্টোরেজ' },
      minimum: 1,
      unit: 'GB',
    },
  },
  required: ['brand'],
};

export async function seedCategory(
  t: TestService<Svc>,
  over: Partial<{
    id: string;
    parentId: string | null;
    modes: NeedMode[];
    active: boolean;
  }> = {},
): Promise<string> {
  const id = over.id ?? randomUUID();
  await t.svc.runtime.deliver(
    envelope(CatalogEvents.CategoryUpserted, {
      categoryId: id,
      parentId: over.parentId ?? null,
      slug: `cat-${id.slice(0, 8)}`,
      nameEn: 'Phones',
      nameBn: 'ফোন',
      modes: over.modes ?? ['BUY', 'RENT', 'BORROW', 'HIRE', 'SOURCE'],
      attributeSchema: phoneSchema,
      active: over.active ?? true,
    }),
  );
  return id;
}

/** The example body from docs/architecture/05-api.md. */
export const needBody = (categoryId: string, over: Record<string, unknown> = {}) => ({
  mode: 'BUY',
  categoryId,
  title: 'iPhone 15 Pro, 256GB',
  description: 'Prefer battery health above 85%',
  quantity: 1,
  budget: { max: { amount: 8_000_000, currency: 'BDT' }, flexible: false },
  condition: ['USED'],
  attributes: { brand: 'Apple', model: 'iPhone 15 Pro', storageGb: 256 },
  modeTerms: { acceptsUsed: true, warrantyRequired: false },
  location: { division: 'dhaka', district: 'dhaka', area: 'mirpur' },
  deliveryPreference: 'EITHER',
  publish: true,
  ...over,
});
