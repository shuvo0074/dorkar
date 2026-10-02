import { Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useSession } from '../../features/auth/session';
import { useI18n } from '../../lib/i18n';
import { CatalogIcon, InkDefs, PenIcon, PersonIcon } from '../glyphs/glyphs';

/** Masthead, navigation (top on wide screens, thumb bar on phones), footer, route focus. */
export function AppShell() {
  const { t, lang, setLang } = useI18n();
  const { status } = useSession();
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

  const accountTo = status === 'signedIn' ? '/account' : '/sign-in';
  const accountLabel = status === 'signedIn' ? t('nav.account') : t('nav.signIn');
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

      <nav className="bottomnav" aria-label={t('nav.main')}>
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
        <NavLink to={accountTo}>
          <PersonIcon />
          {accountLabel}
        </NavLink>
      </nav>
    </>
  );
}
