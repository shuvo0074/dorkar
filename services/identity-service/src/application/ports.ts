import type { AccountStatus, BdPhoneE164, EventEnvelope, Role } from '@dorkar/contracts';
import type { AuditEntry, RateLimiter, RequestContext } from '@dorkar/kernel';
import type { Account } from '../domain/account';
import type { Device, DevicePlatform } from '../domain/device';
import type { RevokeReason } from '../domain/session';

export type { RateLimiter };

export interface SessionView {
  id: string;
  accountId: string;
  deviceId: string;
  createdAt: Date;
  lastRefreshedAt: Date | null;
  expiresAt: Date;
}

export interface RefreshTokenRow {
  id: string;
  sessionId: string;
  expiresAt: Date;
  usedAt: Date | null;
  session: {
    accountId: string;
    deviceId: string;
    expiresAt: Date;
    revokedAt: Date | null;
  };
  accountStatus: AccountStatus;
}

/**
 * Repositories bound to one executor (a transaction or autocommit). All reads of user-owned
 * data take the owner's account ID so a missing check returns nothing instead of leaking.
 */
export interface IdentityRepositories {
  accounts: {
    findById(id: string, opts?: { forUpdate?: boolean }): Promise<Account | null>;
    /** Insert-or-get by phone; race-safe via the unique constraint. */
    getOrCreateByPhone(
      id: string,
      phone: BdPhoneE164,
    ): Promise<{ account: Account; created: boolean }>;
    updateStatus(
      id: string,
      from: AccountStatus,
      to: AccountStatus,
      reason: string,
    ): Promise<boolean>;
    roles(id: string): Promise<Role[]>;
    grantRole(id: string, role: Role, grantedBy: string | null): Promise<void>;
  };
  otp: {
    create(c: {
      id: string;
      phone: BdPhoneE164;
      codeHash: Buffer;
      ttlSeconds: number;
      maxAttempts: number;
      ipHash: string | null;
      deviceKeyHash: string | null;
    }): Promise<{ expiresAt: Date }>;
    /**
     * Atomically counts one attempt if the challenge is still usable (unconsumed, unexpired,
     * attempts left). Returns null otherwise.
     */
    registerAttempt(id: string): Promise<{
      phone: BdPhoneE164;
      codeHash: Buffer;
      attempts: number;
      maxAttempts: number;
    } | null>;
    /** Marks consumed; false if someone else consumed it first. */
    consume(id: string): Promise<boolean>;
  };
  devices: {
    upsert(d: {
      id: string;
      accountId: string;
      keyHash: string;
      platform: DevicePlatform;
      label: string | null;
    }): Promise<{ device: Device; created: boolean }>;
    listForAccount(accountId: string): Promise<Device[]>;
    revoke(accountId: string, deviceId: string): Promise<boolean>;
    touch(deviceId: string): Promise<void>;
  };
  sessions: {
    create(s: {
      id: string;
      accountId: string;
      deviceId: string;
      expiresAt: Date;
      ipHash: string | null;
      userAgent: string | null;
    }): Promise<void>;
    isActive(sessionId: string, accountId: string): Promise<boolean>;
    listActive(accountId: string): Promise<SessionView[]>;
    revoke(sessionId: string, accountId: string, reason: RevokeReason): Promise<boolean>;
    revokeAllForAccount(accountId: string, reason: RevokeReason): Promise<number>;
    revokeForDevice(accountId: string, deviceId: string, reason: RevokeReason): Promise<number>;
    markRefreshed(sessionId: string): Promise<void>;
  };
  refreshTokens: {
    insert(t: { id: string; sessionId: string; hash: Buffer; expiresAt: Date }): Promise<void>;
    /** Locks the token row (and its session) for the duration of the transaction. */
    findByHashForUpdate(hash: Buffer): Promise<RefreshTokenRow | null>;
    markUsed(id: string, replacedBy: string): Promise<void>;
  };
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface UnitOfWork {
  /** Autocommit repositories for single-statement operations and reads. */
  readonly repos: IdentityRepositories;
  transaction<T>(fn: (repos: IdentityRepositories) => Promise<T>): Promise<T>;
}

/** SMS provider port — swap aggregators without touching use cases. */
export interface SmsSender {
  send(to: BdPhoneE164, text: string): Promise<void>;
}

export interface AccessTokenClaimsInput {
  accountId: string;
  sessionId: string;
  deviceId: string;
  roles: Role[];
}

export interface TokenIssuer {
  issueAccessToken(c: AccessTokenClaimsInput): Promise<{ token: string; expiresAt: Date }>;
}

export interface Clock {
  now(): Date;
}
