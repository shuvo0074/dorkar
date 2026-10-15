import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { TextAreaField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { catalogApi } from '../features/catalog/api';
import { dealCode } from '../features/deals/api';
import {
  bookingCode,
  rentalsApi,
  type BookingAction,
  type BookingDetail,
} from '../features/rentals/api';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function BookingRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/bookings/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const b = useQuery({ queryKey: ['bookings', id], queryFn: () => rentalsApi.get(id) });
  if (b.isPending) return <LedgerSkeleton rows={6} />;
  if (b.error instanceof ApiError && b.error.status === 404) return <NotFoundRoute />;
  if (b.isError) return <LoadError onRetry={() => void b.refetch()} />;
  return <BookingPage b={b.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function BookingPage({ b }: { b: BookingDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  const listing = useQuery({
    queryKey: ['listings', b.listingId],
    queryFn: () => catalogApi.listing(b.listingId),
  });
  const title =
    (typeof b.terms['listingTitle'] === 'string' ? b.terms['listingTitle'] : null) ??
    listing.data?.title ??
    t('booking.code', { code: bookingCode(b.id) });

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/bookings">{t('bookings.title')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('booking.code', { code: bookingCode(b.id) })}</span>
          <span className="stamp">{f.state(b.status)}</span>
          {b.viewerRole && <span className="muted">{t(`booking.as.${b.viewerRole}`)}</span>}
        </div>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="item__meta">
          {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })} · {f.taka(b.amount)}
        </p>
        {b.status === 'HELD' && b.holdExpiresAt && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>{t('booking.hold', { when: date(b.holdExpiresAt) })}</span>
          </p>
        )}
      </header>

      <section aria-labelledby="booking-facts">
        <div className="section-head">
          <h2 id="booking-facts">{t('need.details')}</h2>
        </div>
        <dl className="facts">
          <Row label={t('booking.listing')}>
            <Link to={`/listings/${b.listingId}`}>{listing.data?.title ?? t('chat.open')}</Link>
          </Row>
          {b.viewerRole && (
            <Row label={t('deal.otherSide')}>
              <UserLink userId={b.viewerRole === 'RENTER' ? b.ownerId : b.renterId} />
            </Row>
          )}
          <Row label={t('booking.period')}>
            {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
          </Row>
          <Row label={t('booking.amount')}>{f.taka(b.amount)}</Row>
          {b.deposit && <Row label={t('booking.deposit')}>{f.taka(b.deposit)}</Row>}
          {b.note && <Row label={t('booking.note')}>{b.note}</Row>}
          {b.declineReason && <Row label={t('booking.declined')}>{b.declineReason}</Row>}
          {b.cancelReason && <Row label={t('booking.cancelled')}>{b.cancelReason}</Row>}
          {b.transactionId && (
            <Row label={t('booking.deal')}>
              <Link to={`/deals/${b.transactionId}`}>{dealCode(b.transactionId)}</Link>
            </Row>
          )}
        </dl>
      </section>

      <aside className="item__side" aria-label={t('need.details')}>
        <div className="panel">
          <Actions b={b} />
        </div>
      </aside>

      <section className="item__wide" aria-labelledby="booking-timeline">
        <div className="section-head">
          <h2 id="booking-timeline">{t('booking.timeline')}</h2>
        </div>
        <ol className="timeline">
          {[...b.transitions].reverse().map((tr, i) => (
            <li key={i}>
              <time className="code" dateTime={tr.at}>
                {date(tr.at)}
              </time>
              <span>{`${f.state(tr.from)} → ${f.state(tr.to)}`}</span>
              <span className="muted">
                {tr.actorId === me ? t('deal.byYou') : tr.actorRole.toLowerCase()}
                {tr.reason && ` · “${tr.reason}”`}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Actions({ b }: { b: BookingDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [asking, setAsking] = useState<'decline' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const run = useMutation({
    mutationFn: ({ action, reason: r }: { action: BookingAction; reason?: string }) =>
      rentalsApi.act(b.id, action, r ? { reason: r } : {}, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setAsking(null);
      setReason('');
      qc.setQueryData(['bookings', b.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (b.actions.length === 0) return <p className="muted">{t('deal.noActions')}</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!asking) return;
    const r = reason.trim();
    if (asking === 'decline' && r.length < 3) return setError(t('common.required'));
    if (r && r.length < 3) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ action: asking, ...(r ? { reason: r } : {}) });
  };

  return (
    <div className="item__actions">
      {asking === null && (
        <>
          {b.actions.includes('confirm') && (
            <button
              type="button"
              className="btn btn--block"
              disabled={run.isPending}
              onClick={() => run.mutate({ action: 'confirm' })}
            >
              {t('booking.cmd.confirm')}
            </button>
          )}
          {b.actions.includes('approve') && (
            <button
              type="button"
              className="btn btn--block"
              disabled={run.isPending}
              onClick={() => run.mutate({ action: 'approve' })}
            >
              {t('booking.cmd.approve')}
            </button>
          )}
          {b.actions.includes('decline') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setAsking('decline')}
            >
              {t('booking.cmd.decline')}
            </button>
          )}
          {b.actions.includes('cancel') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setAsking('cancel')}
            >
              {t('booking.cmd.cancel')}
            </button>
          )}
        </>
      )}
      {asking && (
        <form className="counter counter--danger" onSubmit={submit} noValidate>
          <TextAreaField
            label={t('booking.reason')}
            optional={asking === 'cancel'}
            value={reason}
            onChange={setReason}
            maxLength={500}
            rows={3}
            error={error}
          />
          <div className="formactions">
            <button type="submit" className="btn btn--danger btn--small" disabled={run.isPending}>
              {t(asking === 'decline' ? 'booking.confirmDecline' : 'booking.confirmCancel')}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setAsking(null)}
            >
              {t('common.keep')}
            </button>
          </div>
        </form>
      )}
      {run.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(run.error, t)}</span>
        </p>
      )}
    </div>
  );
}
