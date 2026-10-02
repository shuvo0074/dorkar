import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PushProvider, PushResult, PushThrottle } from '../../application/ports';
import type { PushMessage, PushTarget } from '../../domain/push';
import type { Redis } from '@dorkar/kernel';

/**
 * Development/staging only: appends each push as a JSON line to a local file outside the log
 * stream. Records the device id, never the token. Config forbids it in production.
 */
export class FilePushProvider implements PushProvider {
  constructor(private readonly path: string) {}

  async send(device: PushTarget, message: PushMessage): Promise<PushResult> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), deviceId: device.id, platform: device.platform, message })}\n`,
      { mode: 0o600 },
    );
    return { ok: true };
  }
}

/** In-memory provider for automated tests: scripted per-token outcomes, records what was sent. */
export class RecordingPushProvider implements PushProvider {
  readonly sent: Array<{ deviceId: string; token: string; message: PushMessage }> = [];
  /** token → outcome to return instead of success. */
  readonly outcomes = new Map<string, PushResult>();

  async send(device: PushTarget, message: PushMessage): Promise<PushResult> {
    const scripted = this.outcomes.get(device.token);
    if (scripted && !('ok' in scripted)) return scripted;
    this.sent.push({ deviceId: device.id, token: device.token, message });
    return { ok: true };
  }
}

/** SET NX PX: the first caller in a window wins. Keys live under the service's Redis prefix. */
export class RedisPushThrottle implements PushThrottle {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, windowMs: number): Promise<boolean> {
    return (await this.redis.set(key, '1', 'PX', windowMs, 'NX')) === 'OK';
  }
}
