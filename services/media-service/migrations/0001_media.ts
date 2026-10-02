import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Media: Migration = {
  name: '0001_media',
  async up(trx) {
    // Metadata only: file bytes live in object storage under storage_key / variants[*].key.
    await sql`
      create table media_objects (
        id uuid primary key,
        owner_id uuid not null,
        purpose text not null check (purpose in ('LISTING','NEED','OFFER','AVATAR','VERIFICATION')),
        visibility text not null check (visibility in ('PUBLIC','PRIVATE')),
        status text not null default 'PENDING_UPLOAD'
          check (status in ('PENDING_UPLOAD','READY','REJECTED','DELETED')),
        declared_content_type text not null,
        declared_size int not null check (declared_size > 0),
        sniffed_mime text,
        size_bytes int,
        sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
        storage_key text not null,
        variants jsonb not null default '{}',
        width int,
        height int,
        rejection_reason text,
        created_at timestamptz not null default now(),
        ready_at timestamptz,
        expires_at timestamptz,
        version int not null default 0,
        check (visibility = case when purpose = 'VERIFICATION' then 'PRIVATE' else 'PUBLIC' end),
        check (status <> 'PENDING_UPLOAD' or expires_at is not null)
      )`.execute(trx);
    // Per-owner pending quota and the expiry sweep.
    await sql`create index media_objects_owner_pending_idx on media_objects (owner_id) where status = 'PENDING_UPLOAD'`.execute(
      trx,
    );
    await sql`create index media_objects_pending_expiry_idx on media_objects (expires_at) where status = 'PENDING_UPLOAD'`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table media_objects`.execute(trx);
  },
};
