import { AccountStatuses, maskBdPhone, Roles, type Role } from '@dorkar/contracts';
import { z } from 'zod';
import type { SessionView } from '../../application/ports';
import type { Account } from '../../domain/account';
import { DEVICE_KEY_PATTERN, DevicePlatforms, type Device } from '../../domain/device';

// ---- requests (strict: unknown keys are rejected) ----

export const RequestOtpBody = z.strictObject({
  phone: z.string().min(1).max(32).describe('Bangladeshi mobile number in any common format'),
  deviceKey: z.string().regex(DEVICE_KEY_PATTERN).optional(),
});

export const VerifyOtpBody = z.strictObject({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{4,8}$/),
  device: z.strictObject({
    key: z
      .string()
      .regex(DEVICE_KEY_PATTERN)
      .describe('Client-generated random 32 bytes, base64url. Persist and reuse per install.'),
    platform: z.enum(DevicePlatforms),
    label: z.string().max(64).optional(),
  }),
});

export const RefreshBody = z
  .strictObject({ refreshToken: z.string().min(20).max(200).optional() })
  .nullish();

export const DeviceParams = z.strictObject({ id: z.uuid() });

export const ChangeStatusParams = z.strictObject({ id: z.uuid() });
export const ChangeStatusBody = z.strictObject({
  status: z.enum(AccountStatuses),
  reason: z.string().trim().min(3).max(500),
});

// ---- responses (explicit DTOs — entities are never serialized directly) ----

/** Handlers return `Date`; the serializer encodes to ISO-8601 (fastify-type-provider-zod v7 encodes responses). */
const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

export const AccountDto = z.object({
  id: z.uuid(),
  phoneMasked: z.string(),
  status: z.enum(AccountStatuses),
  roles: z.array(z.enum(Roles)),
  createdAt: iso,
});
export const toAccountDto = (a: Account, roles: Role[]): z.output<typeof AccountDto> => ({
  id: a.id,
  phoneMasked: maskBdPhone(a.phoneE164),
  status: a.status,
  roles,
  createdAt: a.createdAt,
});

export const RequestOtpResponse = z.object({
  data: z.object({ challengeId: z.uuid(), expiresAt: iso, resendAfterSeconds: z.number().int() }),
});

export const TokenResponse = z.object({
  data: z.object({
    accessToken: z.string(),
    accessTokenExpiresAt: iso,
    /** Only returned to native clients (`X-Client: mobile`); browsers get an httpOnly cookie. */
    refreshToken: z.string().optional(),
    refreshTokenExpiresAt: iso.optional(),
  }),
});

export const VerifyOtpResponse = z.object({
  data: TokenResponse.shape.data.extend({ account: AccountDto, isNewAccount: z.boolean() }),
});

export const AccountResponse = z.object({ data: AccountDto });

export const SessionDto = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  createdAt: iso,
  lastRefreshedAt: iso.nullable(),
  expiresAt: iso,
  current: z.boolean(),
});
export const toSessionDto = (
  s: SessionView,
  currentSessionId: string,
): z.output<typeof SessionDto> => ({
  id: s.id,
  deviceId: s.deviceId,
  createdAt: s.createdAt,
  lastRefreshedAt: s.lastRefreshedAt,
  expiresAt: s.expiresAt,
  current: s.id === currentSessionId,
});

export const DeviceDto = z.object({
  id: z.uuid(),
  platform: z.enum(DevicePlatforms),
  label: z.string().nullable(),
  trust: z.enum(['UNTRUSTED', 'TRUSTED', 'REVOKED']),
  createdAt: iso,
  lastSeenAt: iso,
  current: z.boolean(),
});
export const toDeviceDto = (d: Device, currentDeviceId: string): z.output<typeof DeviceDto> => ({
  id: d.id,
  platform: d.platform,
  label: d.label,
  trust: d.trust,
  createdAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
  current: d.id === currentDeviceId,
});

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
