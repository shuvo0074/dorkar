import { IdentityEvents, type Role } from '@dorkar/contracts';
import { Errors, type Actor, type RequestContext } from '@dorkar/kernel';
import { effectiveRoles, type Account } from '../../domain/account';
import type { Device } from '../../domain/device';
import { event, type IdentityDeps } from '../deps';
import type { SessionView } from '../ports';

type Deps = Pick<IdentityDeps, 'uow'>;

function requireActor(ctx: RequestContext): Actor {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
}

export class Logout {
  constructor(private readonly d: Deps) {}

  async execute(ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    await this.d.uow.transaction(async (r) => {
      if (await r.sessions.revoke(actor.sessionId, actor.id, 'LOGOUT')) {
        await r.audit(ctx, {
          action: 'auth.logout',
          targetType: 'session',
          targetId: actor.sessionId,
        });
      }
    });
  }
}

export class LogoutAll {
  constructor(private readonly d: Deps) {}

  async execute(ctx: RequestContext): Promise<{ revokedSessions: number }> {
    const actor = requireActor(ctx);
    return this.d.uow.transaction(async (r) => {
      const revokedSessions = await r.sessions.revokeAllForAccount(actor.id, 'LOGOUT_ALL');
      await r.audit(ctx, {
        action: 'auth.logout_all',
        targetType: 'account',
        targetId: actor.id,
        metadata: { revokedSessions },
      });
      return { revokedSessions };
    });
  }
}

export class ListMySessions {
  constructor(private readonly d: Deps) {}
  execute(ctx: RequestContext): Promise<SessionView[]> {
    return this.d.uow.repos.sessions.listActive(requireActor(ctx).id);
  }
}

export class ListMyDevices {
  constructor(private readonly d: Deps) {}
  execute(ctx: RequestContext): Promise<Device[]> {
    return this.d.uow.repos.devices.listForAccount(requireActor(ctx).id);
  }
}

/** Revokes a device and every session bound to it. Scoped to the caller's own devices (no IDOR). */
export class RevokeMyDevice {
  constructor(private readonly d: Deps) {}

  async execute(deviceId: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    await this.d.uow.transaction(async (r) => {
      if (!(await r.devices.revoke(actor.id, deviceId))) throw Errors.notFound('Device');
      const revokedSessions = await r.sessions.revokeForDevice(
        actor.id,
        deviceId,
        'DEVICE_REVOKED',
      );
      await r.audit(ctx, {
        action: 'device.revoked',
        targetType: 'device',
        targetId: deviceId,
        metadata: { revokedSessions },
      });
      await r.outbox(
        event(IdentityEvents.DeviceRevoked, actor.id, { accountId: actor.id, deviceId }, ctx),
      );
    });
  }
}

export class GetMyAccount {
  constructor(private readonly d: Deps) {}

  async execute(ctx: RequestContext): Promise<{ account: Account; roles: Role[] }> {
    const actor = requireActor(ctx);
    const account = await this.d.uow.repos.accounts.findById(actor.id);
    if (!account) throw Errors.notFound('Account');
    return { account, roles: effectiveRoles(await this.d.uow.repos.accounts.roles(actor.id)) };
  }
}

/** Used by the authenticator so revocations take effect immediately inside identity. */
export class CheckSession {
  constructor(private readonly d: Deps) {}
  execute(sessionId: string, accountId: string): Promise<boolean> {
    return this.d.uow.repos.sessions.isActive(sessionId, accountId);
  }
}
