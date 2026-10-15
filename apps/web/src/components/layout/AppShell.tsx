import { Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useCan } from '../../features/auth/permissions';
import { useSession } from '../../features/auth/session';
import { useUnread } from '../../features/notifications/useUnread';
import { useI18n } from '../../lib/i18n';
import { CatalogIcon, InboxIcon, InkDefs, PenIcon, PersonIcon, TallyIcon } from '../glyphs/glyphs';

/** Masthead, navigation (top on wide screens, thumb bar on phones), footer, route focus. */
export function AppShell() {
  const { t, lang, setLang, num } = useI18n();
  const { status } = useSession();
  const can = useCan();
  const unread = useUnread();
  const signedIn = status === 'signedIn';
  const count = unread > 0 && (
    <span className="navcount" aria-hidden="true">
      {unread > 99 ? '99+' : num(unread)}
    </span>
  );
  const inboxLabel = unread > 0 ? t('inbox.badge', { n: unread }) : undefined;
  const location = useLocation();
  const lastPath = useRef(location.pathname);

  // Move focus to the new page's heading on navigation (not on first load, and idempotent
  // under StrictMode's double effects because it compares paths).
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    if (location.hash) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus());
  }, [location.pathname, location.hash]);

  const accountTo = signedIn ? '/account' : '/sign-in';
  const accountLabel = signedIn ? t('nav.account') : t('nav.signIn');
  const toggle = (
    <button
      type="button"
      className="lang-toggle"
      lang={lang === 'en' ? 'bn' : 'en'}
      aria-label={t('lang.switch')}
      onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}
    >
      {t('lang.other')}
    </button>
  );

  return (
    <>
      <InkDefs />
      <a className="skip-link" href="#main">
        {t('skip')}
      </a>
      <div className="shell">
        <header className="masthead">
          <Link
            to="/"
            className="wordmark"
            aria-label={`${t('brand.latin')} — ${t('nav.catalog')}`}
          >
            <span>{t('brand.latin')}</span>
            <span className="wordmark__bar" aria-hidden="true" />
            <span className="wordmark__bn" lang="bn">
              {t('brand.bangla')}
            </span>
          </Link>
          <p className="masthead__tag">
            {t('brand.tagline')
              .split(/(?<=[.।])\s+/)
              .map((part, i) => (
                <span key={i} className="masthead__line">
                  {part}
                </span>
              ))}
          </p>
          <nav className="topnav" aria-label={t('nav.main')}>
            <NavLink to="/" end>
              {t('nav.catalog')}
            </NavLink>
            <NavLink to="/needs">{t('nav.needs')}</NavLink>
            <NavLink to="/listings">{t('nav.listings')}</NavLink>
            <NavLink to="/lend">{t('nav.lend')}</NavLink>
            {signedIn && (
              <NavLink to="/inbox" aria-label={inboxLabel}>
                {t('nav.inbox')}
                {count}
              </NavLink>
            )}
            {signedIn && <NavLink to="/messages">{t('nav.messages')}</NavLink>}
            {signedIn && <NavLink to="/dashboard">{t('nav.dashboard')}</NavLink>}
            {signedIn && can('dashboard:read') && <NavLink to="/desk">{t('nav.desk')}</NavLink>}
            <NavLink to={accountTo}>{accountLabel}</NavLink>
            {toggle}
          </nav>
          <div className="mobile-only">{toggle}</div>
        </header>

        <main id="main">
          <Suspense fallback={<p className="route-loading">{t('loading')}</p>}>
            <Outlet />
          </Suspense>
        </main>

        <footer className="footer">
          <p>{t('privacy')}</p>
          <p className="muted">
            © {new Date().getFullYear()} {t('brand.latin')} · {t('brand.bangla')}
          </p>
        </footer>
      </div>

      <nav className={signedIn ? 'bottomnav bottomnav--5' : 'bottomnav'} aria-label={t('nav.main')}>
        <NavLink to="/" end>
          <CatalogIcon />
          {t('nav.catalog')}
        </NavLink>
        <Link
          to="/#post"
          onClick={() =>
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>('#post textarea')?.focus(),
            )
          }
        >
          <PenIcon />
          {t('nav.post')}
        </Link>
        {signedIn && (
          <NavLink to="/inbox" aria-label={inboxLabel}>
            <span className="navicon">
              <InboxIcon />
              {count}
            </span>
            {t('nav.inbox')}
          </NavLink>
        )}
        {signedIn && (
          <NavLink to="/dashboard">
            <TallyIcon />
            {t('nav.dashboard')}
          </NavLink>
        )}
        <NavLink to={accountTo}>
          <PersonIcon />
          {accountLabel}
        </NavLink>
      </nav>
    </>
  );
}
