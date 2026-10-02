import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type {
  DeliveryChannel,
  DeliveryStatus,
  NotificationPayload,
  NotificationType,
} from '../domain/notification';
import type { PushPlatform } from '../domain/push';

export interface NotificationDB extends KernelTables {
  notifications: {
    id: string;
    recipient_id: string;
    type: NotificationType;
    // pg returns jsonb parsed; we write it as a JSON string.
    payload: ColumnType<NotificationPayload, string, string>;
    source_event_id: string;
    in_app: Generated<boolean>;
    read_at: Date | null;
    created_at: Generated<Date>;
    coalesce_key: string | null;
  };
  notification_merged_events: {
    source_event_id: string;
    recipient_id: string;
    type: NotificationType;
    notification_id: string;
    created_at: Generated<Date>;
  };
  notification_preferences: {
    account_id: string;
    type: NotificationType;
    in_app: boolean;
    sms: boolean;
    push: Generated<boolean>;
    updated_at: Generated<Date>;
  };
  deliveries: {
    id: string;
    notification_id: string;
    channel: DeliveryChannel;
    status: Generated<DeliveryStatus>;
    attempts: Generated<number>;
    next_attempt_at: Generated<Date>;
    last_error: string | null;
    sent_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  push_devices: {
    id: string;
    account_id: string;
    platform: PushPlatform;
    token: string;
    token_hash: string;
    active: Generated<boolean>;
    deactivated_at: Date | null;
    deactivation_reason: 'LIMIT' | 'INVALID_TOKEN' | null;
    created_at: Generated<Date>;
    last_registered_at: Generated<Date>;
  };
}
