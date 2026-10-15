import type { NeedMode } from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';
import type { DisputeReason, TransactionState } from '../deals/api';

export const DisputeStatuses = [
  'OPEN',
  'AWAITING_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'WITHDRAWN',
] as const;
export type DisputeStatus = (typeof DisputeStatuses)[number];
export type Resolution = 'RELEASE' | 'CANCEL' | 'REFUND';
export type DisputeAction =
  'statement' | 'evidence' | 'withdraw' | 'assign' | 'note' | 'request-info' | 'resolve';

export interface Dispute {
  id: string;
  transactionId: string;
  buyerId: string;
  sellerId: string;
  openedBy: 'BUYER' | 'SELLER';
  respondent: 'BUYER' | 'SELLER';
  reason: DisputeReason;
  description: string | null;
  previousState: TransactionState;
  mode: NeedMode | null;
  amount: { amount: number; currency: string } | null;
  status: DisputeStatus;
  respondBy: string;
  respondentMissedDeadline: boolean;
  statementSubmitted: boolean;
  resolution: Resolution | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  withdrawnAt: string | null;
  appliedAt: string | null;
  finalTransactionState: TransactionState | null;
  openedAt: string;
  updatedAt: string;
}

export interface StaffInfo {
  assignedTo: string | null;
  assignedAt: string | null;
  escalated: boolean;
  escalatedAt: string | null;
  resolvedBy: string | null;
  withdrawnBy: string | null;
}

export type AdminDispute = Dispute & StaffInfo;

export interface Entry {
  id: string;
  kind:
    | 'OPENED'
    | 'STATEMENT'
    | 'EVIDENCE'
    | 'INFO_REQUEST'
    | 'NOTE'
    | 'STATUS_CHANGE'
    | 'ASSIGNMENT'
    | 'ESCALATION'
    | 'SYSTEM';
  authorRole: 'BUYER' | 'SELLER' | 'STAFF' | 'SYSTEM';
  authorId: string | null;
  visibility: 'PARTIES' | 'STAFF';
  text: string | null;
  mediaIds: string[];
  targetParty: 'BUYER' | 'SELLER' | 'BOTH' | null;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus | null;
  createdAt: string;
}

export interface DisputeDetail extends Dispute {
  viewerRole: 'BUYER' | 'SELLER' | 'STAFF';
  actions: DisputeAction[];
  timeline: Entry[];
  staff: StaffInfo | null;
}

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);
const post = (path: string, body: unknown, idempotencyKey: string) =>
  one(api<{ data: DisputeDetail }>(path, { method: 'POST', body, idempotencyKey }));

export const disputesApi = {
  mine: (status?: DisputeStatus, cursor?: string) =>
    api<Page<Dispute>>(`/api/v1/me/disputes${query({ status, cursor, limit: 20 })}`),
  get: (id: string) => one(api<{ data: DisputeDetail }>(`/api/v1/disputes/${enc(id)}`)),
  statement: (id: string, text: string, key: string) =>
    post(`/api/v1/disputes/${enc(id)}/statement`, { text }, key),
  evidence: (id: string, input: { text?: string; mediaIds?: string[] }, key: string) =>
    post(`/api/v1/disputes/${enc(id)}/evidence`, input, key),
  withdraw: (id: string, key: string) => post(`/api/v1/disputes/${enc(id)}/withdraw`, {}, key),

  // Staff
  queue: (
    f: { status?: DisputeStatus | undefined; assignee?: string | undefined },
    cursor?: string,
  ) => api<Page<AdminDispute>>(`/api/v1/admin/disputes${query({ ...f, cursor, limit: 20 })}`),
  assign: (id: string, assigneeId: string, key: string) =>
    post(`/api/v1/admin/disputes/${enc(id)}/assign`, { assigneeId }, key),
  note: (id: string, text: string, key: string) =>
    post(`/api/v1/admin/disputes/${enc(id)}/notes`, { text }, key),
  requestInfo: (id: string, party: 'BUYER' | 'SELLER' | 'BOTH', message: string, key: string) =>
    post(`/api/v1/admin/disputes/${enc(id)}/request-info`, { party, message }, key),
  resolve: (id: string, resolution: Resolution, note: string, key: string) =>
    post(`/api/v1/admin/disputes/${enc(id)}/resolve`, { resolution, note }, key),
};
