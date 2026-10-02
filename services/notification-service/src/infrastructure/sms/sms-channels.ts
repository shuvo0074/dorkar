import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SmsChannel } from '../../application/ports';

/**
 * Development/staging only: appends messages to a local file that is *not* part of the
 * application log stream (phone numbers must never reach logs). Config forbids it in production.
 */
export class FileSmsChannel implements SmsChannel {
  constructor(private readonly path: string) {}

  async send(toE164: string, text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), to: toE164, text })}\n`,
      { mode: 0o600 },
    );
  }
}

/** In-memory channel for automated tests; `failNext` simulates provider outages. */
export class RecordingSmsChannel implements SmsChannel {
  readonly sent: Array<{ to: string; text: string }> = [];
  failNext = 0;

  async send(toE164: string, text: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`simulated SMS provider failure for ${toE164}`);
    }
    this.sent.push({ to: toE164, text });
  }
}

// A production adapter (a Bangladeshi SMS aggregator's HTTP API) implements SmsChannel with a fixed
// outbound host allowlist, a short timeout, and redacted logging of the provider response.
