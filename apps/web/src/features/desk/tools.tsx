import type { Permission } from '@dorkar/contracts/authz';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { SignedInOnly, StaffOnly } from '../../components/ui/Status';
import type { ReportTarget } from '../trust/api';
import { useCan } from '../auth/permissions';
import { useI18n, type MessageKey } from '../../lib/i18n';

/** Staff tools on the desk, each shown only to accounts holding its permission. */
export const DeskTools: Array<{ path: string; label: MessageKey; needs: Permission }> = [
  { path: '/desk/moderation', label: 'staff.tool.moderation', needs: 'moderation:case:read' },
  { path: '/desk/disputes', label: 'staff.tool.disputes', needs: 'dispute:read' },
  {
    path: '/desk/verifications',
    label: 'staff.tool.verifications',
    needs: 'verification:nid:decide',
  },
  { path: '/desk/accounts', label: 'staff.tool.accounts', needs: 'user:suspend' },
  { path: '/desk/categories', label: 'staff.tool.categories', needs: 'category:manage' },
  { path: '/desk/policies', label: 'staff.tool.policies', needs: 'policy:read' },
  { path: '/desk/auctions', label: 'staff.tool.auctions', needs: 'auction:manage' },
  { path: '/desk/deals', label: 'staff.tool.deals', needs: 'transaction:read:any' },
  { path: '/desk/activity', label: 'desk.activityLink', needs: 'audit:read' },
];

/** Whether the account may see the desk at all: the figures or any one tool. */
export function useIsStaff(): boolean {
  const can = useCan();
  return can('dashboard:read') || DeskTools.some((tool) => can(tool.needs));
}

export function DeskToolLinks() {
  const { t } = useI18n();
  const can = useCan();
  const tools = DeskTools.filter((tool) => can(tool.needs));
  if (tools.length === 0) return null;
  return (
    <nav className="desk__tools" aria-label={t('staff.tools')}>
      {tools.map((tool) => (
        <Link key={tool.path} className="btn btn--outline btn--small" to={tool.path}>
          {t(tool.label)}
        </Link>
      ))}
    </nav>
  );
}

/** The crumb back to the desk on every staff tool page. */
export function DeskCrumb() {
  const { t } = useI18n();
  return (
    <p className="crumb">
      <Link to="/desk">{t('desk.title')}</Link>
    </p>
  );
}

/** Where a reported thing can be seen, when it has a page of its own. */
export function targetLink(type: ReportTarget, id: string): string | null {
  switch (type) {
    case 'LISTING':
      return `/listings/${id}`;
    case 'NEED':
      return `/needs/${id}`;
    case 'OFFER':
      return `/offers/${id}`;
    case 'USER':
      return `/users/${id}`;
    case 'AUCTION':
      return `/auctions/${id}`;
    case 'LEND_ITEM':
      return `/lend/${id}`;
    default:
      return null;
  }
}

/** A staff page: signed in, holding the permission, or told it's staff only. */
export function StaffPage({
  needs,
  from,
  children,
}: {
  needs: Permission;
  from: string;
  children: ReactNode;
}) {
  return (
    <SignedInOnly from={from}>
      <Gate needs={needs}>{children}</Gate>
    </SignedInOnly>
  );
}

function Gate({ needs, children }: { needs: Permission; children: ReactNode }) {
  const can = useCan();
  return can(needs) ? <>{children}</> : <StaffOnly />;
}
