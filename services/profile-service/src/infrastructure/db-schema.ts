import type { DeliveryMode, District, SellerRole, UserType } from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';

export interface ProfileDB extends KernelTables {
  profiles: {
    account_id: string;
    display_name: string;
    user_type: Generated<UserType>;
    bio: string | null;
    district: District | null;
    area: string | null;
    locale: Generated<'en' | 'bn'>;
    avatar_media_id: string | null;
    hidden: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  seller_capabilities: {
    account_id: string;
    roles: SellerRole[];
    category_ids: string[];
    service_districts: District[];
    delivery_modes: DeliveryMode[];
    active: boolean;
    updated_at: Generated<Date>;
  };
  reputation_summaries: {
    account_id: string;
    rating_average: string | null; // numeric → string from pg
    rating_count: number;
    completed_count: number;
    cancelled_count: number;
    disputed_count: number;
    updated_at: Generated<Date>;
  };
  verification_badges: {
    account_id: string;
    kind: string;
    status: string;
    updated_at: Generated<Date>;
  };
}
