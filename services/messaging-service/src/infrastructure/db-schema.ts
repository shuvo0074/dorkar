import type { ConversationContext } from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';

/** int8 columns come back from pg as strings; convert with Number() (values stay small). */
type Int8 = string | number;

export interface MessagingDB extends KernelTables {
  conversation_contexts: {
    context_type: ConversationContext;
    context_id: string;
    owner_id: string;
    counterpart_id: string | null;
    available: boolean;
    last_event_at: Date;
    updated_at: Generated<Date>;
  };
  conversations: {
    id: string;
    context_type: ConversationContext;
    context_id: string;
    participant_a: string;
    participant_b: string;
    last_seq: Generated<Int8>;
    last_message_id: string | null;
    last_message_at: Date | null;
    created_at: Generated<Date>;
  };
  conversation_participants: {
    conversation_id: string;
    account_id: string;
    other_id: string;
    last_read_seq: Generated<Int8>;
    unread_count: Generated<number>;
    activity_at: Date;
  };
  messages: {
    id: string;
    conversation_id: string;
    seq: Int8;
    sender_id: string;
    client_id: string;
    body: string;
    media_ids: string[];
    hidden: Generated<boolean>;
    moderation_case_id: string | null;
    created_at: Generated<Date>;
  };
  blocks: {
    blocker_id: string;
    blocked_id: string;
    created_at: Generated<Date>;
  };
}
