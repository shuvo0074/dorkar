import type { Generated, KernelTables } from '@dorkar/kernel';
import type {
  ActionKind,
  CaseStatus,
  ModerationTarget,
  ReportReason,
  ReportStatus,
} from '../domain/moderation';

export interface ModerationDB extends KernelTables {
  moderation_cases: {
    id: string;
    target_type: ModerationTarget;
    target_id: string;
    status: Generated<CaseStatus>;
    report_count: Generated<number>;
    top_reason: ReportReason;
    priority: Generated<number>;
    assigned_to: string | null;
    target_hidden: Generated<boolean>;
    opened_at: Generated<Date>;
    closed_at: Date | null;
    version: Generated<number>;
  };
  reports: {
    id: string;
    reporter_id: string;
    target_type: ModerationTarget;
    target_id: string;
    reason: ReportReason;
    details: string | null;
    case_id: string;
    status: Generated<ReportStatus>;
    created_at: Generated<Date>;
  };
  moderation_actions: {
    id: string;
    case_id: string;
    moderator_id: string;
    action: ActionKind;
    reason: string | null;
    created_at: Generated<Date>;
  };
}
