import type {
  AttributeSchema,
  AttributeValues,
  Condition,
  DeliveryMode,
  District,
  NeedMode,
} from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { HideableStatus, ListingKind, ListingStatus, PriceUnit } from '../domain/listing';

/** jsonb: pg returns the parsed value; we write JSON text. */
type Json<T> = ColumnType<T, string, string>;
/** int8: pg returns a string (never silently lose precision); we write numbers. */
type Int8 = ColumnType<string, number, number>;

export interface CatalogDB extends KernelTables {
  categories: {
    id: string;
    parent_id: string | null;
    slug: string;
    name_en: string;
    name_bn: string;
    modes: NeedMode[];
    attribute_schema: Json<AttributeSchema>;
    sort: Generated<number>;
    active: Generated<boolean>;
    version: Generated<number>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  listings: {
    id: string;
    seller_id: string;
    category_id: string;
    kind: ListingKind;
    condition: Condition | null;
    title: string;
    description: Generated<string>;
    price_amount: Int8;
    currency: Generated<string>;
    price_unit: PriceUnit;
    quantity_available: Generated<number>;
    attributes: Json<AttributeValues>;
    district: District;
    area: string | null;
    delivery_modes: DeliveryMode[];
    media_ids: string[];
    status: Generated<ListingStatus>;
    hidden_from: HideableStatus | null;
    hidden_reason: string | null;
    // `search tsvector` is a generated column; never selected or written.
    published_at: ColumnType<Date | null, never, Date | string | null>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  listing_status_history: {
    id: string;
    listing_id: string;
    from_status: ListingStatus | null;
    to_status: ListingStatus;
    actor_id: string | null;
    actor_type: 'USER' | 'ADMIN' | 'SYSTEM';
    reason: string | null;
    occurred_at: Generated<Date>;
  };
}
