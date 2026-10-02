import type { ActorType } from '@dorkar/contracts';

/** One row of the cross-service activity log (a projection of `audit.ActivityRecorded`). */
export interface ActivityEntry {
  id: string;
  /** The producing service (envelope producer), e.g. `transaction`. */
  service: string;
  occurredAt: Date;
  actorId: string | null;
  actorType: ActorType;
  /** From profile.ProfileUpdated; null when unknown. Never a phone number. */
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ipHash: string | null;
  metadata: Record<string, unknown>;
}

export interface ActivityFilter {
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  service?: string | undefined;
  /** Prefix match, e.g. `transaction.` */
  actionPrefix?: string | undefined;
  actorType?: ActorType | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export type MyActivityScope = 'mine' | 'about-me';

/** How staff appear to the member they acted on: never the staff member's id or name. */
export const STAFF_DISPLAY_NAME = 'Dorkar team';

/** Target types that denote the member themself (compared after normalisation). */
export const ABOUT_ME_TARGET_TYPES = ['ACCOUNT', 'USER', 'PROFILE'] as const;

/** Services spell target types differently (`account`, `ACCOUNT`); the log stores upper case. */
export const normalizeTargetType = (t: string | null | undefined): string | null =>
  t ? t.trim().toUpperCase() : null;

/**
 * Exclusive upper bound for a byte-wise prefix range: every string starting with `prefix` is
 * `>= prefix` and `< prefixUpperBound(prefix)`. Lets a `text_pattern_ops` index serve the
 * prefix filter with bound parameters (LIKE with a parameter cannot use it).
 */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** Export column order. */
export const EXPORT_COLUMNS = [
  'occurredAt',
  'service',
  'action',
  'label',
  'actorType',
  'actorId',
  'actorName',
  'targetType',
  'targetId',
  'requestId',
  'ipHash',
  'metadata',
] as const;

export const EXPORT_MAX_ROWS = 10_000;
