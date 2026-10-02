import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type {
  DeliveryChannel,
  DeliveryStatus,
  NotificationPayload,
  NotificationType,
} from '../domain/notification';

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
  };
  notification_preferences: {
    account_id: string;
    type: NotificationType;
    in_app: boolean;
    sms: boolean;
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
}
