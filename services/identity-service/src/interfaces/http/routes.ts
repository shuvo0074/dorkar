import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JSONWebKeySet } from 'jose';
import {
  actorOf,
  Errors,
  ok,
  type createAuthenticator,
  type FastifyPluginAsyncZod,
} from '@dorkar/kernel';
import type { ChangeAccountStatus } from '../../application/use-cases/admin';
import type { RefreshSession } from '../../application/use-cases/refresh-session';
import type { RequestOtp } from '../../application/use-cases/request-otp';
import type {
  GetMyAccount,
  ListMyDevices,
  ListMySessions,
  Logout,
  LogoutAll,
  RevokeMyDevice,
} from '../../application/use-cases/sessions';
import type { VerifyOtp } from '../../application/use-cases/verify-otp';
import {
  AccountResponse,
  ChangeStatusBody,
  ChangeStatusParams,
  DeviceDto,
  DeviceParams,
  ErrorResponse,
  RefreshBody,
  RequestOtpBody,
  RequestOtpResponse,
  SessionDto,
  TokenResponse,
  toAccountDto,
  toDeviceDto,
  toSessionDto,
  VerifyOtpBody,
  VerifyOtpResponse,
} from './dto';
import { z } from 'zod';

export interface IdentityRouteDeps {
  useCases: {
    requestOtp: RequestOtp;
    verifyOtp: VerifyOtp;
    refreshSession: RefreshSession;
    logout: Logout;
    logoutAll: LogoutAll;
    listSessions: ListMySessions;
    listDevices: ListMyDevices;
    revokeDevice: RevokeMyDevice;
    getAccount: GetMyAccount;
    changeAccountStatus: ChangeAccountStatus;
  };
  auth: ReturnType<typeof createAuthenticator>;
  jwks: JSONWebKeySet;
  cookie: { name: string; path: string; secure: boolean };
  allowedOrigins: readonly string[];
}

const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  429: ErrorResponse,
  503: ErrorResponse,
};
const isNativeClient = (req: FastifyRequest) => req.headers['x-client'] === 'mobile';

export const identityRoutes: FastifyPluginAsyncZod<IdentityRouteDeps> = async (app, deps) => {
  const { useCases: uc, auth, cookie } = deps;

  const setRefreshCookie = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(cookie.name, token, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
      path: cookie.path,
      expires: expiresAt,
    });
  const clearRefreshCookie = (reply: FastifyReply) =>
    reply.clearCookie(cookie.name, {
      path: cookie.path,
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
    });

  /**
   * Cookie-authenticated endpoints are the only CSRF-relevant ones: require a custom header
   * (cannot be sent cross-site without a CORS preflight) and, when present, an allowed Origin.
   */
  const assertSameSiteRequest = (req: FastifyRequest) => {
    if (req.headers['x-requested-with'] !== 'dorkar')
      throw Errors.forbidden('Missing CSRF header.');
    const origin = req.headers.origin;
    if (origin && !deps.allowedOrigins.includes(origin))
      throw Errors.forbidden('Origin not allowed.');
  };

  app.post(
    '/api/v1/auth/request-otp',
    {
      schema: {
        tags: ['auth'],
        summary: 'Send a one-time login code by SMS',
        body: RequestOtpBody,
        response: { 202: RequestOtpResponse, ...errors },
      },
    },
    async (req, reply) => {
      const result = await uc.requestOtp.execute(req.body, req.ctx);
      return reply.status(202).send(ok(result));
    },
  );

  app.post(
    '/api/v1/auth/verify-otp',
    {
      schema: {
        tags: ['auth'],
        summary: 'Verify the code and start a session',
        body: VerifyOtpBody,
        response: { 200: VerifyOtpResponse, ...errors },
      },
    },
    async (req, reply) => {
      const { challengeId, code, device } = req.body;
      const s = await uc.verifyOtp.execute({ challengeId, otp: code, device }, req.ctx);
      const native = isNativeClient(req);
      if (!native) setRefreshCookie(reply, s.refreshToken, s.refreshTokenExpiresAt);
      return ok({
        accessToken: s.accessToken,
        accessTokenExpiresAt: s.accessTokenExpiresAt,
        ...(native
          ? { refreshToken: s.refreshToken, refreshTokenExpiresAt: s.refreshTokenExpiresAt }
          : {}),
        account: toAccountDto(s.account, s.roles),
        isNewAccount: s.isNewAccount,
      });
    },
  );

  app.post(
    '/api/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh token and obtain a new access token',
        body: RefreshBody,
        response: { 200: TokenResponse, ...errors },
      },
    },
    async (req, reply) => {
      const native = isNativeClient(req);
      let token: string | undefined;
      if (native) {
        token = req.body?.refreshToken;
      } else {
        assertSameSiteRequest(req);
        token = req.cookies[cookie.name];
      }
      if (!token) throw Errors.unauthenticated('Missing refresh token.');
      try {
        const s = await uc.refreshSession.execute(token, req.ctx);
        if (!native) setRefreshCookie(reply, s.refreshToken, s.refreshTokenExpiresAt);
        return ok({
          accessToken: s.accessToken,
          accessTokenExpiresAt: s.accessTokenExpiresAt,
          ...(native
            ? { refreshToken: s.refreshToken, refreshTokenExpiresAt: s.refreshTokenExpiresAt }
            : {}),
        });
      } catch (err) {
        if (!native) clearRefreshCookie(reply);
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['auth'],
        security: [{ bearerAuth: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await uc.logout.execute(req.ctx);
      clearRefreshCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/api/v1/auth/logout-all',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Sign out of every device',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ data: z.object({ revokedSessions: z.number().int() }) }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const result = await uc.logoutAll.execute(req.ctx);
      clearRefreshCookie(reply);
      return ok(result);
    },
  );

  app.get(
    '/api/v1/me/account',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['me'],
        security: [{ bearerAuth: [] }],
        response: { 200: AccountResponse, ...errors },
      },
    },
    async (req) => {
      const { account, roles } = await uc.getAccount.execute(req.ctx);
      return ok(toAccountDto(account, roles));
    },
  );

  app.get(
    '/api/v1/me/sessions',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['me'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(SessionDto) }), ...errors },
      },
    },
    async (req) => {
      const sessions = await uc.listSessions.execute(req.ctx);
      return ok(sessions.map((s) => toSessionDto(s, actorOf(req).sessionId)));
    },
  );

  app.get(
    '/api/v1/me/devices',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['me'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(DeviceDto) }), ...errors },
      },
    },
    async (req) => {
      const devices = await uc.listDevices.execute(req.ctx);
      return ok(devices.map((d) => toDeviceDto(d, actorOf(req).deviceId)));
    },
  );

  app.delete(
    '/api/v1/me/devices/:id',
    {
      preHandler: auth.authenticate,
      schema: {
        tags: ['me'],
        summary: 'Revoke a device and all its sessions',
        security: [{ bearerAuth: [] }],
        params: DeviceParams,
        response: { 204: z.null(), 404: ErrorResponse, ...errors },
      },
    },
    async (req, reply) => {
      await uc.revokeDevice.execute(req.params.id, req.ctx);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/api/v1/admin/accounts/:id/status',
    {
      preHandler: auth.requirePermission('user:suspend'),
      schema: {
        tags: ['admin'],
        summary: 'Suspend, ban or restore an account',
        security: [{ bearerAuth: [] }],
        params: ChangeStatusParams,
        body: ChangeStatusBody,
        response: { 200: AccountResponse, 404: ErrorResponse, 409: ErrorResponse, ...errors },
      },
    },
    async (req) => {
      const { account, roles } = await uc.changeAccountStatus.execute(
        { accountId: req.params.id, status: req.body.status, reason: req.body.reason },
        req.ctx,
      );
      return ok(toAccountDto(account, roles));
    },
  );

  app.get(
    '/.well-known/jwks.json',
    { schema: { tags: ['auth'], summary: 'Public signing keys' } },
    async (_req, reply) => {
      void reply.header('cache-control', 'public, max-age=300');
      return deps.jwks;
    },
  );
};
