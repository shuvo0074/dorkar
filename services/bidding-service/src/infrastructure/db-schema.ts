import type { AuctionKind, AuctionStatus, District, NeedMode, NeedStatus } from '@dorkar/contracts';
import type { Generated, IdempotencyTables, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { BidStatus, ListingSnapshot, SubjectType } from '../domain/auction';

/** int8 comes back from pg as a string; written as number. */
type BigIntColumn = ColumnType<string, number, number>;
type NullableBigInt = ColumnType<string | null, number | null, number | null>;
/** Identity column: read as string (int8), never written. */
type Identity = ColumnType<string, never, never>;

export interface BiddingDB extends KernelTables, IdempotencyTables {
  listing_projection: {
    listing_id: string;
    seller_id: string;
    category_id: string;
    kind: ListingSnapshot['kind'];
    title: string;
    district: District;
    price_amount: BigIntColumn;
    quantity_available: number;
    available: boolean;
    updated_at: Generated<Date>;
  };
  need_projection: {
    need_id: string;
    requester_id: string;
    mode: NeedMode;
    category_id: string;
    title: string;
    district: District;
    budget_max_amount: NullableBigInt;
    quantity: number;
    status: NeedStatus;
    updated_at: Generated<Date>;
  };
  auctions: {
    id: string;
    kind: AuctionKind;
    owner_id: string;
    subject_type: SubjectType;
    subject_id: string;
    category_id: string;
    title: string;
    district: District;
    mode: NeedMode;
    quantity: number;
    currency: Generated<string>;
    start_price_amount: BigIntColumn;
    reserve_price_amount: NullableBigInt;
    min_increment_amount: BigIntColumn;
    starts_at: Date;
    ends_at: Date;
    anti_snipe_seconds: number;
    status: AuctionStatus;
    leading_bid_id: string | null;
    leading_amount: NullableBigInt;
    bid_count: Generated<number>;
    hidden: Generated<boolean>;
    cancel_reason: string | null;
    closed_at: Date | null;
    transaction_id: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  auction_bidders: {
    auction_id: string;
    bidder_id: string;
    alias: number;
    created_at: Generated<Date>;
  };
  bids: {
    id: string;
    seq: Identity;
    auction_id: string;
    bidder_id: string;
    amount: BigIntColumn;
    currency: Generated<string>;
    status: BidStatus;
    idempotency_key: string | null;
    placed_at: Date;
    retracted_at: Date | null;
    updated_at: Generated<Date>;
  };
  auction_status_history: {
    id: string;
    auction_id: string;
    from_status: AuctionStatus | null;
    to_status: AuctionStatus;
    reason: string;
    actor_id: string | null;
    created_at: Generated<Date>;
  };
}
