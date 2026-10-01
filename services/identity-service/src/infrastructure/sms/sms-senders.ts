import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BdPhoneE164 } from '@dorkar/contracts';
import type { SmsSender } from '../../application/ports';

/**
 * Development/staging only: appends messages to a local file that is *not* part of the
 * application log stream (OTPs must never reach logs). Config validation forbids it in production.
 */
export class FileSmsSender implements SmsSender {
  constructor(private readonly path: string) {}

  async send(to: BdPhoneE164, text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ at: new Date().toISOString(), to, text })}\n`, {
      mode: 0o600,
    });
  }
}

/** In-memory sender for automated tests. */
export class RecordingSmsSender implements SmsSender {
  readonly sent: Array<{ to: BdPhoneE164; text: string }> = [];
  failNext = false;

  async send(to: BdPhoneE164, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated SMS provider failure');
    }
    this.sent.push({ to, text });
  }

  lastCodeFor(to: string): string | undefined {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    return msg?.text.match(/code is (\d+)/)?.[1];
  }
}

// A production adapter (e.g. a Bangladeshi SMS aggregator's HTTP API) implements SmsSender with:
// fixed outbound host allowlist (no user-controlled URLs → no SSRF), a short timeout, retries
// only on idempotent provider errors, and redacted logging of the provider response.
