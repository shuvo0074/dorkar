import { AppError, type InternalClient } from '@dorkar/kernel';
import { z } from 'zod';
import type { ContactDirectory } from '../application/ports';

const ContactResponse = z.object({
  data: z.object({ accountId: z.uuid(), phoneE164: z.string().regex(/^\+8801[3-9]\d{8}$/) }),
});

/**
 * Asks identity for the number at send time, for a stated purpose (identity audits each lookup).
 * 404 means unknown or inactive: not contactable. Anything else propagates and is retried.
 */
export class IdentityContactDirectory implements ContactDirectory {
  constructor(private readonly call: InternalClient) {}

  async phoneOf(accountId: string): Promise<string | null> {
    try {
      const res = ContactResponse.parse(
        await this.call(
          `/internal/v1/accounts/${encodeURIComponent(accountId)}/contact?purpose=NOTIFICATION`,
        ),
      );
      return res.data.phoneE164;
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }
}
