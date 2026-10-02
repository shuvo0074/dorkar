import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Messaging: Migration = {
  name: '0001_messaging',
  async up(trx) {
    // Projection of the things a conversation can be about (listings, offers, transactions,
    // lend items), built from other services' events. `owner_id` is the seller/lender;
    // `counterpart_id` is the fixed other party (buyer) for OFFER/TRANSACTION, null when anyone
    // may inquire (LISTING/LEND_ITEM).
    await sql`
      create table conversation_contexts (
        context_type text not null check (context_type in ('LISTING','OFFER','TRANSACTION','LEND_ITEM')),
        context_id uuid not null,
        owner_id uuid not null,
        counterpart_id uuid,
        available boolean not null,
        last_event_at timestamptz not null,
        updated_at timestamptz not null default now(),
        primary key (context_type, context_id)
      )`.execute(trx);

    await sql`
      create table conversations (
        id uuid primary key,
        context_type text not null check (context_type in ('LISTING','OFFER','TRANSACTION','LEND_ITEM')),
        context_id uuid not null,
        participant_a uuid not null,
        participant_b uuid not null,
        last_seq bigint not null default 0,
        last_message_id uuid,
        last_message_at timestamptz,
        created_at timestamptz not null default now(),
        check (participant_a < participant_b)
      )`.execute(trx);
    // One conversation per context and unordered pair (stored ordered: a < b).
    await sql`
      create unique index conversations_context_pair_uq
        on conversations (context_type, context_id, participant_a, participant_b)`.execute(trx);

    // Per-participant state. `activity_at` is denormalized from the conversation so "my
    // conversations" is a keyset scan on one index.
    await sql`
      create table conversation_participants (
        conversation_id uuid not null references conversations (id) on delete cascade,
        account_id uuid not null,
        other_id uuid not null,
        last_read_seq bigint not null default 0,
        unread_count int not null default 0 check (unread_count >= 0),
        activity_at timestamptz(3) not null,
        primary key (conversation_id, account_id)
      )`.execute(trx);
    await sql`
      create index conversation_participants_inbox_idx
        on conversation_participants (account_id, activity_at desc, conversation_id desc)`.execute(
      trx,
    );

    // `seq` is allocated under the conversation row lock, so it is gap-free and in commit order
    // per conversation: a long-poller asking for "after seq N" can never miss a message.
    await sql`
      create table messages (
        id uuid primary key,
        conversation_id uuid not null references conversations (id) on delete cascade,
        seq bigint not null,
        sender_id uuid not null,
        client_id uuid not null,
        body text not null check (char_length(body) between 1 and 2000),
        media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 4),
        hidden boolean not null default false,
        moderation_case_id uuid,
        created_at timestamptz not null default now(),
        unique (conversation_id, seq),
        unique (conversation_id, sender_id, client_id)
      )`.execute(trx);

    await sql`
      create table blocks (
        blocker_id uuid not null,
        blocked_id uuid not null,
        -- millisecond precision: the value round-trips through a JS Date in keyset cursors
        created_at timestamptz not null default date_trunc('milliseconds', now()),
        primary key (blocker_id, blocked_id),
        check (blocker_id <> blocked_id)
      )`.execute(trx);
    await sql`create index blocks_list_idx on blocks (blocker_id, created_at desc, blocked_id desc)`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table blocks`.execute(trx);
    await sql`drop table messages`.execute(trx);
    await sql`drop table conversation_participants`.execute(trx);
    await sql`drop table conversations`.execute(trx);
    await sql`drop table conversation_contexts`.execute(trx);
  },
};
