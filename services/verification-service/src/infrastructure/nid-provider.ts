import { hmacSha256 } from '@dorkar/kernel';
import type { Fingerprinter, NidProvider } from '../application/ports';

/**
 * Development default: no external authority, so every submission waits for an admin with
 * `verification:nid:decide`. The raw data is not kept anywhere: the reviewer checks it out of band
 * (e.g. a video call or an EC lookup) and records only the decision.
 */
export class ManualReviewNidProvider implements NidProvider {
  readonly name = 'manual';

  async check(): Promise<{ outcome: 'PENDING'; providerRef: null }> {
    return { outcome: 'PENDING', providerRef: null };
  }
}

/** Keyed fingerprint: detects one NID on two accounts without storing the number. */
export const hmacFingerprinter =
  (key: string): Fingerprinter =>
  (nid) =>
    hmacSha256(key, `nid:${nid}`).toString('hex');
