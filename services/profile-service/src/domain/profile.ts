import {
  findContactInfo,
  type DeliveryMode,
  type District,
  type SellerRole,
  type UserType,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export interface Profile {
  accountId: string;
  displayName: string;
  userType: UserType;
  bio: string | null;
  district: District | null;
  area: string | null;
  locale: 'en' | 'bn';
  avatarMediaId: string | null;
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SellerCapabilities {
  accountId: string;
  roles: SellerRole[];
  categoryIds: string[];
  serviceDistricts: District[];
  deliveryModes: DeliveryMode[];
  active: boolean;
}

export interface ReputationSummary {
  ratingAverage: number | null;
  ratingCount: number;
  completedCount: number;
  cancelledCount: number;
  disputedCount: number;
}

export type Badge = 'PHONE_VERIFIED' | 'NID_VERIFIED' | 'BUSINESS_VERIFIED';

/** New accounts get a neutral name until they choose one; never derived from the phone number. */
export const defaultDisplayName = (accountId: string) =>
  `Member ${accountId.replace(/-/g, '').slice(-4).toUpperCase()}`;

/** Public text must not leak contact details (phone numbers stay private on Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. People contact you through Dorkar.`,
      {
        rule: 'NO_CONTACT_INFO',
        field,
      },
    );
  }
}

/** Sellers must say what they do: an active capability needs at least one role and one category. */
export function assertCapabilitiesComplete(c: Omit<SellerCapabilities, 'accountId'>): void {
  if (c.active && (c.roles.length === 0 || c.categoryIds.length === 0)) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'Choose at least one role and one category to start receiving needs.',
      {
        rule: 'CAPABILITIES_INCOMPLETE',
      },
    );
  }
}

export const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
