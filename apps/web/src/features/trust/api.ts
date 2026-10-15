import type { DeliveryMode, District, SellerRole } from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';

export interface PublicReview {
  id: string;
  authorId: string;
  authorRole: 'BUYER' | 'SELLER';
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface Review extends PublicReview {
  transactionId: string;
  subjectId: string;
  status: 'VISIBLE' | 'HIDDEN';
}

export interface ReputationSummary {
  ratingAverage: number | null;
  ratingCount: number;
  completedCount: number;
  cancelledCount: number;
  disputedCount: number;
  distinctCounterparties: number;
}

export type Badge = 'PHONE_VERIFIED' | 'NID_VERIFIED' | 'BUSINESS_VERIFIED';

export interface PublicProfile {
  id: string;
  displayName: string;
  userType: 'INDIVIDUAL' | 'BUSINESS';
  bio: string | null;
  district: District | null;
  memberSince: string;
  badges: Badge[];
  reputation: {
    ratingAverage: number | null;
    ratingCount: number;
    completedCount: number;
    cancelledCount: number;
    disputedCount: number;
  } | null;
  seller: {
    roles: SellerRole[];
    categoryIds: string[];
    serviceDistricts: District[];
    deliveryModes: DeliveryMode[];
  } | null;
}

export const ReportReasons = [
  'SCAM',
  'PROHIBITED_ITEM',
  'SPAM',
  'OFFENSIVE',
  'CONTACT_INFO',
  'FAKE',
  'HARASSMENT',
  'OTHER',
] as const;
export type ReportReason = (typeof ReportReasons)[number];
export type ReportTarget =
  'LISTING' | 'NEED' | 'OFFER' | 'REVIEW' | 'USER' | 'MESSAGE' | 'AUCTION' | 'LEND_ITEM';

const enc = encodeURIComponent;

export const trustApi = {
  dealReviews: (transactionId: string) =>
    api<{ data: Review[] }>(`/api/v1/transactions/${enc(transactionId)}/reviews`).then(
      (r) => r.data,
    ),
  review: (transactionId: string, rating: number, comment: string | null) =>
    api<{ data: Review }>(`/api/v1/transactions/${enc(transactionId)}/reviews`, {
      method: 'POST',
      body: { rating, comment },
    }).then((r) => r.data),
  userReviews: (userId: string, cursor?: string) =>
    api<Page<PublicReview> & { summary: ReputationSummary }>(
      `/api/v1/users/${enc(userId)}/reviews${query({ cursor, limit: 20 })}`,
      { auth: false },
    ),
  profile: (userId: string) =>
    api<{ data: PublicProfile }>(`/api/v1/users/${enc(userId)}`, { auth: false }).then(
      (r) => r.data,
    ),
  report: (input: {
    targetType: ReportTarget;
    targetId: string;
    reason: ReportReason;
    details?: string | null;
  }) =>
    api<{ data: { reportId: string; caseId: string } }>('/api/v1/reports', {
      method: 'POST',
      body: input,
    }).then((r) => r.data),
};
