import type { AttributeSchema, Condition, District, NeedMode, NeedStatus } from '@dorkar/contracts';
import type { Generated, KernelTables, Timestamp } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { DeliveryPreference, Visibility } from '../domain/need';

/** int8 comes back from pg as a string; written as number. */
type Int8 = ColumnType<string, number, number>;
type Json<T> = ColumnType<T, string, string>;

export interface DemandDB extends KernelTables {
  categories: {
    id: string;
    parent_id: string | null;
    slug: string;
    name_en: string;
    name_bn: string;
    modes: NeedMode[];
    attribute_schema: Json<AttributeSchema>;
    active: boolean;
    updated_at: Generated<Date>;
  };
  needs: {
    id: string;
    requester_id: string;
    mode: NeedMode;
    category_id: string;
    title: string;
    description: string | null;
    quantity: number;
    budget_min_amount: ColumnType<string | null, number | null, number | null>;
    budget_max_amount: ColumnType<string | null, number | null, number | null>;
    currency: Generated<'BDT'>;
    budget_flexible: boolean;
    conditions: Condition[];
    attributes: Json<Record<string, string | number | boolean>>;
    mode_terms: Json<Record<string, unknown>>;
    district: District;
    area: string | null;
    delivery_pref: DeliveryPreference;
    required_by: ColumnType<string | null, string | null, string | null>;
    ttl_days: number | null;
    expires_at: Timestamp | null;
    renewals: Generated<number>;
    max_offers: number;
    visibility: Visibility;
    status: Generated<NeedStatus>;
    status_before_hidden: NeedStatus | null;
    offer_count: Generated<number>;
    accepted_quantity: Generated<number>;
    search: ColumnType<string, never, never>;
    published_at: Timestamp | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  need_status_history: {
    id: Generated<Int8>;
    need_id: string;
    from_status: NeedStatus | null;
    to_status: NeedStatus;
    actor_id: string | null;
    reason: string;
    at: Generated<Date>;
  };
  accepted_offers: {
    offer_id: string;
    need_id: string;
    quantity: number;
    status: Generated<'ACCEPTED' | 'CANCELLED'>;
    completed: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  need_matches: {
    need_id: string;
    seller_id: string;
    created_at: Generated<Date>;
  };
}
