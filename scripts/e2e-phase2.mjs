// End-to-end check of the Phase 2 features through the gateway, with every service running
// (`pnpm dev:backend`) and real events flowing between them:
//
//   1. forward auction → outbid → award → transaction
//   2. reverse auction on a SOURCE need → award → transaction → need FULFILLING
//   3. rental: terms, availability, instant book, overlap refused, hand-over → return → CLOSED
//   4. lending: lend item → borrow request → approval → BORROW deal → return → loan CLOSED
//   5. messaging: contact info refused, unread counts, long poll
//   6. dispute: BUY deal disputed after delivery → case → statement → admin RELEASE
//   7. dashboard: cross-service activity log, filters, CSV, metrics, personal dashboard, 403s
//   8. push: device registration → a later notification lands in var/dev-push.log
//
// Every run uses fresh accounts, so it can run repeatedly against the same database.
// Auctions must run for at least an hour; the script ends them early by moving
// bidding.auctions.ends_at to now() in Postgres (dev-only time travel), then waits for the
// close job (every 15 s).
//
//   pnpm e2e:phase2      (exits non-zero on the first failed expectation)
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDevEnv, ROOT, SERVICES, serviceEnv } from './backend-services.mjs';
import {
  api,
  CATEGORIES,
  eventually,
  expectStatus,
  fail,
  idem,
  log,
  note,
  phone,
  publishListing,
  rateLimitWaits,
  requireGateway,
  section,
  setUpSeller,
  signIn,
  sleep,
  steps,
  taka,
} from './e2e-lib.mjs';
import pg from './pg-shim.mjs';

const PUSH_LOG = resolve(ROOT, 'var/dev-push.log');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BDT = (amount) => ({ amount, currency: 'BDT' });
const dev = readDevEnv();
const startedAt = new Date();

/** Every account this run creates, for the dashboard checks. */
const actors = [];
async function user(label, p) {
  const u = await signIn(label, p);
  actors.push(u);
  return u;
}

/** Retries a command until a service's projection has caught up (404 while it has not). */
async function whenProjected(what, run, expected = 201) {
  let last;
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    last = await run();
    if (last.status === expected) return last.body;
    if (last.status !== 404 && last.status !== 422) break;
    await sleep(250);
  }
  fail(`${what}: expected ${expected}, last got ${last.status}`, last.body);
}

const ruleOf = (body) => body?.error?.details?.rule;

/** The member's own dashboard once `pick` finds what it expects in it. */
async function myDashboard(u, what, pick) {
  return eventually(what, async () => {
    const r = await api('GET', '/api/v1/me/dashboard', { token: u.token });
    return r.status === 200 && pick(r.body.data) && r.body.data;
  });
}

async function txFor(u, sourceId, what) {
  return eventually(what, async () => {
    const r = await api('GET', '/api/v1/me/transactions', { token: u.token });
    return r.status === 200 && r.body.data.find((t) => t.sourceId === sourceId);
  });
}

async function txCommand(u, txId, command, body) {
  return expectStatus(
    api('POST', `/api/v1/transactions/${txId}/${command}`, { token: u.token, idem: idem(), body }),
    200,
    `${u.label} ${command}`,
  );
}

/** Dev-only time travel: ends an auction now, then waits for the close job to award it. */
async function fastForwardAuction(auctionId, owner) {
  const env = serviceEnv('bidding', dev);
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `update ${SERVICES.bidding.schema}.auctions set ends_at = now() where id = $1 and status = 'OPEN'`,
      [auctionId],
    );
    if (r.rowCount !== 1) fail('time travel: auction not found or not OPEN', { auctionId });
  } finally {
    await client.end();
  }
  note('DEV-ONLY TIME TRAVEL: set bidding.auctions.ends_at = now() (auctions last ≥ 1h)');
  note('waiting for the bidding close job (runs every 15s)…');
  return eventually(
    'the close job to award the auction',
    async () => {
      const r = await api('GET', `/api/v1/auctions/${auctionId}`, { token: owner.token });
      return ['AWARDED', 'SETTLED'].includes(r.body?.data?.status) && r.body.data;
    },
    40_000,
  );
}

async function bid(u, auctionId, amount) {
  return api('POST', `/api/v1/auctions/${auctionId}/bids`, {
    token: u.token,
    idem: idem(),
    body: { amount: BDT(amount) },
  });
}

// ------------------------------------------------------------------------------------------------

await requireGateway();

// ================================================================ 1. forward auction
section('1. Forward auction');

const auctioneer = await user('auctioneer');
const bidderA = await user('bidder A');
const bidderB = await user('bidder B');
await setUpSeller(auctioneer, {
  displayName: 'Karim Gadget Corner',
  categoryIds: [CATEGORIES.MOBILE_PHONES],
});
const auctionListing = await publishListing(auctioneer, {
  categoryId: CATEGORIES.MOBILE_PHONES,
  kind: 'PRODUCT',
  title: 'Samsung Galaxy S24 Ultra, 512GB',
  price: BDT(12_000_000),
  priceUnit: 'TOTAL',
});
log('seller signed in, set up a business profile and published a PRODUCT listing');

const fwd = await whenProjected('the forward auction to be created', () =>
  api('POST', '/api/v1/auctions', {
    token: auctioneer.token,
    idem: idem(),
    body: {
      kind: 'FORWARD',
      subjectId: auctionListing.id,
      startPrice: BDT(9_000_000),
      minIncrement: BDT(100_000),
      endsAt: new Date(Date.now() + HOUR + 5 * 60_000).toISOString(),
    },
  }),
);
const auctionId = fwd.data.id;
if (fwd.data.status !== 'OPEN') fail('auction should open immediately', fwd.data);
log(`seller auctioned the listing: opening ${taka(9_000_000)}, +${taka(100_000)} steps, 1h05m`);

await expectStatus(bid(bidderA, auctionId, 9_000_000), 201, 'bidder A bids');
const bBid = await expectStatus(bid(bidderB, auctionId, 9_200_000), 201, 'bidder B bids');
if (bBid.data.auction.leadingAmount.amount !== 9_200_000) fail('B should lead', bBid.data);
await eventually('bidder A to be told they were outbid', async () => {
  const r = await api('GET', '/api/v1/me/notifications', { token: bidderA.token });
  return r.status === 200 && r.body.data.some((n) => n.type === 'BID_OUTBID');
});
log(
  `bidder A bid ${taka(9_000_000)}, bidder B ${taka(9_200_000)}; A got a BID_OUTBID notification`,
);

const self = await bid(bidderB, auctionId, 9_400_000);
if (self.status !== 422 || ruleOf(self.body) !== 'ALREADY_LEADING')
  fail('the leader bidding against themselves should be refused', self);
log('the leader bidding against themselves is refused (422 ALREADY_LEADING)');

const fwdClosed = await fastForwardAuction(auctionId, auctioneer);
if (fwdClosed.winnerId !== bidderB.id) fail('bidder B should win', fwdClosed);
const fwdTx = await txFor(bidderB, auctionId, 'the transaction from the award');
if (fwdTx.sourceType !== 'AUCTION' || fwdTx.amount.amount !== 9_200_000)
  fail('award transaction should be the winning bid', fwdTx);
if (fwdTx.sellerId !== auctioneer.id || fwdTx.mode !== 'BUY')
  fail('award transaction has the wrong parties or mode', fwdTx);
log(`auction closed and AWARDED to B; transaction created for ${taka(fwdTx.amount.amount)}`);

// ================================================================ 2. reverse auction
section('2. Reverse auction on a SOURCE need');

const sourcer = await user('sourcing buyer');
const supplierA = await user('supplier A');
const supplierB = await user('supplier B');
for (const [s, name] of [
  [supplierA, 'Narayanganj Jute Works'],
  [supplierB, 'Bogura Packaging Ltd'],
]) {
  await setUpSeller(s, {
    displayName: name,
    categoryIds: [CATEGORIES.BAGS_PACKAGING],
    roles: ['SUPPLIER'],
  });
}
const sourceNeed = await expectStatus(
  api('POST', '/api/v1/needs', {
    token: sourcer.token,
    body: {
      mode: 'SOURCE',
      categoryId: CATEGORIES.BAGS_PACKAGING,
      title: '1,000 printed jute tote bags',
      description: 'Logo on one side, natural colour.',
      quantity: 1000,
      budget: { max: BDT(25_000_000), flexible: false },
      condition: ['NEW'],
      attributes: { material: 'Jute', quantityMin: 1000 },
      modeTerms: { specifications: '40x35 cm, 1-colour print, cotton handles' },
      location: { district: 'dhaka', area: 'Tejgaon' },
      deliveryPreference: 'EITHER',
      publish: true,
    },
  }),
  201,
  'post a SOURCE need',
);
const sourceNeedId = sourceNeed.data.id;
log('buyer posted a SOURCE need: 1,000 jute bags, up to ৳250,000');

const rev = await whenProjected('the reverse auction to be created', () =>
  api('POST', '/api/v1/auctions', {
    token: sourcer.token,
    idem: idem(),
    body: {
      kind: 'REVERSE',
      subjectId: sourceNeedId,
      minIncrement: BDT(200_000),
      endsAt: new Date(Date.now() + HOUR + 5 * 60_000).toISOString(),
    },
  }),
);
const revId = rev.data.id;
if (rev.data.startPrice.amount !== 25_000_000) fail('ceiling should be the budget', rev.data);
log(`buyer ran a REVERSE auction on the need (ceiling ${taka(25_000_000)})`);

await expectStatus(bid(supplierA, revId, 23_000_000), 201, 'supplier A bids');
await expectStatus(bid(supplierB, revId, 22_000_000), 201, 'supplier B bids');
const tooHigh = await bid(supplierA, revId, 21_900_000);
if (tooHigh.status !== 422 || ruleOf(tooHigh.body) !== 'BID_TOO_HIGH')
  fail('a bid that does not undercut by the decrement should be refused', tooHigh);
await expectStatus(bid(supplierA, revId, 21_500_000), 201, 'supplier A bids lower');
log(
  `suppliers bid down: A ${taka(23_000_000)} → B ${taka(22_000_000)} → A ${taka(21_500_000)} (too-small cut refused)`,
);

const revClosed = await fastForwardAuction(revId, sourcer);
if (revClosed.winnerId !== supplierA.id) fail('supplier A should win', revClosed);
const revTx = await txFor(sourcer, revId, 'the transaction from the reverse award');
if (
  revTx.sellerId !== supplierA.id ||
  revTx.buyerId !== sourcer.id ||
  revTx.mode !== 'SOURCE' ||
  revTx.needId !== sourceNeedId ||
  revTx.amount.amount !== 21_500_000
)
  fail('reverse award transaction is wrong', revTx);
await eventually('the SOURCE need to be FULFILLING', async () => {
  const r = await api('GET', `/api/v1/needs/${sourceNeedId}`, { token: sourcer.token });
  return r.body?.data?.status === 'FULFILLING';
});
log(`awarded to supplier A → SOURCE transaction for ${taka(21_500_000)} → need FULFILLING`);

// ================================================================ 3. rental
section('3. Rental');

const owner = await user('rental owner');
const renter = await user('renter');
const renter2 = await user('second renter');
await setUpSeller(owner, {
  displayName: 'Dhanmondi Laptop Rentals',
  categoryIds: [CATEGORIES.LAPTOPS],
});
const rentalListing = await publishListing(owner, {
  categoryId: CATEGORIES.LAPTOPS,
  kind: 'RENTAL',
  title: 'MacBook Pro 14 for rent',
  price: BDT(150_000),
  priceUnit: 'PER_DAY',
});
const terms = await whenProjected(
  'rental terms to be accepted',
  () =>
    api('PUT', `/api/v1/listings/${rentalListing.id}/rental-terms`, {
      token: owner.token,
      body: {
        instantBook: true,
        minDurationHours: 24,
        maxDurationDays: 14,
        deposit: BDT(1_000_000),
        advanceNoticeHours: 2,
        bufferHours: 0,
        cancellationNote: 'Free cancellation until confirmation.',
      },
    }),
  200,
);
if (!terms.data.instantBook) fail('instant book should be on', terms.data);
log(`owner published a RENTAL listing (${taka(150_000)}/day) with instant-book terms`);

// Start about a day ahead (well past the 2h advance notice), on a whole minute.
const rentStart = new Date(Math.ceil((Date.now() + DAY) / 60_000) * 60_000);
const rentEnd = new Date(rentStart.getTime() + 2 * DAY);
const window = `from=${encodeURIComponent(new Date(rentStart.getTime() - DAY).toISOString())}&to=${encodeURIComponent(new Date(rentEnd.getTime() + DAY).toISOString())}`;
const free = await expectStatus(
  api('GET', `/api/v1/listings/${rentalListing.id}/availability?${window}`),
  200,
  'availability',
);
if (free.data.busy.length !== 0) fail('a new listing should be free', free.data);
log('availability shows the listing free');

const held = await whenProjected('the booking to be accepted', () =>
  api('POST', '/api/v1/bookings', {
    token: renter.token,
    idem: idem(),
    body: {
      listingId: rentalListing.id,
      startAt: rentStart.toISOString(),
      endAt: rentEnd.toISOString(),
      note: 'For a conference in Chattogram.',
    },
  }),
);
if (held.data.status !== 'HELD') fail('instant book should hold the slot', held.data);
const bookingId = held.data.id;
const confirmed = await expectStatus(
  api('POST', `/api/v1/bookings/${bookingId}/confirm`, { token: renter.token, idem: idem() }),
  200,
  'renter confirms the hold',
);
if (confirmed.data.status !== 'CONFIRMED') fail('booking should be CONFIRMED', confirmed.data);
const rentTx = await eventually('the RENT transaction to be CONFIRMED', async () => {
  const r = await api('GET', '/api/v1/me/transactions', { token: renter.token });
  const t = r.body?.data?.find((t) => t.sourceId === bookingId);
  return t?.state === 'CONFIRMED' && t;
});
if (rentTx.mode !== 'RENT' || rentTx.sourceType !== 'BOOKING' || rentTx.amount.amount !== 300_000)
  fail('RENT transaction is wrong', rentTx);
// The personal dashboard lists live bookings (CONFIRMED / ACTIVE), so look while it is live.
const liveRental = await myDashboard(renter, 'the booking on the renter dashboard', (d) =>
  d.bookings.items.some((b) => b.bookingId === bookingId && b.role === 'RENTER'),
);
log(
  `renter booked 2 days and confirmed the hold → CONFIRMED; RENT transaction ${taka(300_000)}; on the renter's dashboard (${liveRental.bookings.asRenter} live)`,
);

const overlap = await api('POST', '/api/v1/bookings', {
  token: renter2.token,
  idem: idem(),
  body: {
    listingId: rentalListing.id,
    startAt: new Date(rentStart.getTime() + 12 * HOUR).toISOString(),
    endAt: new Date(rentEnd.getTime() + 12 * HOUR).toISOString(),
  },
});
if (overlap.status !== 409)
  fail(`overlapping booking: expected 409, got ${overlap.status}`, overlap.body);
const busy = await expectStatus(
  api('GET', `/api/v1/listings/${rentalListing.id}/availability?${window}`),
  200,
  'availability after booking',
);
if (busy.data.busy.length !== 1) fail('the booked period should show busy', busy.data);
log('an overlapping booking is refused (409) and availability shows the period busy');

await txCommand(owner, rentTx.id, 'hand-over');
await txCommand(renter, rentTx.id, 'report-return');
await txCommand(owner, rentTx.id, 'confirm-return');
const rentDone = await txCommand(owner, rentTx.id, 'complete');
if (rentDone.data.state !== 'COMPLETED')
  fail('RENT transaction should be COMPLETED', rentDone.data);
log('hand-over → report-return → confirm-return → complete → COMPLETED');

await eventually('the booking to mirror CLOSED', async () => {
  const r = await api('GET', `/api/v1/bookings/${bookingId}`, { token: renter.token });
  return r.body?.data?.status === 'CLOSED';
});
await eventually('the renter review to be accepted', async () => {
  const r = await api('POST', `/api/v1/transactions/${rentTx.id}/reviews`, {
    token: renter.token,
    body: { rating: 5, comment: 'Laptop was spotless and fully charged.' },
  });
  return r.status === 201;
});
log('the booking mirrors CLOSED and the renter reviewed the owner');

// ================================================================ 4. lending
section('4. Lending');

const lender = await user('lender');
const borrower = await user('borrower');
// Laptops accept BORROW (seed: BUY, RENT, BORROW).
const item = await whenProjected('the lend item to be accepted', () =>
  api('POST', '/api/v1/lend-items', {
    token: lender.token,
    idem: idem(),
    body: {
      categoryId: CATEGORIES.LAPTOPS,
      title: 'Lenovo ThinkPad for students',
      description: 'Happy to lend for exams.',
      condition: 'USED',
      district: 'dhaka',
      maxLoanDays: 7,
    },
  }),
);
const itemId = item.data.id;
log('lender put a laptop on their lending shelf (category Laptops accepts BORROW)');

const loanReq = await whenProjected('the borrow request to be accepted', () =>
  api('POST', '/api/v1/loans', {
    token: borrower.token,
    idem: idem(),
    body: {
      itemId,
      startAt: new Date(Date.now() + HOUR).toISOString(),
      returnBy: new Date(Date.now() + 3 * DAY).toISOString(),
      message: 'Need it for my final exams, will take good care.',
    },
  }),
);
const loanId = loanReq.data.id;
if (loanReq.data.status !== 'REQUESTED') fail('loan should be REQUESTED', loanReq.data);
const approved = await expectStatus(
  api('POST', `/api/v1/loans/${loanId}/approve`, { token: lender.token, idem: idem() }),
  200,
  'lender approves',
);
if (approved.data.status !== 'APPROVED') fail('loan should be APPROVED', approved.data);
const loanTx = await eventually('the BORROW transaction', async () => {
  const r = await api('GET', '/api/v1/me/transactions', { token: borrower.token });
  const t = r.body?.data?.find((t) => t.sourceId === loanId);
  return t?.state === 'CONFIRMED' && t;
});
if (loanTx.mode !== 'BORROW' || loanTx.sourceType !== 'LOAN' || loanTx.amount.amount !== 0)
  fail('BORROW transaction is wrong', loanTx);
const liveLoan = await myDashboard(lender, 'the loan on the lender dashboard', (d) =>
  d.loans.items.some((l) => l.loanId === loanId && l.role === 'LENDER'),
);
log(
  `borrower asked, lender approved → BORROW transaction (amount ৳0), CONFIRMED; on the lender's dashboard (${liveLoan.loans.asLender} live)`,
);

await txCommand(lender, loanTx.id, 'hand-over');
await txCommand(borrower, loanTx.id, 'report-return');
await txCommand(lender, loanTx.id, 'confirm-return');
const loanDone = await txCommand(lender, loanTx.id, 'complete');
if (loanDone.data.state !== 'COMPLETED')
  fail('BORROW transaction should be COMPLETED', loanDone.data);
await eventually('the loan to be CLOSED', async () => {
  const r = await api('GET', `/api/v1/loans/${loanId}`, { token: borrower.token });
  return r.body?.data?.status === 'CLOSED';
});
log('hand-over → report-return → confirm-return → complete; the loan is CLOSED');

// ================================================================ 5. messaging
section('5. Messaging');

const chatSeller = await user('chat seller');
const chatBuyer = await user('chat buyer');
const chatListing = await publishListing(chatSeller, {
  categoryId: CATEGORIES.MOBILE_PHONES,
  kind: 'PRODUCT',
  title: 'Pixel 8, 128GB, boxed',
  price: BDT(5_500_000),
  priceUnit: 'TOTAL',
});
const conv = await whenProjected('the conversation to open', () =>
  api('POST', '/api/v1/conversations', {
    token: chatBuyer.token,
    body: { contextType: 'LISTING', contextId: chatListing.id },
  }),
);
const convId = conv.data.id;
if (conv.data.otherParticipantId !== chatSeller.id) fail('wrong participant', conv.data);
log('buyer opened a conversation about the listing');

const leaky = await api('POST', `/api/v1/conversations/${convId}/messages`, {
  token: chatBuyer.token,
  body: { body: 'Call me on 01712345678 please', clientId: randomUUID() },
});
if (leaky.status !== 422)
  fail(`phone number in a message: expected 422, got ${leaky.status}`, leaky.body);
log('a message containing a phone number is rejected (422)');

const first = await expectStatus(
  api('POST', `/api/v1/conversations/${convId}/messages`, {
    token: chatBuyer.token,
    body: { body: 'Is the battery still original?', clientId: randomUUID() },
  }),
  201,
  'send message',
);
const unread = await eventually('the seller to see 1 unread', async () => {
  const r = await api('GET', '/api/v1/conversations', { token: chatSeller.token });
  const c = r.body?.data?.find((c) => c.id === convId);
  return c?.unreadCount === 1 && c;
});
const read = await expectStatus(
  api('POST', `/api/v1/conversations/${convId}/read`, {
    token: chatSeller.token,
    body: { upToMessageId: first.data.id },
  }),
  200,
  'mark read',
);
if (read.data.unreadCount !== 0) fail('unread should be 0 after reading', read.data);
const after = await expectStatus(
  api('GET', `/api/v1/conversations/${convId}`, { token: chatSeller.token }),
  200,
  'conversation after read',
);
if (after.data.unreadCount !== 0) fail('unread should stay 0', after.data);
log(`buyer sent a message; seller saw ${unread.unreadCount} unread, read it → 0`);

const pollStart = Date.now();
const poll = api('GET', `/api/v1/conversations/${convId}/messages?after=${first.data.id}&wait=8`, {
  token: chatBuyer.token,
});
await sleep(1_000);
const reply = await expectStatus(
  api('POST', `/api/v1/conversations/${convId}/messages`, {
    token: chatSeller.token,
    body: { body: 'Yes, battery health is 94%.', clientId: randomUUID() },
  }),
  201,
  'seller replies',
);
const polled = await poll;
const pollMs = Date.now() - pollStart;
if (
  polled.status !== 200 ||
  polled.body.data.length !== 1 ||
  polled.body.data[0].id !== reply.data.id
)
  fail('long poll should return the reply', polled);
if (pollMs >= 7_000) fail(`long poll returned only after the wait (${pollMs}ms)`);
log(`a long poll (after + wait=8) returned the reply sent while waiting (${pollMs}ms)`);

// ================================================================ 6. dispute
section('6. Dispute');

// An ADMIN, granted with the identity CLI (the bootstrap path), then signed in for a token.
const adminPhone = phone();
execFileSync('npx', ['tsx', 'src/cli/grant-role.ts', adminPhone, 'ADMIN'], {
  cwd: resolve(ROOT, SERVICES.identity.dir),
  env: { ...process.env, ...serviceEnv('identity', dev), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const admin = await user('admin', adminPhone);
log('granted ADMIN with the identity CLI (grant-role) and signed in as the admin');

const dSeller = await user('dispute seller');
const dBuyer = await user('dispute buyer');
const dListing = await publishListing(dSeller, {
  categoryId: CATEGORIES.MOBILE_PHONES,
  kind: 'PRODUCT',
  title: 'iPhone 13, 128GB',
  price: BDT(4_500_000),
  priceUnit: 'TOTAL',
});
const purchase = await whenProjected('the direct purchase', () =>
  api('POST', '/api/v1/transactions', {
    token: dBuyer.token,
    idem: idem(),
    body: { listingId: dListing.id, quantity: 1 },
  }),
);
const dTx = purchase.data.id;
await txCommand(dBuyer, dTx, 'confirm');
await txCommand(dSeller, dTx, 'confirm');
await txCommand(dSeller, dTx, 'arrange-delivery', { method: 'SELLER_DELIVERY' });
await txCommand(dSeller, dTx, 'mark-delivered');
const disputed = await txCommand(dBuyer, dTx, 'dispute', {
  reason: 'The screen has a crack that was not in the photos.',
  category: 'NOT_AS_DESCRIBED',
});
if (disputed.data.state !== 'DISPUTED') fail('transaction should be DISPUTED', disputed.data);
log('buyer bought a listing directly; after delivery the buyer disputed it (NOT_AS_DESCRIBED)');

const dispute = await eventually('the dispute case to open', async () => {
  const r = await api('GET', '/api/v1/me/disputes', { token: dSeller.token });
  return r.status === 200 && r.body.data.find((d) => d.transactionId === dTx);
});
if (dispute.reason !== 'NOT_AS_DESCRIBED' || dispute.openedBy !== 'BUYER')
  fail('dispute case is wrong', dispute);
const stated = await expectStatus(
  api('POST', `/api/v1/disputes/${dispute.id}/statement`, {
    token: dSeller.token,
    idem: idem(),
    body: { text: 'The phone left in perfect condition; the delivery video shows no crack.' },
  }),
  200,
  'seller statement',
);
if (!stated.data.statementSubmitted) fail('statement should be recorded', stated.data);
log(`dispute-service opened the case (${dispute.status}); the seller submitted a statement`);

const resolved = await expectStatus(
  api('POST', `/api/v1/admin/disputes/${dispute.id}/resolve`, {
    token: admin.token,
    idem: idem(),
    body: { resolution: 'RELEASE', note: 'Delivery video shows the phone intact.' },
  }),
  200,
  'admin resolves',
);
if (resolved.data.resolution !== 'RELEASE') fail('resolution should be RELEASE', resolved.data);
await eventually('the transaction to be COMPLETED by the resolution', async () => {
  const r = await api('GET', `/api/v1/transactions/${dTx}`, { token: dBuyer.token });
  return r.body?.data?.state === 'COMPLETED';
});
log('the admin resolved RELEASE → the transaction is COMPLETED');

// ================================================================ 7. dashboard
section('7. Dashboard');

/** This run's entries in the unfiltered admin log (newest first, since the run started). */
async function runActivity() {
  const ids = new Set(actors.map((a) => a.id));
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = `from=${encodeURIComponent(startedAt.toISOString())}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api('GET', `/api/v1/admin/activity?${q}`, { token: admin.token });
    if (r.status !== 200) fail('admin activity', r.body);
    entries.push(...r.body.data.filter((e) => ids.has(e.actor.id)));
    cursor = r.body.page.nextCursor;
    if (!cursor) break;
  }
  return entries;
}
const services = await eventually(
  'activity from at least 5 services for this run',
  async () => {
    const s = new Set((await runActivity()).map((e) => e.service));
    return s.size >= 5 && s;
  },
  20_000,
  2_000,
);
log(
  `admin activity log has this run's actors in ${services.size} services: ${[...services].sort().join(', ')}`,
);

const renterActivity = await expectStatus(
  api('GET', `/api/v1/admin/activity?actorId=${renter.id}`, { token: admin.token }),
  200,
  'activity by actor',
);
if (!renterActivity.data.length || renterActivity.data.some((e) => e.actor.id !== renter.id))
  fail('filter by actorId should return only the renter', renterActivity.data);
const csv = await api('GET', `/api/v1/admin/activity/export?actorId=${renter.id}`, {
  token: admin.token,
  accept: 'text/csv',
});
if (csv.status !== 200 || !csv.headers.get('content-type')?.startsWith('text/csv'))
  fail('CSV export', { status: csv.status, type: csv.headers.get('content-type') });
const csvLines = String(csv.body)
  .replace(/^\uFEFF/, '')
  .trim()
  .split('\n');
if (csvLines.length < 2 || !csvLines.slice(1).every((l) => l.includes(renter.id)))
  fail('CSV should have a header and the renter rows', csvLines.slice(0, 3));
log(
  `filtering by actorId works (${renterActivity.data.length} entries); CSV export returned ${csvLines.length - 1} rows`,
);

const summary = await eventually('dashboard counters', async () => {
  const r = await api('GET', '/api/v1/admin/dashboard/summary', { token: admin.token });
  if (r.status !== 200) fail('dashboard summary', r.body);
  const today = r.body.data.periods.find((p) => p.days === 1) ?? r.body.data.periods[0];
  const m = Object.fromEntries(today.metrics.map((x) => [x.metric, x.current]));
  const wanted = ['signups', 'auctions_opened', 'bookings_confirmed', 'loans_approved'];
  return wanted.every((k) => m[k] > 0) && Object.fromEntries(wanted.map((k) => [k, m[k]]));
});
log(
  `dashboard summary counters today: ${Object.entries(summary)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`,
);

// Completed deals stay on the personal dashboard as totals (live items were checked above).
const renterDash = await myDashboard(
  renter,
  "the renter's completed rental",
  (d) => d.buyer.transactionsByState.COMPLETED >= 1 && d.buyer.totalSpent.amount === 300_000,
);
const ownerDash = await myDashboard(
  owner,
  "the owner's earnings and rating",
  (d) => d.seller.earnings.amount === 300_000 && d.seller.rating?.count === 1,
);
const lenderDash = await myDashboard(
  lender,
  "the lender's completed loan",
  (d) => d.seller.transactionsByState.COMPLETED >= 1,
);
if (renterDash.bookings.items.length || lenderDash.loans.items.length)
  fail('closed bookings and loans should not be listed as live', { renterDash, lenderDash });
const myActivity = await expectStatus(
  api('GET', '/api/v1/me/activity', { token: renter.token }),
  200,
  'my activity',
);
if (!myActivity.data.length || myActivity.data.some((e) => e.actor !== null || 'ipHash' in e))
  fail('my activity should list only my own actions, without staff fields', myActivity.data);
log(
  `members see their own dashboard (renter spent ${taka(renterDash.buyer.totalSpent.amount)}, owner earned ${taka(ownerDash.seller.earnings.amount)} rated ${ownerDash.seller.rating.average}★, lender ${lenderDash.seller.transactionsByState.COMPLETED} completed loan) and activity (${myActivity.data.length} entries)`,
);

for (const path of [
  '/api/v1/admin/activity',
  '/api/v1/admin/activity/export',
  '/api/v1/admin/dashboard/summary',
]) {
  await expectStatus(api('GET', path, { token: renter.token }), 403, `member on ${path}`);
}
log('a member gets 403 on the admin activity, export and summary routes');

// ================================================================ 8. push
section('8. Push');

const pushUser = await user('push seller');
const pushPeer = await user('push buyer');
const pushListing = await publishListing(pushUser, {
  categoryId: CATEGORIES.MOBILE_PHONES,
  kind: 'PRODUCT',
  title: 'OnePlus 12, 256GB',
  price: BDT(6_000_000),
  priceUnit: 'TOTAL',
});
const fcmToken = `e2e-fcm-${randomBytes(24).toString('base64url')}`;
const device = await expectStatus(
  api('POST', '/api/v1/me/notifications/push-devices', {
    token: pushUser.token,
    body: { platform: 'ANDROID', token: fcmToken },
  }),
  200,
  'register push device',
);
if (JSON.stringify(device).includes(fcmToken)) fail('device response echoed the token', device);
log('seller registered an Android push device');

const pushConv = await whenProjected('the push conversation to open', () =>
  api('POST', '/api/v1/conversations', {
    token: pushPeer.token,
    body: { contextType: 'LISTING', contextId: pushListing.id },
  }),
);
const secret = `Can we meet at Bashundhara City ${randomBytes(4).toString('hex')}?`;
await expectStatus(
  api('POST', `/api/v1/conversations/${pushConv.data.id}/messages`, {
    token: pushPeer.token,
    body: { body: secret, clientId: randomUUID() },
  }),
  201,
  'message to the push user',
);
// The file provider records the device id (never the token or account); the device is this user's.
const devices = await expectStatus(
  api('GET', '/api/v1/me/notifications/push-devices', { token: pushUser.token }),
  200,
  'my push devices',
);
if (!devices.data.some((d) => d.id === device.data.id)) fail('device not listed', devices.data);
const deviceLines = () =>
  existsSync(PUSH_LOG)
    ? readFileSync(PUSH_LOG, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.includes(device.data.id))
    : [];
const pushed = await eventually('a NEW_MESSAGE push for the device in var/dev-push.log', async () =>
  deviceLines()
    .map((l) => JSON.parse(l))
    .find((l) => l.deviceId === device.data.id && l.message.type === 'NEW_MESSAGE'),
);
const phones = [pushUser.phone, pushPeer.phone].flatMap((p) => [
  p,
  `+880${p.slice(1)}`,
  p.slice(1),
]);
for (const line of deviceLines()) {
  if (
    line.includes(secret) ||
    line.includes('Bashundhara') ||
    line.includes(fcmToken) ||
    phones.some((p) => line.includes(p)) ||
    /\+?880\d{10}|\b01\d{9}\b/.test(line)
  )
    fail('push line leaked a message body, token or phone number', JSON.parse(line));
}
log(`NEW_MESSAGE push written for the device ("${pushed.message.title}"), no body or phone`);

const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
const waits = rateLimitWaits() ? `, waited out ${rateLimitWaits()} gateway 429s` : '';
console.log(`\n\x1b[32mPhase 2 end-to-end passed (${steps()} steps, ${elapsed}s${waits}).\x1b[0m`);
