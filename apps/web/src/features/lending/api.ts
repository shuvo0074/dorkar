import type { Condition, District } from '@dorkar/contracts';
import { shortCode } from '../../lib/format';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export interface Requirements {
  nidVerified: boolean;
  minCompletedDeals: number;
  minRating: number | null;
}

export interface LendItem {
  id: string;
  lenderId: string;
  categoryId: string;
  title: string;
  description: string;
  condition: Condition;
  district: District;
  mediaIds: string[];
  deposit: Money | null;
  maxLoanDays: number;
  requirements: Requirements;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MyLendItem extends LendItem {
  hidden: boolean;
  version: number;
}

export interface LendItemDetail extends LendItem {
  lenderStats: { completedLoans: number; onTimeReturnRate: number | null };
  viewerIsOwner: boolean;
  hidden?: boolean;
}

export interface LendItemInput {
  categoryId: string;
  title: string;
  description?: string;
  condition: Condition;
  district: District;
  mediaIds?: string[];
  deposit?: Money | null;
  maxLoanDays: number;
  requirements?: Partial<Requirements>;
  active?: boolean;
}

export const LoanStatuses = [
  'REQUESTED',
  'APPROVED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
  'LENT',
  'RETURN_REPORTED',
  'RETURNED',
  'DISPUTED',
  'CLOSED',
] as const;
export type LoanStatus = (typeof LoanStatuses)[number];
export type LoanAction = 'approve' | 'decline' | 'cancel';

export interface Loan {
  id: string;
  itemId: string;
  itemTitle: string;
  lenderId: string;
  borrowerId: string;
  startAt: string;
  returnBy: string;
  message: string | null;
  deposit: Money | null;
  status: LoanStatus;
  transactionId: string | null;
  declineReason: string | null;
  returnedAt: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface LoanDetail extends Loan {
  viewerRole: 'LENDER' | 'BORROWER' | null;
  actions: LoanAction[];
  transitions: Array<{
    from: LoanStatus | null;
    to: LoanStatus;
    command: string;
    actorId: string | null;
    actorRole: 'LENDER' | 'BORROWER' | 'SYSTEM';
    reason: string | null;
    at: string;
  }>;
}

export const itemCode = (id: string) => shortCode('I', id);
export const loanCode = (id: string) => shortCode('L', id);

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const lendingApi = {
  items: (
    s: { q?: string | undefined; categoryId?: string | undefined; district?: string | undefined },
    cursor?: string,
  ) => api<Page<LendItem>>(`/api/v1/lend-items${query({ ...s, cursor, limit: 24 })}`),
  item: (id: string) => one(api<{ data: LendItemDetail }>(`/api/v1/lend-items/${enc(id)}`)),
  myItems: (cursor?: string) =>
    api<Page<MyLendItem>>(`/api/v1/me/lend-items${query({ cursor, limit: 20 })}`),
  create: (input: LendItemInput, key: string) =>
    one(
      api<{ data: MyLendItem }>('/api/v1/lend-items', {
        method: 'POST',
        body: input,
        idempotencyKey: key,
      }),
    ),
  update: (id: string, patch: Partial<LendItemInput>) =>
    one(
      api<{ data: MyLendItem }>(`/api/v1/lend-items/${enc(id)}`, { method: 'PATCH', body: patch }),
    ),
  deactivate: (id: string, key: string) =>
    one(
      api<{ data: MyLendItem }>(`/api/v1/lend-items/${enc(id)}/deactivate`, {
        method: 'POST',
        body: {},
        idempotencyKey: key,
      }),
    ),

  request: (
    input: { itemId: string; startAt: string; returnBy: string; message?: string },
    key: string,
  ) =>
    one(
      api<{ data: LoanDetail }>('/api/v1/loans', {
        method: 'POST',
        body: input,
        idempotencyKey: key,
      }),
    ),
  loan: (id: string) => one(api<{ data: LoanDetail }>(`/api/v1/loans/${enc(id)}`)),
  act: (id: string, action: LoanAction, body: { reason?: string }, key: string) =>
    one(
      api<{ data: LoanDetail }>(`/api/v1/loans/${enc(id)}/${action}`, {
        method: 'POST',
        body,
        idempotencyKey: key,
      }),
    ),
  myLoans: (
    f: { status?: LoanStatus | undefined; role?: 'lender' | 'borrower' | undefined },
    cursor?: string,
  ) => api<Page<Loan>>(`/api/v1/me/loans${query({ ...f, cursor, limit: 20 })}`),
};
