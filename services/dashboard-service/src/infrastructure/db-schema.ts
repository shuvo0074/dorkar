import type { ActorType } from '@dorkar/contracts';
import type { Generated, KernelTables, Timestamp } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';

/** pg returns int8/numeric as strings; inserts accept numbers. */
type Int8 = ColumnType<string, number | string, number | string>;
/** `date` columns are always read as `day::text` (pg would build a local-midnight Date). */
type Day = ColumnType<string, string, string>;
type Status<S extends string = string> = S | null;

export interface DashboardDB extends KernelTables {
  activity_log: {
    id: string;
    service: string;
    occurred_at: Timestamp;
    actor_id: string | null;
    actor_type: ActorType;
    action: string;
    target_type: string | null;
    target_id: string | null;
    request_id: string | null;
    ip_hash: string | null;
    metadata: ColumnType<Record<string, unknown>, string, string>;
    recorded_at: Generated<Date>;
  };
  actor_names: {
    account_id: string;
    display_name: string;
    updated_at: Timestamp;
  };
  daily_metrics: {
    day: Day;
    metric: string;
    dimension: Generated<string>;
    value: Int8;
  };
  needs: {
    need_id: string;
    requester_id: string;
    status: Status;
    status_at: Timestamp | null;
    published_day: Day | null;
    first_offer_at: Timestamp | null;
  };
  offers: {
    offer_id: string;
    need_id: string;
    buyer_id: string;
    seller_id: string;
    status: Status;
    status_at: Timestamp | null;
  };
  listings: {
    listing_id: string;
    seller_id: string;
    status: Status;
    status_at: Timestamp | null;
  };
  transactions: {
    transaction_id: string;
    buyer_id: string;
    seller_id: string;
    mode: string | null;
    source_type: string;
    amount: Int8 | null;
    status: Status;
    status_at: Timestamp | null;
    completed_at: Timestamp | null;
    gmv_counted: Generated<boolean>;
  };
  disputes: {
    dispute_id: string;
    transaction_id: string;
    buyer_id: string;
    seller_id: string;
    status: Status;
    status_at: Timestamp | null;
  };
  verifications: {
    account_id: string;
    kind: string;
    status: Status;
    status_at: Timestamp | null;
  };
  auctions: {
    auction_id: string;
    owner_id: string;
    status: Status;
    status_at: Timestamp | null;
    ends_at: Timestamp | null;
  };
  auction_bidders: {
    auction_id: string;
    bidder_id: string;
  };
  bookings: {
    booking_id: string;
    listing_id: string;
    owner_id: string;
    renter_id: string;
    status: Status;
    status_at: Timestamp | null;
    start_at: Timestamp | null;
    end_at: Timestamp | null;
  };
  loans: {
    loan_id: string;
    item_id: string;
    lender_id: string;
    borrower_id: string;
    status: Status;
    status_at: Timestamp | null;
    return_by: Timestamp | null;
  };
  reputations: {
    account_id: string;
    rating_average: ColumnType<string | null, string | null, string | null>;
    rating_count: number;
    completed_count: number;
    updated_at: Timestamp;
  };
}
