import type {
  Condition,
  DeliveryMode,
  District,
  NeedMode,
  NeedStatus,
  SellerRole,
} from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { ListingKind, MatchStatus, PriceUnit } from '../domain/matching';

/** int8 comes back from pg as a string; written as number. */
type BigIntColumn = ColumnType<string, number, number>;
type NullableBigInt = ColumnType<string | null, number | null, number | null>;
/** jsonb: read as parsed JSON, written as a JSON string. */
type Json<T> = ColumnType<T, string, string>;

export interface MatchingDB extends KernelTables {
  categories: {
    id: string;
    parent_id: string | null;
    modes: NeedMode[];
    active: boolean;
    updated_at: Generated<Date>;
  };
  needs: {
    need_id: string;
    requester_id: string;
    mode: NeedMode;
    category_id: string;
    title: string;
    quantity: number;
    budget_min_amount: NullableBigInt;
    budget_max_amount: NullableBigInt;
    currency: Generated<string>;
    conditions: Condition[];
    district: District;
    attributes: Json<Record<string, unknown>>;
    expires_at: ColumnType<Date, string | Date, string | Date>;
    status: Generated<NeedStatus>;
    published_at: ColumnType<Date, string | Date | undefined, string | Date>;
    updated_at: Generated<Date>;
  };
  listings: {
    listing_id: string;
    seller_id: string;
    category_id: string;
    kind: ListingKind;
    condition: Condition | null;
    price_amount: BigIntColumn;
    currency: Generated<string>;
    price_unit: PriceUnit;
    quantity_available: number;
    district: District;
    attributes: Json<Record<string, unknown>>;
    delivery_modes: DeliveryMode[];
    available: Generated<boolean>;
    updated_at: Generated<Date>;
  };
  sellers: {
    account_id: string;
    roles: SellerRole[];
    category_ids: string[];
    service_districts: District[];
    delivery_modes: DeliveryMode[];
    active: boolean;
    updated_at: Generated<Date>;
  };
  seller_signals: {
    account_id: string;
    rating_average: string | null; // numeric → string from pg
    rating_count: Generated<number>;
    completed_count: Generated<number>;
    nid_verified: Generated<boolean>;
    updated_at: Generated<Date>;
  };
  matches: {
    id: string;
    need_id: string;
    seller_id: string;
    listing_id: string | null;
    candidate_type: 'LISTING' | 'SELLER';
    score: ColumnType<string, number, number>; // numeric(5,2)
    reasons: Json<Record<string, number>>;
    scorer: string;
    status: Generated<MatchStatus>;
    responded_at: Date | null;
    dismissed_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
