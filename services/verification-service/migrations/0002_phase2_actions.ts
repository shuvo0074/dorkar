import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/** Phase 2 actions callers can evaluate: auctions, bids, rental bookings and lending. */
export const m0002Phase2Actions: Migration = {
  name: '0002_phase2_actions',
  async up(trx) {
    await sql`alter table policies drop constraint policies_action_check`.execute(trx);
    await sql`
      alter table policies add constraint policies_action_check check (action in (
        'LISTING_PUBLISH','NEED_PUBLISH','OFFER_SUBMIT','TRANSACTION_CREATE',
        'AUCTION_CREATE','BID_PLACE','BOOKING_CREATE','LEND_ITEM_PUBLISH','LOAN_REQUEST','ANY'))`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`
      delete from policies where action in
        ('AUCTION_CREATE','BID_PLACE','BOOKING_CREATE','LEND_ITEM_PUBLISH','LOAN_REQUEST')`.execute(
      trx,
    );
    await sql`alter table policies drop constraint policies_action_check`.execute(trx);
    await sql`
      alter table policies add constraint policies_action_check check (action in (
        'LISTING_PUBLISH','NEED_PUBLISH','OFFER_SUBMIT','TRANSACTION_CREATE','ANY'))`.execute(trx);
  },
};
