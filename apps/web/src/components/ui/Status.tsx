import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../features/auth/session';
import { useI18n } from '../../lib/i18n';

/** Dashed placeholder lines while a ledger loads. */
export function LedgerSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="skeleton-stack">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: i % 2 ? '45%' : '70%' }} />
      ))}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="alert" role="alert">
      <span />
      <span>
        {message ?? t('load.error')}{' '}
        <button type="button" className="linkbtn" onClick={onRetry}>
          {t('account.retry')}
        </button>
      </span>
    </div>
  );
}

/**
 * Renders children only for a signed-in session; sends signed-out visitors to sign in and
 * back here afterwards.
 */
export function SignedInOnly({ from, children }: { from: string; children: ReactNode }) {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (session.status === 'signedOut') {
      void navigate('/sign-in', { replace: true, state: { from } });
    }
  }, [session.status, navigate, from]);
  if (session.status !== 'signedIn' || !session.account) {
    return <p className="route-loading">{t('loading')}</p>;
  }
  return <>{children}</>;
}

/** Shown to a signed-in account that lacks the permission a staff page needs. */
export function StaffOnly() {
  const { t } = useI18n();
  return (
    <div className="notfound">
      <h1 tabIndex={-1}>{t('desk.forbidden.title')}</h1>
      <p>{t('desk.forbidden.body')}</p>
    </div>
  );
}
