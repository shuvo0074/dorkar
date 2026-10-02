import { AppError, type Logger } from '@dorkar/kernel';
import { preferenceFor } from '../domain/notification';
import { afterFailure, renderSms } from '../domain/sms';
import type {
  ClaimedDelivery,
  ContactDirectory,
  DeliveryStore,
  NotificationStore,
  SmsChannel,
} from './ports';

export interface SmsDispatcherSettings {
  batchSize: number;
  maxAttempts: number;
  /** How long a claim is held before another worker may retry it (crash safety). */
  leaseMs: number;
  publicBaseUrl: string;
}

/** Error text kept on the delivery row: a code, never provider output (may echo the number). */
const errorCode = (err: unknown): string =>
  err instanceof AppError ? err.code : err instanceof Error ? err.name : 'UNKNOWN';

/**
 * Sends due SMS deliveries outside any database transaction: claim a small batch (short
 * transaction, SKIP LOCKED), then look up the number, render, send and record the outcome one by
 * one. At-least-once: a crash between send and record can resend after the lease expires.
 * Never logs the phone number or the message text.
 */
export class SmsDispatcher {
  constructor(
    private readonly d: {
      deliveries: DeliveryStore;
      notifications: NotificationStore;
      contacts: ContactDirectory;
      sms: SmsChannel;
      logger: Logger;
      settings: SmsDispatcherSettings;
    },
  ) {}

  /** One pass; returns how many deliveries reached a final or rescheduled state. */
  async runOnce(): Promise<number> {
    const claimed = await this.d.deliveries.claimDue(
      'SMS',
      this.d.settings.batchSize,
      this.d.settings.leaseMs,
    );
    for (const c of claimed) await this.deliver(c);
    return claimed.length;
  }

  private async deliver(c: ClaimedDelivery): Promise<void> {
    const log = { deliveryId: c.id, notificationId: c.notification.id, attempt: c.attempt };
    const { deliveries, settings } = this.d;
    try {
      // The user may have turned SMS off after the notification was queued.
      const prefs = await this.d.notifications.preferences([c.notification.recipientId]);
      if (!preferenceFor(c.notification.type, prefs.get(c.notification.recipientId)).sms) {
        await deliveries.finish(c.id, c.attempt, 'SKIPPED', 'OPTED_OUT');
        this.d.logger.info({ ...log, status: 'SKIPPED', reason: 'OPTED_OUT' }, 'sms skipped');
        return;
      }
      const phone = await this.d.contacts.phoneOf(c.notification.recipientId);
      if (!phone) {
        await deliveries.finish(c.id, c.attempt, 'SKIPPED', 'RECIPIENT_UNAVAILABLE');
        this.d.logger.info(
          { ...log, status: 'SKIPPED', reason: 'RECIPIENT_UNAVAILABLE' },
          'sms skipped',
        );
        return;
      }
      await this.d.sms.send(phone, renderSms(c.notification, settings.publicBaseUrl));
      await deliveries.markSent(c.id, c.attempt);
      this.d.logger.info({ ...log, status: 'SENT' }, 'sms sent');
    } catch (err) {
      const code = errorCode(err);
      const next = afterFailure(c.attempt, settings.maxAttempts);
      if (next.status === 'FAILED') {
        await deliveries.finish(c.id, c.attempt, 'FAILED', code);
        this.d.logger.warn({ ...log, status: 'FAILED', error: code }, 'sms failed permanently');
      } else {
        await deliveries.retryLater(c.id, c.attempt, next.retryInMs, code);
        this.d.logger.warn(
          { ...log, status: 'PENDING', error: code, retryInMs: next.retryInMs },
          'sms failed; will retry',
        );
      }
    }
  }
}
