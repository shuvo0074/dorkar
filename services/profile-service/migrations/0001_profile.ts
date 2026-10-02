import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Profile: Migration = {
  name: '0001_profile',
  async up(trx) {
    await sql`
      create table profiles (
        account_id uuid primary key,
        display_name text not null check (char_length(display_name) between 2 and 60),
        user_type text not null default 'INDIVIDUAL' check (user_type in ('INDIVIDUAL','BUSINESS')),
        bio text check (char_length(bio) <= 500),
        district text,
        area text check (char_length(area) <= 80),
        locale text not null default 'en' check (locale in ('en','bn')),
        avatar_media_id uuid,
        hidden boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0
      )`.execute(trx);

    await sql`
      create table seller_capabilities (
        account_id uuid primary key references profiles (account_id) on delete cascade,
        roles text[] not null default '{}',
        category_ids uuid[] not null default '{}',
        service_districts text[] not null default '{}',
        delivery_modes text[] not null default '{}',
        active boolean not null default false,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index seller_capabilities_categories_idx on seller_capabilities using gin (category_ids) where active`.execute(
      trx,
    );

    // Projections owned by other services, kept here for the public profile view.
    await sql`
      create table reputation_summaries (
        account_id uuid primary key,
        rating_average numeric(3,2),
        rating_count int not null default 0,
        completed_count int not null default 0,
        cancelled_count int not null default 0,
        disputed_count int not null default 0,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`
      create table verification_badges (
        account_id uuid not null,
        kind text not null,
        status text not null,
        updated_at timestamptz not null default now(),
        primary key (account_id, kind)
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table verification_badges`.execute(trx);
    await sql`drop table reputation_summaries`.execute(trx);
    await sql`drop table seller_capabilities`.execute(trx);
    await sql`drop table profiles`.execute(trx);
  },
};
