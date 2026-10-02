import { AppError, type Logger } from '@dorkar/kernel';
import { preferenceFor } from '../domain/notification';
import { PUSH_THROTTLE_MS, pushThrottleKey, renderPush } from '../domain/push';
import { afterFailure } from '../domain/sms';
import type {
  ClaimedDelivery,
  DeliveryStore,
  NotificationStore,
  PushDeviceStore,
  PushProvider,
  PushResult,
  PushThrottle,
} from './ports';

export interface PushDispatcherSettings {
  batchSize: number;
  maxAttempts: number;
  /** How long a claim is held before another worker may retry it (crash safety). */
  leaseMs: number;
}

const errorCode = (err: unknown): string =>
  err instanceof AppError ? err.code : err instanceof Error ? err.name : 'UNKNOWN';

/**
 * Sends due PUSH deliveries with the same claim/lease/backoff machinery as SMS, outside any
 * database transaction. One delivery fans out to all of the recipient's active devices:
 * any device accepting it makes it SENT; dead tokens are deactivated; if none accepted and some
 * failed transiently, the delivery is retried. Never logs tokens or message text.
 */
export class PushDispatcher {
  constructor(
    private readonly d: {
      deliveries: DeliveryStore;
      notifications: NotificationStore;
      devices: PushDeviceStore;
      push: PushProvider;
      throttle: PushThrottle;
      logger: Logger;
      settings: PushDispatcherSettings;
    },
  ) {}

  async runOnce(): Promise<number> {
    const claimed = await this.d.deliveries.claimDue(
      'PUSH',
      this.d.settings.batchSize,
      this.d.settings.leaseMs,
    );
    for (const c of claimed) await this.deliver(c);
    return claimed.length;
  }

  private async skip(c: ClaimedDelivery, reason: string): Promise<void> {
    await this.d.deliveries.finish(c.id, c.attempt, 'SKIPPED', reason);
    this.d.logger.info(
      { deliveryId: c.id, notificationId: c.notification.id, status: 'SKIPPED', reason },
      'push skipped',
    );
  }

  private async deliver(c: ClaimedDelivery): Promise<void> {
    const log = { deliveryId: c.id, notificationId: c.notification.id, attempt: c.attempt };
    const n = c.notification;
    try {
      const prefs = await this.d.notifications.preferences([n.recipientId]);
      if (!preferenceFor(n.type, prefs.get(n.recipientId)).push) {
        return await this.skip(c, 'OPTED_OUT');
      }
      const targets = await this.d.devices.targetsFor(n.recipientId);
      if (targets.length === 0) return await this.skip(c, 'NO_DEVICE');

      // Bursty types: one push per window. Checked on the first attempt only, so a retry of a
      // push that already won the window is not throttled by its own key.
      const key = pushThrottleKey(n);
      if (key && c.attempt === 1 && !(await this.acquire(key))) {
        return await this.skip(c, 'THROTTLED');
      }

      const message = renderPush(n);
      let sent = 0;
      let retryError: string | null = null;
      for (const t of targets) {
        const r: PushResult = await this.d.push
          .send(t, message)
          .catch((err: unknown) => ({ retryable: true as const, error: errorCode(err) }));
        if ('ok' in r) sent++;
        else if ('invalidToken' in r) {
          await this.d.devices.deactivate(t.id, 'INVALID_TOKEN');
          this.d.logger.info({ ...log, deviceId: t.id }, 'push device deactivated: invalid token');
        } else retryError = r.error;
      }

      if (sent > 0) {
        await this.d.deliveries.markSent(c.id, c.attempt);
        this.d.logger.info({ ...log, status: 'SENT', devices: sent }, 'push sent');
        return;
      }
      if (retryError === null) return await this.skip(c, 'NO_DEVICE'); // every token was dead
      await this.failed(c, retryError);
    } catch (err) {
      await this.failed(c, errorCode(err));
    }
  }

  private async failed(c: ClaimedDelivery, code: string): Promise<void> {
    const log = { deliveryId: c.id, notificationId: c.notification.id, attempt: c.attempt };
    const next = afterFailure(c.attempt, this.d.settings.maxAttempts);
    if (next.status === 'FAILED') {
      await this.d.deliveries.finish(c.id, c.attempt, 'FAILED', code);
      this.d.logger.warn({ ...log, status: 'FAILED', error: code }, 'push failed permanently');
    } else {
      await this.d.deliveries.retryLater(c.id, c.attempt, next.retryInMs, code);
      this.d.logger.warn(
        { ...log, status: 'PENDING', error: code, retryInMs: next.retryInMs },
        'push failed; will retry',
      );
    }
  }

  /** Redis is a throttle, not a source of truth: if it is down, send rather than drop. */
  private async acquire(key: string): Promise<boolean> {
    try {
      return await this.d.throttle.acquire(key, PUSH_THROTTLE_MS);
    } catch (err) {
      this.d.logger.warn({ error: errorCode(err) }, 'push throttle unavailable; sending');
      return true;
    }
  }
}
