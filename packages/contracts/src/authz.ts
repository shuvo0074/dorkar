/**
 * Roles and permissions. Roles are granted in identity and carried in access tokens;
 * permissions are what code checks. The role→permission map is the seed for the
 * DB-backed, admin-editable map (moderation/admin module) — code never checks roles directly.
 */

export const Roles = [
  'MEMBER',
  'BUSINESS',
  'MODERATOR',
  'SUPPORT',
  'ADMIN',
  'SUPER_ADMIN',
] as const;
export type Role = (typeof Roles)[number];

export const Permissions = [
  'need:create',
  'offer:create',
  'listing:create',
  'review:create',
  'report:create',
  'sourcing:bulk',
  'user:read:basic',
  'user:suspend',
  'moderation:case:read',
  'moderation:content:hide',
  'moderation:content:restore',
  'transaction:read:any',
  'dispute:read',
  'category:manage',
  'policy:read',
  'policy:write',
  'audit:read',
  'role:grant',
  'verification:nid:read',
] as const;
export type Permission = (typeof Permissions)[number];

const MEMBER: Permission[] = [
  'need:create',
  'offer:create',
  'listing:create',
  'review:create',
  'report:create',
];
const MODERATOR: Permission[] = [
  'user:read:basic',
  'moderation:case:read',
  'moderation:content:hide',
  'moderation:content:restore',
];
const SUPPORT: Permission[] = ['user:read:basic', 'transaction:read:any', 'dispute:read'];
const ADMIN: Permission[] = [
  ...MODERATOR,
  ...SUPPORT,
  'user:suspend',
  'category:manage',
  'policy:read',
  'audit:read',
];

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  MEMBER,
  BUSINESS: [...MEMBER, 'sourcing:bulk'],
  MODERATOR,
  SUPPORT,
  ADMIN,
  SUPER_ADMIN: [...ADMIN, 'policy:write', 'role:grant', 'verification:nid:read'],
};

export function permissionsFor(
  roles: readonly Role[],
  map: Readonly<Record<Role, readonly Permission[]>> = DEFAULT_ROLE_PERMISSIONS,
): ReadonlySet<Permission> {
  return new Set(roles.flatMap((r) => map[r] ?? []));
}
