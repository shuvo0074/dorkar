import { z } from 'zod';
import { AttributeSchemaSchema } from './attributes';
import { DistrictSchema } from './locations';
import {
  Conditions,
  DeliveryModes,
  MoneySchema,
  NeedModes,
  SellerRoles,
  UserTypes,
} from './marketplace';

/**
 * Integration events for every marketplace service, in one place so producers and consumers
 * compile against the same contract. Rules:
 *  - payloads carry IDs and the facts consumers need to build projections; never PII
 *    (phone numbers, NID, addresses);
 *  - adding optional fields is compatible; anything else is a new `version`;
 *  - stream per producer: `events:<producer>` (see eventStreamFor).
 */

const id = z.uuid();
const ts = z.iso.datetime();

// ---------------------------------------------------------------- profile

export const ProfileEvents = {
  ProfileUpdated: {
    type: 'profile.ProfileUpdated',
    version: 1,
    schema: z.object({
      accountId: id,
      displayName: z.string(),
      userType: z.enum(UserTypes),
      district: DistrictSchema.nullable(),
    }),
  },
  SellerCapabilitiesChanged: {
    type: 'profile.SellerCapabilitiesChanged',
    version: 1,
    schema: z.object({
      accountId: id,
      roles: z.array(z.enum(SellerRoles)),
      categoryIds: z.array(id),
      serviceDistricts: z.array(DistrictSchema),
      deliveryModes: z.array(z.enum(DeliveryModes)),
      active: z.boolean(),
    }),
  },
} as const;

// ---------------------------------------------------------------- verification

export const VerificationKinds = ['PHONE', 'NID', 'BUSINESS'] as const;
export const VerificationStatuses = [
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
] as const;

export const VerificationEvents = {
  VerificationStatusChanged: {
    type: 'verification.VerificationStatusChanged',
    version: 1,
    schema: z.object({
      accountId: id,
      kind: z.enum(VerificationKinds),
      status: z.enum(VerificationStatuses),
    }),
  },
} as const;

// ---------------------------------------------------------------- catalog

const listingFacts = z.object({
  listingId: id,
  sellerId: id,
  categoryId: id,
  kind: z.enum(['PRODUCT', 'SERVICE', 'RENTAL']),
  condition: z.enum(Conditions).nullable(),
  title: z.string(),
  price: MoneySchema,
  priceUnit: z.enum(['TOTAL', 'PER_UNIT', 'PER_HOUR', 'PER_DAY']),
  quantityAvailable: z.number().int(),
  district: DistrictSchema,
  attributes: z.record(z.string(), z.unknown()),
  deliveryModes: z.array(z.enum(DeliveryModes)),
});

export const CatalogEvents = {
  CategoryUpserted: {
    type: 'catalog.CategoryUpserted',
    version: 1,
    schema: z.object({
      categoryId: id,
      parentId: id.nullable(),
      slug: z.string(),
      nameEn: z.string(),
      nameBn: z.string(),
      modes: z.array(z.enum(NeedModes)),
      attributeSchema: AttributeSchemaSchema,
      active: z.boolean(),
    }),
  },
  ListingPublished: { type: 'catalog.ListingPublished', version: 1, schema: listingFacts },
  ListingUpdated: { type: 'catalog.ListingUpdated', version: 1, schema: listingFacts },
  /** No longer offered: withdrawn, sold out, paused or hidden by moderation. */
  ListingUnavailable: {
    type: 'catalog.ListingUnavailable',
    version: 1,
    schema: z.object({
      listingId: id,
      sellerId: id,
      reason: z.enum(['WITHDRAWN', 'PAUSED', 'SOLD_OUT', 'HIDDEN']),
    }),
  },
} as const;

// ---------------------------------------------------------------- demand

export const NeedStatuses = [
  'DRAFT',
  'OPEN',
  'PAUSED',
  'FULFILLING',
  'FULFILLED',
  'CLOSED',
  'EXPIRED',
  'HIDDEN',
] as const;
export type NeedStatus = (typeof NeedStatuses)[number];

const needFacts = z.object({
  needId: id,
  requesterId: id,
  mode: z.enum(NeedModes),
  categoryId: id,
  title: z.string(),
  quantity: z.number().int().min(1),
  budgetMin: MoneySchema.nullable(),
  budgetMax: MoneySchema.nullable(),
  conditions: z.array(z.enum(Conditions)),
  district: DistrictSchema,
  attributes: z.record(z.string(), z.unknown()),
  requiredBy: z.iso.date().nullable(),
  expiresAt: ts,
  maxOffers: z.number().int().min(1),
});

export const DemandEvents = {
  /** Became OPEN (first publish, resume, renew or moderator restore). */
  NeedPublished: { type: 'demand.NeedPublished', version: 1, schema: needFacts },
  NeedUpdated: { type: 'demand.NeedUpdated', version: 1, schema: needFacts },
  NeedStatusChanged: {
    type: 'demand.NeedStatusChanged',
    version: 1,
    schema: z.object({
      needId: id,
      requesterId: id,
      from: z.enum(NeedStatuses),
      to: z.enum(NeedStatuses),
      reason: z.string(),
    }),
  },
} as const;

// ---------------------------------------------------------------- matching

export const MatchingEvents = {
  MatchFound: {
    type: 'matching.MatchFound',
    version: 1,
    schema: z.object({
      matchId: id,
      needId: id,
      requesterId: id,
      sellerId: id,
      listingId: id.nullable(),
      score: z.number(),
    }),
  },
} as const;

// ---------------------------------------------------------------- offer

export const OfferStatuses = [
  'SUBMITTED',
  'COUNTERED_BY_BUYER',
  'COUNTERED_BY_SELLER',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OfferStatus = (typeof OfferStatuses)[number];

export const OfferEvents = {
  OfferSubmitted: {
    type: 'offer.OfferSubmitted',
    version: 1,
    schema: z.object({
      offerId: id,
      needId: id,
      buyerId: id,
      sellerId: id,
      price: MoneySchema,
      quantity: z.number().int().min(1),
    }),
  },
  OfferCountered: {
    type: 'offer.OfferCountered',
    version: 1,
    schema: z.object({
      offerId: id,
      needId: id,
      buyerId: id,
      sellerId: id,
      by: z.enum(['BUYER', 'SELLER']),
      round: z.number().int(),
      price: MoneySchema,
      quantity: z.number().int().min(1),
    }),
  },
  OfferAccepted: {
    type: 'offer.OfferAccepted',
    version: 1,
    schema: z.object({
      offerId: id,
      needId: id,
      buyerId: id,
      sellerId: id,
      listingId: id.nullable(),
      mode: z.enum(NeedModes),
      price: MoneySchema,
      quantity: z.number().int().min(1),
      /** Frozen agreed terms (delivery, rental period, service scope, …). */
      terms: z.record(z.string(), z.unknown()),
    }),
  },
  OfferStatusChanged: {
    type: 'offer.OfferStatusChanged',
    version: 1,
    schema: z.object({
      offerId: id,
      needId: id,
      buyerId: id,
      sellerId: id,
      from: z.enum(OfferStatuses),
      to: z.enum(OfferStatuses),
      reason: z.string(),
    }),
  },
} as const;

// ---------------------------------------------------------------- transaction

export const TransactionStates = [
  'CREATED',
  'CONFIRMED',
  'DELIVERY_PENDING',
  'DELIVERED',
  // RENT / BORROW sub-flow (03-lifecycles §4): CONFIRMED → HANDED_OVER → RETURN_REPORTED → RETURNED
  'HANDED_OVER',
  'RETURN_REPORTED',
  'RETURNED',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED',
  'REFUNDED',
  'EXPIRED',
] as const;
export type TransactionState = (typeof TransactionStates)[number];

/** Why a party disputes a deal (the free-text `reason` explains). */
export const DisputeReasons = [
  'NOT_RECEIVED',
  'NOT_AS_DESCRIBED',
  'DAMAGED',
  'NOT_RETURNED',
  'PAYMENT',
  'NO_SHOW',
  'OTHER',
] as const;
export type DisputeReason = (typeof DisputeReasons)[number];

/** What a transaction was created from. The (sourceType, sourceId) pair is unique except LISTING. */
export const TransactionSourceTypes = ['OFFER', 'LISTING', 'AUCTION', 'BOOKING', 'LOAN'] as const;
export type TransactionSourceType = (typeof TransactionSourceTypes)[number];

export const TransactionEvents = {
  TransactionCreated: {
    type: 'transaction.TransactionCreated',
    version: 1,
    schema: z.object({
      transactionId: id,
      sourceType: z.enum(TransactionSourceTypes),
      sourceId: id,
      needId: id.nullable(),
      /** The listing the deal consumes stock from, when there is one. */
      listingId: id.nullable().optional(),
      buyerId: id,
      sellerId: id,
      amount: MoneySchema,
      quantity: z.number().int().min(1),
      mode: z.enum(NeedModes),
    }),
  },
  TransactionStateChanged: {
    type: 'transaction.TransactionStateChanged',
    version: 1,
    schema: z.object({
      transactionId: id,
      needId: id.nullable(),
      sourceType: z.enum(TransactionSourceTypes),
      sourceId: id,
      buyerId: id,
      sellerId: id,
      from: z.enum(TransactionStates),
      to: z.enum(TransactionStates),
      actorId: id.nullable(),
      mode: z.enum(NeedModes).optional(),
      /** Free-text reason for cancel/dispute transitions (never PII; contact info is rejected). */
      reason: z.string().max(500).nullable().optional(),
      /** Set on transitions to DISPUTED. */
      disputeReason: z.enum(DisputeReasons).optional(),
    }),
  },
} as const;

// ---------------------------------------------------------------- reputation

export const ReputationEvents = {
  ReviewCreated: {
    type: 'reputation.ReviewCreated',
    version: 1,
    schema: z.object({
      reviewId: id,
      transactionId: id,
      authorId: id,
      subjectId: id,
      rating: z.number().int().min(1).max(5),
    }),
  },
  ReputationUpdated: {
    type: 'reputation.ReputationUpdated',
    version: 1,
    schema: z.object({
      accountId: id,
      ratingAverage: z.number().nullable(),
      ratingCount: z.number().int(),
      completedCount: z.number().int(),
      cancelledCount: z.number().int(),
      disputedCount: z.number().int(),
    }),
  },
} as const;

// ---------------------------------------------------------------- moderation

export const ModerationTargets = [
  'LISTING',
  'NEED',
  'OFFER',
  'REVIEW',
  'USER',
  'MESSAGE',
  'AUCTION',
  'LEND_ITEM',
] as const;

export const ModerationEvents = {
  /** A moderator decision the owning service must apply (hide/restore its own record). */
  ContentModerated: {
    type: 'moderation.ContentModerated',
    version: 1,
    schema: z.object({
      caseId: id,
      targetType: z.enum(ModerationTargets),
      targetId: id,
      action: z.enum(['HIDE', 'RESTORE']),
      reason: z.string(),
      moderatorId: id,
    }),
  },
} as const;

// ---------------------------------------------------------------- media

export const MediaPurposes = [
  'LISTING',
  'NEED',
  'OFFER',
  'AVATAR',
  'VERIFICATION',
  'MESSAGE',
  'DISPUTE',
  'LEND_ITEM',
] as const;

export const MediaEvents = {
  MediaReady: {
    type: 'media.MediaReady',
    version: 1,
    schema: z.object({ mediaId: id, ownerId: id, purpose: z.enum(MediaPurposes) }),
  },
  MediaRejected: {
    type: 'media.MediaRejected',
    version: 1,
    schema: z.object({
      mediaId: id,
      ownerId: id,
      purpose: z.enum(MediaPurposes),
      reason: z.string(),
    }),
  },
} as const;
