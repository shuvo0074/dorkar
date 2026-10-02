import { Errors, type RequestContext } from '@dorkar/kernel';
import type { IdentityDeps } from '../deps';

/**
 * Phone numbers never travel in events. A service that must reach a user by SMS (notifications)
 * asks for the number at send time, for a stated purpose; every lookup is audited as
 * sensitive-data access. Inactive accounts are not contactable.
 */
export class GetContact {
  constructor(private readonly d: Pick<IdentityDeps, 'uow'>) {}

  async execute(
    accountId: string,
    purpose: 'NOTIFICATION',
    ctx: RequestContext,
  ): Promise<{ accountId: string; phoneE164: string }> {
    return this.d.uow.transaction(async (r) => {
      const account = await r.accounts.findById(accountId);
      if (!account || account.status !== 'ACTIVE') throw Errors.notFound('Account');
      await r.audit(ctx, {
        action: 'contact.read',
        actorType: 'SYSTEM',
        actorId: null,
        targetType: 'account',
        targetId: accountId,
        metadata: { purpose },
      });
      return { accountId, phoneE164: account.phoneE164 };
    });
  }
}
