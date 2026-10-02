import { z } from 'zod';

/** Money is always integer poisha (1 Taka = 100 poisha) plus an ISO currency. Never floats. */
export const MoneySchema = z.object({
  amount: z.number().int().min(0).max(100_000_000_000), // ≤ ৳1,000,000,000
  currency: z.literal('BDT'),
});
export type Money = z.infer<typeof MoneySchema>;
export const taka = (whole: number): Money => ({
  amount: Math.round(whole * 100),
  currency: 'BDT',
});

/** One need lifecycle, five modes (ADR-0005). */
export const NeedModes = ['BUY', 'RENT', 'BORROW', 'HIRE', 'SOURCE'] as const;
export type NeedMode = (typeof NeedModes)[number];

export const Conditions = ['NEW', 'USED', 'REFURBISHED'] as const;
export type Condition = (typeof Conditions)[number];

export const DeliveryModes = [
  'BUYER_PICKUP',
  'SELLER_DELIVERY',
  'SELF_ARRANGED',
  'ON_SITE',
] as const;
export type DeliveryMode = (typeof DeliveryModes)[number];

export const UserTypes = ['INDIVIDUAL', 'BUSINESS'] as const;
export type UserType = (typeof UserTypes)[number];

export const SellerRoles = ['SELLER', 'SERVICE_PROVIDER', 'LENDER', 'SUPPLIER'] as const;
export type SellerRole = (typeof SellerRoles)[number];

/** Opaque keyset cursor shape shared by every list endpoint. */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable() }) });
