import { IdentityEvents, type AccountStatus, type Role } from '@dorkar/contracts';
import { Errors, type RequestContext } from '@dorkar/kernel';
import { assertStatusTransition, effectiveRoles, type Account } from '../../domain/account';
import { event, type IdentityDeps } from '../deps';

export interface ChangeAccountStatusInput {
  accountId: string;
  status: AccountStatus;
  reason: string;
}

/**
 * Admin suspension/ban/restore. Permission (`user:suspend`) is enforced at the route; the
 * resource rules live here: no self-moderation, valid transition, optimistic guard on the
 * current status, sessions revoked on deactivation, fully audited.
 */
export class ChangeAccountStatus {
  constructor(private readonly d: Pick<IdentityDeps, 'uow'>) {}

  async execute(
    input: ChangeAccountStatusInput,
    ctx: RequestContext,
  ): Promise<{ account: Account; roles: Role[] }> {
    const actor = ctx.actor;
    if (!actor?.permissions.has('user:suspend')) throw Errors.forbidden();
    if (actor.id === input.accountId)
      throw Errors.forbidden('You cannot change your own account status.');

    return this.d.uow.transaction(async (r) => {
      const account = await r.accounts.findById(input.accountId, { forUpdate: true });
      if (!account) throw Errors.notFound('Account');
      const from = account.status;
      if (from === input.status) {
        return { account, roles: effectiveRoles(await r.accounts.roles(account.id)) };
      }
      assertStatusTransition(from, input.status);
      if (!(await r.accounts.updateStatus(account.id, from, input.status, input.reason))) {
        throw Errors.conflict('Account was modified concurrently. Retry.');
      }
      let revokedSessions = 0;
      if (input.status !== 'ACTIVE') {
        revokedSessions = await r.sessions.revokeAllForAccount(
          account.id,
          'ACCOUNT_STATUS_CHANGED',
        );
      }
      await r.audit(ctx, {
        action: 'admin.account_status_changed',
        actorType: 'ADMIN',
        targetType: 'account',
        targetId: account.id,
        metadata: { from, to: input.status, reason: input.reason, revokedSessions },
      });
      await r.outbox(
        event(
          IdentityEvents.AccountStatusChanged,
          account.id,
          { accountId: account.id, from, to: input.status, reason: input.reason },
          ctx,
        ),
      );
      return {
        account: { ...account, status: input.status },
        roles: effectiveRoles(await r.accounts.roles(account.id)),
      };
    });
  }
}
