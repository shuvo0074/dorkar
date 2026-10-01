import type { AccountStatus, Role } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export interface Account {
  id: string;
  phoneE164: string;
  status: AccountStatus;
  createdAt: Date;
}

/** Every account is a MEMBER; additional roles come from explicit grants. */
export const effectiveRoles = (granted: readonly Role[]): Role[] => [
  ...new Set<Role>(['MEMBER', ...granted]),
];

const STATUS_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  ACTIVE: ['SUSPENDED', 'BANNED', 'DELETED'],
  SUSPENDED: ['ACTIVE', 'BANNED', 'DELETED'],
  BANNED: ['ACTIVE', 'DELETED'],
  DELETED: [],
};

export function assertStatusTransition(from: AccountStatus, to: AccountStatus): void {
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new AppError('INVALID_STATE_TRANSITION', `Account cannot move from ${from} to ${to}.`, {
      from,
      to,
    });
  }
}

export const canAuthenticate = (status: AccountStatus) => status === 'ACTIVE';
