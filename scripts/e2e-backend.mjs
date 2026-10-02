// End-to-end check of the whole marketplace loop through the gateway, with every service running
// (`pnpm dev:backend`) and real events flowing between them:
//
//   sign in (buyer, seller) → seller capabilities + published listing → buyer posts a Need →
//   matching → seller offers → buyer counters → seller accepts → transaction → confirm,
//   deliver, receive → need FULFILLED → review → reputation on the public profile →
//   notifications.
//
//   pnpm e2e:backend      (exits non-zero on the first failed expectation)
import { randomUUID } from 'node:crypto';
import {
  api,
  CATEGORIES,
  eventually,
  expectStatus,
  fail,
  idem,
  log,
  requireGateway,
  requiredAttributes,
  setUpSeller,
  signIn,
  steps,
} from './e2e-lib.mjs';

const MOBILE_PHONES = CATEGORIES.MOBILE_PHONES;

// ------------------------------------------------------------------------------------------------

await requireGateway();

const buyer = await signIn('buyer');
const seller = await signIn('seller');
log(`buyer and seller signed in with phone + OTP (${buyer.id.slice(-6)}, ${seller.id.slice(-6)})`);

await setUpSeller(seller, { displayName: 'Rahim Mobile House', categoryIds: [MOBILE_PHONES] });
log('seller set up a business profile and sells mobile phones in Dhaka');

const { category, attributes } = await requiredAttributes(MOBILE_PHONES);
const listing = await expectStatus(
  api('POST', '/api/v1/listings', {
    token: seller.token,
    body: {
      categoryId: MOBILE_PHONES,
      kind: 'PRODUCT',
      condition: 'USED',
      title: 'iPhone 15 Pro 256GB, excellent condition',
      description: 'Battery health 92%, all accessories.',
      price: { amount: 7_800_000, currency: 'BDT' },
      priceUnit: 'TOTAL',
      quantityAvailable: 1,
      attributes,
      district: 'dhaka',
      deliveryModes: ['SELLER_DELIVERY'],
    },
  }),
  201,
  'create listing',
);
await expectStatus(
  api('POST', `/api/v1/listings/${listing.data.id}/publish`, { token: seller.token }),
  200,
  'publish listing',
);
log(`seller published a listing (${category.nameEn}, ৳78,000)`);

const need = await expectStatus(
  api('POST', '/api/v1/needs', {
    token: buyer.token,
    body: {
      mode: 'BUY',
      categoryId: MOBILE_PHONES,
      title: 'Used iPhone 15 Pro, 256GB',
      description: 'Prefer battery health above 85%',
      quantity: 1,
      budget: { max: { amount: 8_000_000, currency: 'BDT' }, flexible: false },
      condition: ['USED'],
      attributes: {},
      modeTerms: { acceptsUsed: true },
      location: { district: 'dhaka', area: 'Mirpur' },
      deliveryPreference: 'EITHER',
      publish: true,
    },
  }),
  201,
  'post a need',
);
const needId = need.data.id;
if (need.data.status !== 'OPEN') fail('need should be OPEN', need.data);
log('buyer posted a Need: "Used iPhone 15 Pro, 256GB", Dhaka, up to ৳80,000');

const match = await eventually('matching to find the seller', async () => {
  const r = await api('GET', `/api/v1/needs/${needId}/matches`, { token: buyer.token });
  return r.status === 200 && r.body.data.find((m) => m.sellerId === seller.id);
});
log(
  `matching found the seller (score ${match.score}, ${Object.keys(match.reasons).length} explained factors)`,
);

await eventually('seller to see the matched need', async () => {
  const r = await api('GET', '/api/v1/me/matched-needs', { token: seller.token });
  return r.status === 200 && r.body.data.some((m) => m.need.id === needId);
});
await eventually('seller to be notified of the match', async () => {
  const r = await api('GET', '/api/v1/me/notifications', { token: seller.token });
  return r.status === 200 && r.body.data.some((n) => n.type === 'NEED_MATCHED');
});
log('seller sees the need in their matched feed and got a NEED_MATCHED notification');

const offer = await expectStatus(
  api('POST', `/api/v1/needs/${needId}/offers`, {
    token: seller.token,
    idem: idem(),
    body: {
      price: { amount: 7_800_000, currency: 'BDT' },
      quantity: 1,
      listingId: listing.data.id,
      condition: 'USED',
      deliveryTerms: { method: 'SELLER_DELIVERY', etaDays: 1 },
      modeTerms: { warrantyMonths: 1 },
      description: 'Original box and charger included.',
    },
  }),
  201,
  'submit offer',
);
const offerId = offer.data.id;
log('seller sent an offer: ৳78,000 with delivery in a day');

await eventually('buyer to see the offer', async () => {
  const r = await api('GET', `/api/v1/needs/${needId}/offers`, { token: buyer.token });
  return r.status === 200 && r.body.data.some((o) => o.id === offerId);
});
await eventually('buyer to be notified of the offer', async () => {
  const r = await api('GET', '/api/v1/me/notifications', { token: buyer.token });
  return r.status === 200 && r.body.data.some((n) => n.type === 'OFFER_RECEIVED');
});
log('buyer sees the offer in the compare view and got an OFFER_RECEIVED notification');

await expectStatus(
  api('POST', `/api/v1/offers/${offerId}/counter`, {
    token: buyer.token,
    idem: idem(),
    body: {
      price: { amount: 7_500_000, currency: 'BDT' },
      quantity: 1,
      message: 'Can you do ৳75,000?',
    },
  }),
  200,
  'buyer counter',
);
const acceptKey = idem();
const accepted = await expectStatus(
  api('POST', `/api/v1/offers/${offerId}/accept`, { token: seller.token, idem: acceptKey }),
  200,
  'seller accepts',
);
const replay = await expectStatus(
  api('POST', `/api/v1/offers/${offerId}/accept`, { token: seller.token, idem: acceptKey }),
  200,
  'accept retry',
);
if (JSON.stringify(replay) !== JSON.stringify(accepted))
  fail('idempotent accept retry returned a different response');
log('buyer countered at ৳75,000; seller accepted (a retried accept was safely de-duplicated)');

const tx = await eventually('the transaction to be created', async () => {
  const r = await api('GET', '/api/v1/me/transactions', { token: buyer.token });
  return r.status === 200 && r.body.data.find((t) => t.sourceId === offerId);
});
if (tx.amount.amount !== 7_500_000) fail('transaction amount should be the agreed ৳75,000', tx);
log(
  `transaction created from the accepted offer for ৳${(tx.amount.amount / 100).toLocaleString('en-US')}`,
);

await eventually('the need to be FULFILLING', async () => {
  const r = await api('GET', `/api/v1/needs/${needId}`, { token: buyer.token });
  return r.body?.data?.status === 'FULFILLING';
});

const txPath = `/api/v1/transactions/${tx.id}`;
await expectStatus(
  api('POST', `${txPath}/confirm`, { token: buyer.token, idem: idem() }),
  200,
  'buyer confirms',
);
await expectStatus(
  api('POST', `${txPath}/confirm`, { token: seller.token, idem: idem() }),
  200,
  'seller confirms',
);
await expectStatus(
  api('POST', `${txPath}/arrange-delivery`, {
    token: seller.token,
    idem: idem(),
    body: { method: 'SELLER_DELIVERY', notes: 'Evening, Mirpur 10' },
  }),
  200,
  'arrange delivery',
);
await expectStatus(
  api('POST', `${txPath}/mark-delivered`, { token: seller.token, idem: idem() }),
  200,
  'mark delivered',
);
const done = await expectStatus(
  api('POST', `${txPath}/confirm-receipt`, { token: buyer.token, idem: idem() }),
  200,
  'confirm receipt',
);
if (done.data.state !== 'COMPLETED') fail('transaction should be COMPLETED', done.data);
log('both confirmed, seller delivered, buyer confirmed receipt → COMPLETED (cash)');

await eventually('the need to be FULFILLED', async () => {
  const r = await api('GET', `/api/v1/needs/${needId}`, { token: buyer.token });
  return r.body?.data?.status === 'FULFILLED';
});
log('the Need is FULFILLED');

await eventually('the review to be accepted', async () => {
  const r = await api('POST', `/api/v1/transactions/${tx.id}/reviews`, {
    token: buyer.token,
    body: { rating: 5, comment: 'Exactly as described, fast delivery.' },
  });
  return r.status === 201;
});
const profile = await eventually('reputation to reach the public profile', async () => {
  const r = await api('GET', `/api/v1/users/${seller.id}`);
  const rep = r.body?.data?.reputation;
  return rep && rep.completedCount >= 1 && rep.ratingCount >= 1 && r.body.data;
});
if (JSON.stringify(profile).includes(seller.id) && JSON.stringify(profile).match(/\+880\d{10}/))
  fail('public profile leaked a phone number', profile);
log(
  `buyer reviewed the seller 5★; public profile shows ${profile.reputation.completedCount} completed, rating ${profile.reputation.ratingAverage}`,
);

const reviews = await expectStatus(
  api('GET', `/api/v1/users/${seller.id}/reviews`),
  200,
  'public reviews',
);
if (!reviews.data.some((r) => r.rating === 5)) fail('review not listed publicly', reviews);
await eventually('seller notified of the review', async () => {
  const r = await api('GET', '/api/v1/me/notifications', { token: seller.token });
  return r.status === 200 && r.body.data.some((n) => n.type === 'REVIEW_RECEIVED');
});
log('review is public and the seller was notified');

const stranger = await signIn('stranger');
await expectStatus(
  api('GET', txPath, { token: stranger.token }),
  404,
  'stranger reading the transaction',
);
await expectStatus(
  api('GET', `/api/v1/needs/${needId}/offers`, { token: stranger.token }),
  404,
  'stranger reading offers',
);
await expectStatus(
  api('GET', `/api/v1/offers/${randomUUID()}`, { token: stranger.token }),
  404,
  'unknown offer',
);
log('a third user cannot see the transaction or the offers (404, no leaks)');

console.log(`\n\x1b[32mEnd-to-end marketplace loop passed (${steps()} steps).\x1b[0m`);
