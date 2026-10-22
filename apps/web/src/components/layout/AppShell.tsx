import { Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useIsStaff } from '../../features/desk/tools';
import { useSession } from '../../features/auth/session';
import { useUnread } from '../../features/notifications/useUnread';
import { useI18n } from '../../lib/i18n';
import { BellIcon, ChartIcon, HomeIcon, PlusIcon, UserIcon } from '../icons/icons';

/**
 * Green app bar (wordmark, top navigation on wide screens), page body, footer, and the thumb
 * tab bar on phones with Post raised in the middle. Moves focus to the page heading on route
 * change.
 */
export function AppShell() {
  const { t, lang, setLang, num } = useI18n();
  const { status } = useSession();
  const isStaff = useIsStaff();
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
  const focusComposer = () =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#post textarea')?.focus());

  return (
    <>
      <a className="skip-link" href="#main">
        {t('skip')}
      </a>
      <header className="appbar">
        <div className="appbar__in">
          <Link
            to="/"
            className="wordmark"
            aria-label={`${t('brand.latin')} — ${t('nav.catalog')}`}
          >
            <span className="wordmark__latin">{t('brand.latin').toLowerCase()}</span>
            <span className="wordmark__bn" lang="bn">
              {t('brand.bangla')}
            </span>
          </Link>
          <nav className="topnav" aria-label={t('nav.main')}>
            <NavLink to="/" end>
              {t('nav.catalog')}
            </NavLink>
            <NavLink to="/needs">{t('nav.needs')}</NavLink>
            <NavLink to="/listings">{t('nav.listings')}</NavLink>
            <NavLink to="/lend">{t('nav.lend')}</NavLink>
            <NavLink to="/auctions">{t('nav.auctions')}</NavLink>
            {signedIn && (
              <NavLink to="/inbox" aria-label={inboxLabel}>
                {t('nav.inbox')}
                {count}
              </NavLink>
            )}
            {signedIn && <NavLink to="/messages">{t('nav.messages')}</NavLink>}
            {signedIn && <NavLink to="/dashboard">{t('nav.dashboard')}</NavLink>}
            {signedIn && isStaff && <NavLink to="/desk">{t('nav.desk')}</NavLink>}
          </nav>
          <div className="appbar__actions">
            {toggle}
            <NavLink to={accountTo} className="appbar__account">
              {accountLabel}
            </NavLink>
          </div>
        </div>
      </header>

      <div className="shell">
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

      <nav className="tabbar" aria-label={t('nav.main')}>
        <NavLink to="/" end>
          <HomeIcon />
          <span>{t('nav.catalog')}</span>
        </NavLink>
        {signedIn ? (
          <NavLink to="/inbox" aria-label={inboxLabel}>
            <span className="navicon">
              <BellIcon />
              {count}
            </span>
            <span>{t('nav.inbox')}</span>
          </NavLink>
        ) : (
          <span className="tabbar__gap" aria-hidden="true" />
        )}
        <Link to="/#post" className="tabbar__post" onClick={focusComposer}>
          <span className="tabbar__plus">
            <PlusIcon />
          </span>
          <span>{t('nav.postShort')}</span>
        </Link>
        {signedIn ? (
          <NavLink to="/dashboard">
            <ChartIcon />
            <span>{t('nav.dashboard')}</span>
          </NavLink>
        ) : (
          <span className="tabbar__gap" aria-hidden="true" />
        )}
        <NavLink to={accountTo}>
          <UserIcon />
          <span>{accountLabel}</span>
        </NavLink>
      </nav>
    </>
  );
}
