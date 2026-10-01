import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Identity: Migration = {
  name: '0001_identity',
  async up(trx) {
    await sql`
      create table accounts (
        id uuid primary key,
        phone_e164 text not null unique check (phone_e164 ~ '^\\+8801[3-9][0-9]{8}$'),
        status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','BANNED','DELETED')),
        status_reason text,
        phone_verified_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0
      )`.execute(trx);

    await sql`
      create table role_grants (
        account_id uuid not null references accounts (id) on delete cascade,
        role text not null check (role in ('MEMBER','BUSINESS','MODERATOR','SUPPORT','ADMIN','SUPER_ADMIN')),
        granted_by uuid,
        granted_at timestamptz not null default now(),
        primary key (account_id, role)
      )`.execute(trx);

    await sql`
      create table otp_challenges (
        id uuid primary key,
        phone_e164 text not null,
        purpose text not null default 'LOGIN' check (purpose in ('LOGIN')),
        code_hash bytea not null,
        attempts int not null default 0,
        max_attempts int not null check (max_attempts > 0),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz,
        ip_hash text,
        device_key_hash text,
        check (attempts <= max_attempts)
      )`.execute(trx);
    await sql`create index otp_challenges_created_idx on otp_challenges (created_at)`.execute(trx);

    await sql`
      create table devices (
        id uuid primary key,
        account_id uuid not null references accounts (id) on delete cascade,
        key_hash text not null,
        platform text not null check (platform in ('web','android','ios')),
        label text check (char_length(label) <= 64),
        trust text not null default 'UNTRUSTED' check (trust in ('UNTRUSTED','TRUSTED','REVOKED')),
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        revoked_at timestamptz,
        unique (account_id, key_hash)
      )`.execute(trx);

    await sql`
      create table sessions (
        id uuid primary key,
        account_id uuid not null references accounts (id) on delete cascade,
        device_id uuid not null references devices (id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        last_refreshed_at timestamptz,
        revoked_at timestamptz,
        revoke_reason text,
        ip_hash text,
        user_agent text
      )`.execute(trx);
    await sql`create index sessions_account_active_idx on sessions (account_id) where revoked_at is null`.execute(
      trx,
    );
    await sql`create index sessions_device_active_idx on sessions (device_id) where revoked_at is null`.execute(
      trx,
    );
    await sql`create index sessions_expires_idx on sessions (expires_at)`.execute(trx);

    await sql`
      create table refresh_tokens (
        id uuid primary key,
        session_id uuid not null references sessions (id) on delete cascade,
        token_hash bytea not null unique,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        used_at timestamptz,
        replaced_by uuid
      )`.execute(trx);
    await sql`create index refresh_tokens_session_idx on refresh_tokens (session_id)`.execute(trx);
    await sql`create index refresh_tokens_expires_idx on refresh_tokens (expires_at)`.execute(trx);
  },

  async down(trx) {
    await sql`drop table refresh_tokens`.execute(trx);
    await sql`drop table sessions`.execute(trx);
    await sql`drop table devices`.execute(trx);
    await sql`drop table otp_challenges`.execute(trx);
    await sql`drop table role_grants`.execute(trx);
    await sql`drop table accounts`.execute(trx);
  },
};
