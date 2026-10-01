import type { AccountStatus, Role } from '@dorkar/contracts';
import type { Generated, KernelTables, Timestamp } from '@dorkar/kernel';
import type { DevicePlatform, DeviceTrust } from '../domain/device';

export interface IdentityDB extends KernelTables {
  accounts: {
    id: string;
    phone_e164: string;
    status: Generated<AccountStatus>;
    status_reason: string | null;
    phone_verified_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  role_grants: {
    account_id: string;
    role: Role;
    granted_by: string | null;
    granted_at: Generated<Date>;
  };
  otp_challenges: {
    id: string;
    phone_e164: string;
    purpose: Generated<'LOGIN'>;
    code_hash: Buffer;
    attempts: Generated<number>;
    max_attempts: number;
    created_at: Generated<Date>;
    expires_at: Timestamp;
    consumed_at: Timestamp | null;
    ip_hash: string | null;
    device_key_hash: string | null;
  };
  devices: {
    id: string;
    account_id: string;
    key_hash: string;
    platform: DevicePlatform;
    label: string | null;
    trust: Generated<DeviceTrust>;
    created_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    revoked_at: Timestamp | null;
  };
  sessions: {
    id: string;
    account_id: string;
    device_id: string;
    created_at: Generated<Date>;
    expires_at: Timestamp;
    last_refreshed_at: Timestamp | null;
    revoked_at: Timestamp | null;
    revoke_reason: string | null;
    ip_hash: string | null;
    user_agent: string | null;
  };
  refresh_tokens: {
    id: string;
    session_id: string;
    token_hash: Buffer;
    created_at: Generated<Date>;
    expires_at: Timestamp;
    used_at: Timestamp | null;
    replaced_by: string | null;
  };
}
