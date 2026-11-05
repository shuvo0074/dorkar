// Builds one of everything for a signed-in member, through the API: a deal, an offer to counter,
// a conversation, a dispute, a booking, a rental they own, a loan, a lend item and an auction.
// Prints the ids as JSON. Usage: DORKAR_ROOT=<checkout with node_modules> node e2e/scenario.mjs <phone>
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.DORKAR_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../../..');
const { api, CATEGORIES, eventually, expectStatus, idem, phone, publishListing, setUpSeller, signIn } =
  await import(`${root}/scripts/e2e-lib.mjs`);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BDT = (amount) => ({ amount, currency: 'BDT' });
const silence = console.log;
console.log = () => {};

/** Events take a moment to reach the service that checks them: retry until accepted. */
const accepted = (what, call, status = 201) =>
  eventually(
    what,
    async () => {
      const r = await call();
      if (r.status === 400) throw new Error(`${what}: ${JSON.stringify(r.body)}`);
      return (r.status === status || r.status === 200) && r;
    },
    120_000,
    1_000,
  );
const command = (u, id, name, body) =>
  expectStatus(
    api('POST', `/api/v1/transactions/${id}/${name}`, { token: u.token, idem: idem(), body }),
    200,
    name,
  );
const listing = (u, title, amount, extra = {}) =>
  publishListing(u, {
    categoryId: CATEGORIES.MOBILE_PHONES,
    kind: 'PRODUCT',
    title,
    price: BDT(amount),
    priceUnit: 'TOTAL',
    ...extra,
  });
const buy = (u, id) =>
  accepted('the purchase', () =>
    api('POST', '/api/v1/transactions', {
      token: u.token,
      idem: idem(),
      body: { listingId: id, quantity: 1 },
    }),
  );

const me = await signIn('member', process.argv[2]);
await setUpSeller(me, { displayName: 'E2E Member', categoryIds: [CATEGORIES.LAPTOPS] });
const seller = await signIn('seller', phone());
await setUpSeller(seller, {
  displayName: 'E2E Seller',
  categoryIds: [CATEGORIES.MOBILE_PHONES, CATEGORIES.LAPTOPS],
});

// A deal waiting for the member to confirm, and a listing to look at.
const product = await listing(seller, 'E2E Pixel 8, boxed', 5_500_000);
const deal = (await buy(me, product.id)).body.data;

// An offer to counter.
const need = await expectStatus(
  api('POST', '/api/v1/needs', {
    token: me.token,
    body: {
      mode: 'BUY',
      categoryId: CATEGORIES.MOBILE_PHONES,
      title: 'E2E counter me',
      location: { district: 'dhaka' },
      publish: true,
    },
  }),
  201,
  'need',
);
const offer = await accepted('the offer', () =>
  api('POST', `/api/v1/needs/${need.data.id}/offers`, {
    token: seller.token,
    idem: idem(),
    body: {
      price: BDT(8_000_000),
      quantity: 1,
      deliveryTerms: { method: 'SELLER_DELIVERY', etaDays: 1 },
    },
  }),
);

// A conversation with one message waiting.
// (A listing of its own: the one above is reserved by the deal, so it can't open a conversation.)
const chatProduct = await listing(seller, 'E2E Pixel 7, boxed', 4_000_000);
const conversation = await accepted('the conversation', () =>
  api('POST', '/api/v1/conversations', {
    token: me.token,
    body: { contextType: 'LISTING', contextId: chatProduct.id },
  }),
);
await expectStatus(
  api('POST', `/api/v1/conversations/${conversation.body.data.id}/messages`, {
    token: seller.token,
    body: { body: 'Yes, it is still available.', clientId: randomUUID() },
  }),
  201,
  'message',
);

// A dispute the member opened after delivery.
const disputedProduct = await listing(seller, 'E2E iPhone 13', 4_500_000);
const purchase = (await buy(me, disputedProduct.id)).body.data;
await command(me, purchase.id, 'confirm');
await command(seller, purchase.id, 'confirm');
await command(seller, purchase.id, 'arrange-delivery', { method: 'SELLER_DELIVERY' });
await command(seller, purchase.id, 'mark-delivered');
await command(me, purchase.id, 'dispute', {
  reason: 'The screen has a crack that was not in the photos.',
  category: 'NOT_AS_DESCRIBED',
});
const dispute = await eventually('the dispute', async () => {
  const r = await api('GET', '/api/v1/me/disputes', { token: me.token });
  return r.status === 200 && r.body.data.find((d) => d.transactionId === purchase.id);
});

// A booking held for the member to confirm.
const rental = await listing(seller, 'E2E MacBook for rent', 150_000, {
  categoryId: CATEGORIES.LAPTOPS,
  kind: 'RENTAL',
  priceUnit: 'PER_DAY',
});
const rentalTerms = (instantBook) => ({
  instantBook,
  minDurationHours: 24,
  maxDurationDays: 14,
  advanceNoticeHours: 2,
  bufferHours: 0,
  deposit: BDT(1_000_000),
  cancellationNote: 'Free cancellation until confirmation.',
});
await accepted(
  'the rental terms',
  () =>
    api('PUT', `/api/v1/listings/${rental.id}/rental-terms`, {
      token: seller.token,
      body: rentalTerms(true),
    }),
  200,
);
const start = Math.ceil((Date.now() + DAY) / 60_000) * 60_000;
const booking = await accepted('the booking', () =>
  api('POST', '/api/v1/bookings', {
    token: me.token,
    idem: idem(),
    body: {
      listingId: rental.id,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 2 * DAY).toISOString(),
    },
  }),
);

// A rental the member owns, for the settings page.
const own = await listing(me, 'E2E my laptop for rent', 100_000, {
  categoryId: CATEGORIES.LAPTOPS,
  kind: 'RENTAL',
  priceUnit: 'PER_DAY',
});

// A lend item, and a loan the member asked for.
const item = await accepted('the lend item', () =>
  api('POST', '/api/v1/lend-items', {
    token: seller.token,
    idem: idem(),
    body: {
      categoryId: CATEGORIES.LAPTOPS,
      title: 'E2E ThinkPad to borrow',
      condition: 'USED',
      district: 'dhaka',
      maxLoanDays: 7,
    },
  }),
);
const loan = await accepted('the loan', () =>
  api('POST', '/api/v1/loans', {
    token: me.token,
    idem: idem(),
    body: {
      itemId: item.body.data.id,
      startAt: new Date(Date.now() + HOUR).toISOString(),
      returnBy: new Date(Date.now() + 3 * DAY).toISOString(),
    },
  }),
);

// An open auction to bid in.
const lot = await listing(seller, 'E2E Galaxy S24 auction', 12_000_000);
const auction = await accepted('the auction', () =>
  api('POST', '/api/v1/auctions', {
    token: seller.token,
    idem: idem(),
    body: {
      kind: 'FORWARD',
      subjectId: lot.id,
      startPrice: BDT(9_000_000),
      minIncrement: BDT(100_000),
      endsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    },
  }),
);

console.log = silence;
console.log(
  JSON.stringify({
    DEAL: deal.id,
    OFFER: offer.body.data.id,
    CONVERSATION: conversation.body.data.id,
    DISPUTE: dispute.id,
    BOOKING: booking.body.data.id,
    OWN_RENTAL: own.id,
    LOAN: loan.body.data.id,
    ITEM: item.body.data.id,
    AUCTION: auction.body.data.id,
    LISTING: chatProduct.id,
  }),
);
process.exit(0);
