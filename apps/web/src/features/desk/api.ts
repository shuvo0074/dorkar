import type { AccountStatus, NeedMode } from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';
import type { AttributeSchema } from '@dorkar/contracts';
import type { Deal } from '../deals/api';
import type { Loan } from '../lending/api';
import type { Booking } from '../rentals/api';
import type { ReportReason, ReportTarget } from '../trust/api';

// ---------------------------------------------------------------- moderation

export type CaseStatus = 'OPEN' | 'ACTIONED' | 'DISMISSED';
export type Decision = 'HIDE' | 'RESTORE' | 'DISMISS';

export interface ModCase {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  status: CaseStatus;
  reportCount: number;
  topReason: ReportReason;
  priority: number;
  assignedTo: string | null;
  targetHidden: boolean;
  openedAt: string;
  closedAt: string | null;
  version: number;
}

export interface ModCaseDetail extends ModCase {
  reports: Array<{
    id: string;
    reporterId: string;
    reason: ReportReason;
    details: string | null;
    status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
    createdAt: string;
  }>;
  actions: Array<{
    id: string;
    moderatorId: string;
    action: Decision | 'ASSIGN' | 'NOTE';
    reason: string | null;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------- verification

export interface AdminVerification {
  id: string;
  accountId: string;
  kind: 'PHONE' | 'NID' | 'BUSINESS';
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
  provider: string;
  providerRef: string | null;
  nidLast4: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  submittedAt: string;
  verifiedAt: string | null;
  updatedAt: string;
  version: number;
}

export const PolicyActions = [
  'LISTING_PUBLISH',
  'NEED_PUBLISH',
  'OFFER_SUBMIT',
  'TRANSACTION_CREATE',
  'AUCTION_CREATE',
  'BID_PLACE',
  'BOOKING_CREATE',
  'LEND_ITEM_PUBLISH',
  'LOAN_REQUEST',
  'ANY',
] as const;
export type PolicyAction = (typeof PolicyActions)[number];
export const PolicyScopes = ['GLOBAL', 'ROLE', 'CATEGORY', 'MODE', 'VALUE_THRESHOLD'] as const;
export type PolicyScope = (typeof PolicyScopes)[number];
export const Requirements = ['NONE', 'OPTIONAL', 'REQUIRED'] as const;
export type Requirement = (typeof Requirements)[number];

export interface Policy {
  id: string;
  name: string;
  action: PolicyAction;
  scope: PolicyScope;
  selector: Record<string, unknown>;
  requirement: Requirement;
  kinds: Array<'PHONE' | 'NID' | 'BUSINESS'>;
  active: boolean;
  priority: number;
  version: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PolicyInput = Pick<
  Policy,
  'name' | 'action' | 'scope' | 'selector' | 'requirement' | 'kinds' | 'active' | 'priority'
>;

// ---------------------------------------------------------------- catalog

export interface CategoryInput {
  parentId?: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  attributeSchema?: AttributeSchema;
  sort?: number;
  active?: boolean;
}

/** The staff view of a category: switched-off ones included. */
export interface AdminCategory extends Required<CategoryInput> {
  id: string;
  attributeSchema: AttributeSchema;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const deskApi = {
  cases: (
    f: { status?: CaseStatus | undefined; targetType?: ReportTarget | undefined },
    cursor?: string,
  ) => api<Page<ModCase>>(`/api/v1/admin/moderation/cases${query({ ...f, cursor, limit: 20 })}`),
  case: (id: string) =>
    one(api<{ data: ModCaseDetail }>(`/api/v1/admin/moderation/cases/${enc(id)}`)),
  assignCase: (id: string) =>
    one(
      api<{ data: ModCase }>(`/api/v1/admin/moderation/cases/${enc(id)}/assign`, {
        method: 'POST',
      }),
    ),
  decide: (id: string, action: Decision, reason: string) =>
    one(
      api<{ data: ModCase }>(`/api/v1/admin/moderation/cases/${enc(id)}/actions`, {
        method: 'POST',
        body: { action, reason },
      }),
    ),

  hideListing: (id: string, reason: string, restore = false) =>
    api(`/api/v1/admin/listings/${enc(id)}/${restore ? 'restore' : 'hide'}`, {
      method: 'POST',
      body: { reason },
    }),
  hideNeed: (id: string, reason: string, restore = false) =>
    api(`/api/v1/admin/needs/${enc(id)}/${restore ? 'restore' : 'hide'}`, {
      method: 'POST',
      body: { reason },
    }),

  setAccountStatus: (id: string, status: AccountStatus, reason: string) =>
    one(
      api<{ data: { id: string; status: AccountStatus } }>(
        `/api/v1/admin/accounts/${enc(id)}/status`,
        {
          method: 'POST',
          body: { status, reason },
        },
      ),
    ),

  verifications: (status: AdminVerification['status'], cursor?: string) =>
    api<Page<AdminVerification>>(
      `/api/v1/admin/verifications${query({ status, cursor, limit: 20 })}`,
    ),
  decideVerification: (id: string, decision: 'VERIFIED' | 'REJECTED', note: string) =>
    one(
      api<{ data: AdminVerification }>(`/api/v1/admin/verifications/${enc(id)}/decision`, {
        method: 'POST',
        body: { decision, note },
      }),
    ),

  policies: (cursor?: string) =>
    api<Page<Policy>>(`/api/v1/admin/verification-policies${query({ cursor, limit: 100 })}`),
  createPolicy: (input: PolicyInput) =>
    one(
      api<{ data: Policy }>('/api/v1/admin/verification-policies', { method: 'POST', body: input }),
    ),
  updatePolicy: (id: string, patch: Partial<PolicyInput> & { version: number }) =>
    one(
      api<{ data: Policy }>(`/api/v1/admin/verification-policies/${enc(id)}`, {
        method: 'PATCH',
        body: patch,
      }),
    ),
  deactivatePolicy: (id: string) =>
    one(
      api<{ data: Policy }>(`/api/v1/admin/verification-policies/${enc(id)}/deactivate`, {
        method: 'POST',
      }),
    ),

  deals: (state: string | undefined, cursor?: string) =>
    api<Page<Deal>>(`/api/v1/admin/transactions${query({ state, cursor, limit: 30 })}`),
  bookings: (status: string | undefined, cursor?: string) =>
    api<Page<Booking>>(`/api/v1/admin/bookings${query({ status, cursor, limit: 30 })}`),
  loans: (status: string | undefined, cursor?: string) =>
    api<Page<Loan>>(`/api/v1/admin/loans${query({ status, cursor, limit: 30 })}`),

  categories: () => one(api<{ data: AdminCategory[] }>('/api/v1/admin/categories')),
  category: (id: string) =>
    one(api<{ data: AdminCategory }>(`/api/v1/admin/categories/${enc(id)}`)),
  createCategory: (input: CategoryInput) =>
    api<{ data: { id: string } }>('/api/v1/admin/categories', { method: 'POST', body: input }),
  updateCategory: (id: string, patch: Partial<CategoryInput>) =>
    api<{ data: { id: string } }>(`/api/v1/admin/categories/${enc(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
};
