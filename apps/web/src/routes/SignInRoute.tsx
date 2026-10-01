import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { SignInFlow } from '../features/auth/SignInFlow';
import { useSession } from '../features/auth/session';
import { useI18n } from '../lib/i18n';

interface FromState {
  from?: string;
}

export default function SignInRoute() {
  const { t } = useI18n();
  const { status } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as FromState | null)?.from;
  const safeFrom = from && from.startsWith('/') && !from.startsWith('//') ? from : '/account';

  // Already signed in (e.g. restored session): nothing to do here.
  useEffect(() => {
    if (status === 'signedIn' && !location.state) void navigate('/account', { replace: true });
  }, [status, location.state, navigate]);

  return (
    <div className="signin">
      <header>
        <h1 tabIndex={-1}>{t('signin.title')}</h1>
        <p className="signin__lede">{t('signin.lede')}</p>
      </header>
      <SignInFlow
        onDone={(r) => {
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          const target = r.isNewAccount ? '/account' : safeFrom;
          setTimeout(
            () => void navigate(target, { replace: true, state: { welcome: r.isNewAccount } }),
            reduce ? 0 : 750,
          );
        }}
      />
    </div>
  );
}
