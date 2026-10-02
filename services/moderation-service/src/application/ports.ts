import type { EventEnvelope } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type {
  ActionKind,
  CaseStatus,
  ModerationAction,
  ModerationCase,
  ModerationTarget,
  Report,
  ReportReason,
  ReportStatus,
} from '../domain/moderation';

export interface NewReport {
  id: string;
  reporterId: string;
  targetType: ModerationTarget;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  caseId: string;
}

export interface CaseFilter {
  status?: CaseStatus | undefined;
  targetType?: ModerationTarget | undefined;
}

export interface CaseChange {
  status: CaseStatus;
  targetHidden: boolean;
  assignedTo?: string;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface ModerationStore {
  /** Insert-if-missing the open case for a target (race-safe on the partial unique index). */
  ensureOpenCase(c: {
    id: string;
    targetType: ModerationTarget;
    targetId: string;
    reason: ReportReason;
  }): Promise<void>;
  /**
   * The open case for a target, row-locked for the rest of the transaction; null if it was
   * closed between ensureOpenCase and the lock.
   */
  lockOpenCase(targetType: ModerationTarget, targetId: string): Promise<ModerationCase | null>;
  setCaseRanking(
    caseId: string,
    r: Pick<ModerationCase, 'reportCount' | 'topReason' | 'priority'>,
  ): Promise<void>;
  /** Throws CONFLICT if the reporter already has an open report on the target. */
  insertReport(r: NewReport): Promise<Report>;
  getCase(id: string): Promise<ModerationCase | null>;
  listCases(filter: CaseFilter, after: Cursor | null, limit: number): Promise<ModerationCase[]>;
  caseReports(caseId: string, limit: number): Promise<Report[]>;
  caseActions(caseId: string, limit: number): Promise<ModerationAction[]>;
  reportsByReporter(reporterId: string, after: Cursor | null, limit: number): Promise<Report[]>;
  /** Guarded update: applies only if status and version still match. Null if someone else won. */
  transitionCase(
    id: string,
    from: Pick<ModerationCase, 'status' | 'version'>,
    to: CaseChange,
  ): Promise<ModerationCase | null>;
  setOpenReportsStatus(caseId: string, to: ReportStatus): Promise<void>;
  appendAction(a: {
    id: string;
    caseId: string;
    moderatorId: string;
    action: ActionKind;
    reason: string | null;
  }): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
}

export interface ModerationUnitOfWork {
  readonly store: ModerationStore;
  transaction<T>(fn: (store: ModerationStore) => Promise<T>): Promise<T>;
}
