import {
  findContactInfo,
  type DisputeReason,
  type DisputeResolution,
  type DisputeStatus,
  type NeedMode,
  type TransactionState,
} from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';

export type PartyRole = 'BUYER' | 'SELLER';
export type AuthorRole = PartyRole | 'STAFF' | 'SYSTEM';
export type EntryKind =
  | 'OPENED'
  | 'STATEMENT'
  | 'EVIDENCE'
  | 'INFO_REQUEST'
  | 'NOTE'
  | 'STATUS_CHANGE'
  | 'ASSIGNMENT'
  | 'ESCALATION'
  | 'SYSTEM';
export type Visibility = 'PARTIES' | 'STAFF';
export type TargetParty = PartyRole | 'BOTH';

/** Payment providers known to the dispute desk, and whether money can be sent back. */
export const PaymentProviderNames = ['CASH'] as const;
export type PaymentProviderName = (typeof PaymentProviderNames)[number];

export interface ProviderCapabilities {
  refunds: boolean;
}

/** Cash changes hands in person: there is nothing to refund through Dorkar. */
export const PROVIDER_CAPABILITIES: Readonly<Record<PaymentProviderName, ProviderCapabilities>> = {
  CASH: { refunds: false },
};

export interface Dispute {
  id: string;
  transactionId: string;
  buyerId: string;
  sellerId: string;
  openedBy: string;
  respondentId: string;
  previousState: TransactionState;
  reason: DisputeReason;
  description: string | null;
  mode: NeedMode | null;
  amount: number | null;
  currency: string | null;
  paymentProvider: PaymentProviderName;
  status: DisputeStatus;
  respondBy: Date;
  respondentMissedDeadline: boolean;
  statementSubmittedAt: Date | null;
  assignedTo: string | null;
  assignedAt: Date | null;
  escalated: boolean;
  escalatedAt: Date | null;
  resolution: DisputeResolution | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  appliedAt: Date | null;
  finalTransactionState: TransactionState | null;
  openedAt: Date;
  updatedAt: Date;
  version: number;
}

export interface Entry {
  id: string;
  disputeId: string;
  kind: EntryKind;
  authorId: string | null;
  authorRole: AuthorRole;
  visibility: Visibility;
  text: string | null;
  mediaIds: string[];
  targetParty: TargetParty | null;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus | null;
  createdAt: Date;
}

/** Statuses in which the case is still being worked. */
export const LiveStatuses = [
  'AWAITING_RESPONSE',
  'UNDER_REVIEW',
] as const satisfies readonly DisputeStatus[];
export const isLive = (s: DisputeStatus) => (LiveStatuses as readonly DisputeStatus[]).includes(s);

export const partyRole = (
  d: Pick<Dispute, 'buyerId' | 'sellerId'>,
  accountId: string,
): PartyRole | null =>
  d.buyerId === accountId ? 'BUYER' : d.sellerId === accountId ? 'SELLER' : null;

// ---------------------------------------------------------------- status machine

export const DisputeCommands = [
  'submit-statement',
  'respondent-deadline',
  'resolve',
  'withdraw',
  'close-without-decision',
] as const;
export type DisputeCommand = (typeof DisputeCommands)[number];

/** Who runs a command, relative to the case. */
export const CaseActors = ['OPENER', 'RESPONDENT', 'STAFF', 'SYSTEM'] as const;
export type CaseActor = (typeof CaseActors)[number];

export interface CaseFacts {
  status: DisputeStatus;
  statementSubmitted: boolean;
}

interface Rule {
  from: DisputeStatus;
  command: DisputeCommand;
  to: DisputeStatus;
  actors: readonly CaseActor[];
  guard?: (f: CaseFacts) => AppError | null;
}

const noStatementYet = (f: CaseFacts) =>
  f.statementSubmitted
    ? new AppError('INVALID_STATE_TRANSITION', 'You have already submitted your statement.', {
        rule: 'STATEMENT_ALREADY_SUBMITTED',
      })
    : null;

/**
 * The whole lifecycle: AWAITING_RESPONSE → UNDER_REVIEW → RESOLVED, and WITHDRAWN from either
 * live status. A respondent who missed the deadline may still file a (late) statement while the
 * case is under review. OPEN is part of the contract but never used: a case starts awaiting the
 * respondent.
 */
export const RULES: readonly Rule[] = [
  {
    from: 'AWAITING_RESPONSE',
    command: 'submit-statement',
    to: 'UNDER_REVIEW',
    actors: ['RESPONDENT'],
    guard: noStatementYet,
  },
  {
    from: 'UNDER_REVIEW',
    command: 'submit-statement',
    to: 'UNDER_REVIEW',
    actors: ['RESPONDENT'],
    guard: noStatementYet,
  },
  {
    from: 'AWAITING_RESPONSE',
    command: 'respondent-deadline',
    to: 'UNDER_REVIEW',
    actors: ['SYSTEM'],
  },
  ...LiveStatuses.flatMap((from): Rule[] => [
    { from, command: 'resolve', to: 'RESOLVED', actors: ['STAFF'] },
    { from, command: 'withdraw', to: 'WITHDRAWN', actors: ['OPENER'] },
    { from, command: 'close-without-decision', to: 'WITHDRAWN', actors: ['SYSTEM'] },
  ]),
];

export interface Decision {
  from: DisputeStatus;
  to: DisputeStatus;
}

/** Decides a command or throws: 403 for the wrong actor, 409 for the wrong status. */
export function decide(f: CaseFacts, command: DisputeCommand, actor: CaseActor): Decision {
  const forCommand = RULES.filter((r) => r.command === command);
  if (!forCommand.some((r) => r.actors.includes(actor))) {
    throw new AppError('FORBIDDEN', 'You cannot do this on this dispute.', {
      rule: 'NOT_ALLOWED_FOR_ROLE',
    });
  }
  const rule = forCommand.find((r) => r.from === f.status && r.actors.includes(actor));
  if (!rule) {
    throw new AppError('INVALID_STATE_TRANSITION', `The dispute is ${f.status.toLowerCase()}.`, {
      rule: 'INVALID_STATUS',
      status: f.status,
      command,
    });
  }
  const failure = rule.guard?.(f);
  if (failure) throw failure;
  return { from: rule.from, to: rule.to };
}

/** Commands this actor could run now (for the `actions` list). */
export function available(f: CaseFacts, actor: CaseActor): DisputeCommand[] {
  return DisputeCommands.filter((c) =>
    RULES.some(
      (r) => r.command === c && r.from === f.status && r.actors.includes(actor) && !r.guard?.(f),
    ),
  );
}

// ---------------------------------------------------------------- other rules

export function assertResolutionSupported(
  resolution: DisputeResolution,
  provider: PaymentProviderName,
): void {
  if (resolution === 'REFUND' && !PROVIDER_CAPABILITIES[provider].refunds) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'This deal was paid in cash, so it cannot be refunded through Dorkar. Choose RELEASE or CANCEL.',
      { rule: 'REFUND_NOT_SUPPORTED', provider },
    );
  }
}

/** Text the other party sees must not leak phone numbers or emails. */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. Dorkar keeps contact details private.`,
      { rule: 'NO_CONTACT_INFO', field },
    );
  }
}

export function assertEvidenceNotEmpty(text: string | null, mediaIds: readonly string[]): void {
  if (!text && mediaIds.length === 0) {
    throw Errors.validation('Add a description or at least one photo or document.');
  }
}

/** Staff never act on a dispute they are a party to. */
export function assertNotOwnDispute(staffId: string, d: Pick<Dispute, 'buyerId' | 'sellerId'>) {
  if (partyRole(d, staffId)) throw Errors.forbidden('You cannot handle a dispute you are part of.');
}

/**
 * Who opened the case. The transaction only lets a party dispute, so the actor is one of them;
 * should it ever not be (a system or staff transition), the buyer is treated as the opener.
 */
export function openerOf(buyerId: string, sellerId: string, actorId: string | null): string {
  return actorId === sellerId ? sellerId : buyerId;
}

export const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
