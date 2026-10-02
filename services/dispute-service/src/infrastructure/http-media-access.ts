import { AppError, type InternalClient } from '@dorkar/kernel';
import type { MediaAccess } from '../application/ports';

/**
 * Grants read access through media-service before the referencing record is written, so an
 * attachment the caller does not own (or of the wrong purpose) is refused up front. Without a
 * MEDIA_URL, attachments are refused rather than stored unreadable.
 */
export function httpMediaAccess(call: InternalClient | null): MediaAccess {
  return {
    async grant(input, ctx) {
      if (input.mediaIds.length === 0 || input.accountIds.length === 0) return;
      if (!call) {
        throw new AppError('BUSINESS_RULE_VIOLATION', 'Attachments are not available.', {
          rule: 'ATTACHMENTS_UNAVAILABLE',
        });
      }
      await call('/internal/v1/media/grants', { method: 'POST', body: input, ctx });
    },
  };
}
