import { describe, expect, it } from 'vitest';
import {
  assertNoContactInfo,
  listingTerms,
  priceListingPurchase,
  type ListingSnapshot,
} from '../../src/domain/transaction';
import { CashPaymentProvider, SelfArrangedDelivery } from '../../src/infrastructure/providers';

const listing = (over: Partial<ListingSnapshot> = {}): ListingSnapshot => ({
  listingId: '0192f0c4-0000-7000-8000-000000000001',
  sellerId: 'seller',
  kind: 'PRODUCT',
  title: 'Walton fridge',
  price: 2_500_000,
  currency: 'BDT',
  priceUnit: 'PER_UNIT',
  quantityAvailable: 5,
  deliveryModes: ['BUYER_PICKUP'],
  available: true,
  ...over,
});

const ruleOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { details?: { rule?: string } }).details?.rule ?? null;
  }
};

describe('direct listing purchase', () => {
  it('maps listing kind to mode and multiplies per-unit prices', () => {
    expect(priceListingPurchase(listing(), 'buyer', 3)).toEqual({ mode: 'BUY', amount: 7_500_000 });
    expect(priceListingPurchase(listing({ kind: 'SERVICE' }), 'buyer', 1).mode).toBe('HIRE');
    expect(priceListingPurchase(listing({ kind: 'RENTAL', priceUnit: 'PER_DAY' }), 'b', 2)).toEqual(
      { mode: 'RENT', amount: 5_000_000 },
    );
  });

  it('sells TOTAL-priced listings as a single lot', () => {
    expect(priceListingPurchase(listing({ priceUnit: 'TOTAL' }), 'buyer', 1).amount).toBe(
      2_500_000,
    );
    expect(ruleOf(() => priceListingPurchase(listing({ priceUnit: 'TOTAL' }), 'buyer', 2))).toBe(
      'QUANTITY_NOT_ALLOWED',
    );
  });

  it('refuses own, unavailable, oversold and absurd purchases', () => {
    expect(ruleOf(() => priceListingPurchase(listing(), 'seller', 1))).toBe('OWN_LISTING');
    expect(ruleOf(() => priceListingPurchase(listing({ available: false }), 'b', 1))).toBe(
      'LISTING_UNAVAILABLE',
    );
    expect(ruleOf(() => priceListingPurchase(listing(), 'b', 6))).toBe('INSUFFICIENT_QUANTITY');
    expect(ruleOf(() => priceListingPurchase(listing(), 'b', 0))).toBe('INVALID_QUANTITY');
    expect(
      ruleOf(() =>
        priceListingPurchase(listing({ price: 90_000_000_000, quantityAvailable: 10 }), 'b', 2),
      ),
    ).toBe('AMOUNT_TOO_LARGE');
  });

  it('freezes the listing terms', () => {
    expect(listingTerms(listing(), 2)).toMatchObject({
      title: 'Walton fridge',
      unitPrice: { amount: 2_500_000, currency: 'BDT' },
      quantity: 2,
    });
  });
});

describe('delivery notes', () => {
  it('keep phone numbers and emails inside Dorkar', () => {
    expect(ruleOf(() => assertNoContactInfo('notes', 'call 01712345678'))).toBe('NO_CONTACT_INFO');
    expect(ruleOf(() => assertNoContactInfo('notes', 'Gate 3, after 5pm'))).toBeNull();
  });
});

describe('MVP providers', () => {
  const cash = new CashPaymentProvider();
  const self = new SelfArrangedDelivery();
  const payment = { status: 'PENDING' as const };

  it('cash: pending on creation, paid on completion, refund is a no-op note', async () => {
    expect((await cash.initiate()).status).toBe('PENDING');
    expect((await cash.onCompleted()).status).toBe('PAID');
    const refund = await cash.refund(null, payment);
    expect(refund.status).toBe('PENDING');
    expect(refund.note).toMatch(/not refunded/);
    expect(await cash.status(null, payment)).toBe('PENDING');
    // A dispute REFUND is never applied to cash: Dorkar never collected the money.
    expect(cash.supportsRefund).toBe(false);
  });

  it('self-arranged delivery records the outcome only', async () => {
    expect((await self.arrange()).status).toBe('ARRANGED');
    expect((await self.markDelivered()).status).toBe('DELIVERED');
    expect((await self.cancel()).status).toBe('CANCELLED');
  });
});
