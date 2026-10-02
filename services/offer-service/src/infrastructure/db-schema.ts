import type { Condition, NeedMode, NeedStatus, OfferStatus } from '@dorkar/contracts';
import type { Generated, IdempotencyTables, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { DeliveryTerms, ModeTerms, OfferTerms, Party } from '../domain/offer';

/** int8 comes back from pg as a string; written as number. */
type BigIntColumn = ColumnType<string, number, number>;
/** `date` comes back as a Date at local midnight unless parsed; we cast it to text in selects. */
type DateColumn = ColumnType<string | null, string | null, string | null>;
type Json<T> = ColumnType<T, string, string>;

export interface OfferDB extends KernelTables, IdempotencyTables {
  need_projection: {
    need_id: string;
    requester_id: string;
    mode: NeedMode;
    category_id: string;
    title: string;
    quantity: number;
    max_offers: number;
    expires_at: Date;
    status: NeedStatus;
    accepted_quantity: Generated<number>;
    updated_at: Generated<Date>;
  };
  listing_projection: {
    listing_id: string;
    seller_id: string;
    available: boolean;
    updated_at: Generated<Date>;
  };
  offers: {
    id: string;
    need_id: string;
    buyer_id: string;
    seller_id: string;
    listing_id: string | null;
    status: OfferStatus;
    price_amount: BigIntColumn;
    currency: Generated<string>;
    quantity: number;
    condition: Condition | null;
    availability_from: DateColumn;
    delivery_terms: Json<DeliveryTerms>;
    mode_terms: Json<ModeTerms>;
    description: string | null;
    attachment_media_ids: string[];
    expires_at: Date;
    current_round: number;
    awaiting: Party;
    hidden: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  offer_rounds: {
    offer_id: string;
    round: number;
    proposed_by: Party;
    price_amount: BigIntColumn;
    currency: Generated<string>;
    quantity: number;
    terms: Json<OfferTerms>;
    message: string | null;
    created_at: Generated<Date>;
  };
  offer_status_history: {
    id: string;
    offer_id: string;
    from_status: OfferStatus | null;
    to_status: OfferStatus;
    reason: string;
    actor_id: string | null;
    created_at: Generated<Date>;
  };
}
