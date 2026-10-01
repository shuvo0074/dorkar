import { IdentityEvents, type Role } from '@dorkar/contracts';
import { AppError, Errors, uuidv7, type RequestContext } from '@dorkar/kernel';
import { canAuthenticate, effectiveRoles } from '../../domain/account';
import { hashRefreshToken, newRefreshToken, refreshExpiry } from '../../domain/session';
import { event, type IdentityDeps } from '../deps';

export interface RefreshedSession {
  accountId: string;
  roles: Role[];
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const revoked = () => new AppError('SESSION_REVOKED', 'Session has ended. Please sign in again.');

/**
 * Refresh-token rotation with reuse detection. The token row is locked for the transaction, so
 * two concurrent refreshes with the same token serialize: the first rotates, the second sees a
 * used token, which is exactly the theft signal — the whole session is revoked.
 * Clients must single-flight refreshes (the web app uses navigator.locks across tabs).
 */
export class RefreshSession {
  constructor(
    private readonly d: Pick<IdentityDeps, 'uow' | 'tokens' | 'clock' | 'sessionPolicy'>,
  ) {}

  async execute(refreshToken: string, ctx: RequestContext): Promise<RefreshedSession> {
    const now = this.d.clock.now();
    const next = newRefreshToken();

    const outcome = await this.d.uow.transaction(async (r) => {
      const row = await r.refreshTokens.findByHashForUpdate(hashRefreshToken(refreshToken));
      if (!row) return { kind: 'unknown' as const };
      const { session } = row;

      if (row.usedAt) {
        const wasActive = await r.sessions.revoke(
          row.sessionId,
          session.accountId,
          'REFRESH_TOKEN_REUSE',
        );
        await r.audit(ctx, {
          action: 'session.refresh_reuse_detected',
          actorId: session.accountId,
          targetType: 'session',
          targetId: row.sessionId,
          metadata: { sessionWasActive: wasActive },
        });
        if (wasActive) {
          await r.outbox(
            event(
              IdentityEvents.SessionRevoked,
              session.accountId,
              {
                accountId: session.accountId,
                sessionId: row.sessionId,
                reason: 'REFRESH_TOKEN_REUSE',
              },
              ctx,
            ),
          );
        }
        return { kind: 'revoked' as const };
      }
      if (session.revokedAt || session.expiresAt <= now || row.expiresAt <= now) {
        return { kind: 'revoked' as const };
      }
      if (!canAuthenticate(row.accountStatus)) {
        await r.sessions.revoke(row.sessionId, session.accountId, 'ACCOUNT_STATUS_CHANGED');
        return { kind: 'suspended' as const };
      }

      const nextId = uuidv7();
      const expiresAt = refreshExpiry(now, session.expiresAt, this.d.sessionPolicy);
      await r.refreshTokens.markUsed(row.id, nextId);
      await r.refreshTokens.insert({
        id: nextId,
        sessionId: row.sessionId,
        hash: next.hash,
        expiresAt,
      });
      await r.sessions.markRefreshed(row.sessionId);
      await r.devices.touch(session.deviceId);
      const roles = effectiveRoles(await r.accounts.roles(session.accountId));
      return { kind: 'ok' as const, row, roles, expiresAt };
    });

    switch (outcome.kind) {
      case 'unknown':
        throw Errors.unauthenticated('Invalid refresh token.');
      case 'revoked':
        throw revoked();
      case 'suspended':
        throw new AppError('ACCOUNT_SUSPENDED', 'This account is not active. Contact support.');
    }

    const { row, roles, expiresAt } = outcome;
    const access = await this.d.tokens.issueAccessToken({
      accountId: row.session.accountId,
      sessionId: row.sessionId,
      deviceId: row.session.deviceId,
      roles,
    });
    return {
      accountId: row.session.accountId,
      roles,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshTokenExpiresAt: expiresAt,
    };
  }
}
