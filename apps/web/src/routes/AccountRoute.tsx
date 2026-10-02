import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { LaptopGlyph, PersonGlyph, PhoneGlyph } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { accountApi, type DeviceView } from '../features/account/api';
import { useSession } from '../features/auth/session';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';

const isHandheld = (d: DeviceView) => d.platform !== 'web' || /Android|iOS/.test(d.label ?? '');

export default function AccountRoute() {
  const { t, date } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const welcome = (location.state as { welcome?: boolean } | null)?.welcome;

  useEffect(() => {
    if (session.status === 'signedOut') {
      void navigate('/sign-in', { replace: true, state: { from: '/account' } });
    }
  }, [session.status, navigate]);

  if (session.status !== 'signedIn' || !session.account) {
    return <p className="route-loading">{t('loading')}</p>;
  }
  const a = session.account;
  const memberCode = `M-${a.id.replace(/-/g, '').slice(-6).toUpperCase()}`;

  return (
    <div className="account">
      <header>
        <h1 tabIndex={-1}>{t('account.title')}</h1>
        {welcome && (
          <p className="welcome" role="status">
            {t('account.welcome')}
          </p>
        )}
      </header>

      <section className="member" aria-label={t('account.member')}>
        <div className="member__badge">
          <PersonGlyph />
          <Biro tilt={-6} />
        </div>
        <dl>
          <dt>{t('account.member')}</dt>
          <dd className="code">{memberCode}</dd>
          <dt>{t('account.phone')}</dt>
          <dd className="code">{a.phoneMasked}</dd>
          <dt>{t('account.status')}</dt>
          <dd>{t(`account.status.${a.status}`)}</dd>
          <dt>{t('account.joined')}</dt>
          <dd>{date(a.createdAt, 'short')}</dd>
        </dl>
      </section>

      <Devices />
      <Sessions />

      <div className="account__actions">
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => {
            // Leave first: once the session ends this page would redirect to sign-in instead.
            void navigate('/', { replace: true });
            void session.signOut('this');
          }}
        >
          {t('account.signOut')}
        </button>
      </div>

      <SignOutEverywhere />
    </div>
  );
}

function Devices() {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['me', 'devices'], queryFn: accountApi.devices });
  const revoke = useMutation({
    mutationFn: accountApi.revokeDevice,
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <section aria-labelledby="devices-title">
      <div className="section-head">
        <h2 id="devices-title">{t('devices.title')}</h2>
      </div>
      {devices.isPending && <LedgerSkeleton />}
      {devices.isError && <LoadError onRetry={() => void devices.refetch()} />}
      {devices.data && devices.data.length === 0 && <p className="muted">{t('devices.empty')}</p>}
      {devices.data && devices.data.length > 0 && (
        <ul className="ledger">
          {devices.data.map((d) => {
            const name = d.label ?? d.platform;
            return (
              <li key={d.id}>
                <span className="ledger__art">
                  {isHandheld(d) ? <PhoneGlyph /> : <LaptopGlyph />}
                </span>
                <div>
                  <span className="ledger__title">{name}</span>
                  {d.current && (
                    <span className="ledger__here">
                      {t('devices.current')}
                      <Biro tilt={-3} />
                    </span>
                  )}
                  <p className="ledger__meta">
                    {t(`devices.trust.${d.trust}`)} · {t('devices.lastSeen')} {date(d.lastSeenAt)}
                  </p>
                </div>
                {!d.current && confirming !== d.id && (
                  <button
                    type="button"
                    className="btn btn--danger btn--small"
                    onClick={() => setConfirming(d.id)}
                  >
                    {t('devices.revoke')}
                  </button>
                )}
                {confirming === d.id && (
                  <div className="ledger__confirm" role="group" aria-label={t('devices.revoke')}>
                    <p>{t('devices.confirm', { name })}</p>
                    <button
                      type="button"
                      className="btn btn--danger btn--small"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(d.id)}
                    >
                      {t('devices.confirmYes')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--outline btn--small"
                      onClick={() => setConfirming(null)}
                    >
                      {t('devices.cancel')}
                    </button>
                    {revoke.isError && (
                      <p className="alert" role="alert">
                        {errorMessage(revoke.error, t)}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Sessions() {
  const { t, date } = useI18n();
  const sessions = useQuery({ queryKey: ['me', 'sessions'], queryFn: accountApi.sessions });

  return (
    <section aria-labelledby="sessions-title">
      <div className="section-head">
        <h2 id="sessions-title">{t('sessions.title')}</h2>
      </div>
      {sessions.isPending && <LedgerSkeleton />}
      {sessions.isError && <LoadError onRetry={() => void sessions.refetch()} />}
      {sessions.data && (
        <ul className="ledger">
          {sessions.data.map((s, i) => (
            <li key={s.id}>
              <span className="ledger__art code">S-{String(i + 1).padStart(2, '0')}</span>
              <div>
                <span className="ledger__title">
                  {t('sessions.started')} {date(s.createdAt)}
                </span>
                {s.current && (
                  <span className="ledger__here">
                    {t('sessions.current')}
                    <Biro tilt={2} />
                  </span>
                )}
                <p className="ledger__meta">
                  {t('sessions.refreshed')} {date(s.lastRefreshedAt ?? s.createdAt)} ·{' '}
                  {t('sessions.expires')} {date(s.expiresAt, 'short')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SignOutEverywhere() {
  const { t } = useI18n();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <section className="danger-zone" aria-labelledby="everywhere-title">
      <h2 id="everywhere-title" className="visually-hidden">
        {t('account.signOutAll')}
      </h2>
      <p>{t('account.signOutAllHelp')}</p>
      {!confirm ? (
        <div>
          <button type="button" className="btn btn--danger" onClick={() => setConfirm(true)}>
            {t('account.signOutAll')}
          </button>
        </div>
      ) : (
        <div className="ledger__confirm" role="group" aria-label={t('account.signOutAll')}>
          <p>{t('account.signOutAllConfirm')}</p>
          <button
            type="button"
            className="btn btn--danger btn--small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void navigate('/', { replace: true });
              void signOut('all');
            }}
          >
            {t('account.signOutAll')}
          </button>
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => setConfirm(false)}
          >
            {t('devices.cancel')}
          </button>
        </div>
      )}
    </section>
  );
}

function LedgerSkeleton() {
  return (
    <div aria-hidden="true" style={{ display: 'grid', gap: 14, paddingTop: 8 }}>
      <div className="skeleton" style={{ width: '70%' }} />
      <div className="skeleton" style={{ width: '45%' }} />
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="alert" role="alert">
      <span />
      <span>
        {t('account.error')}{' '}
        <button type="button" className="linkbtn" onClick={onRetry}>
          {t('account.retry')}
        </button>
      </span>
    </div>
  );
}
