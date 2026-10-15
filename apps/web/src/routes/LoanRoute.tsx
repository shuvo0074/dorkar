import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { TextAreaField } from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { dealCode } from '../features/deals/api';
import { lendingApi, loanCode, type LoanAction, type LoanDetail } from '../features/lending/api';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function LoanRoute() {
  const { id = '' } = useParams();
  return (
    <SignedInOnly from={`/loans/${id}`}>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const loan = useQuery({ queryKey: ['loans', id], queryFn: () => lendingApi.loan(id) });
  if (loan.isPending) return <LedgerSkeleton rows={6} />;
  if (loan.error instanceof ApiError && loan.error.status === 404) return <NotFoundRoute />;
  if (loan.isError) return <LoadError onRetry={() => void loan.refetch()} />;
  return <LoanPage loan={loan.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LoanPage({ loan }: { loan: LoanDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/loans">{t('loans.title')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('loan.code', { code: loanCode(loan.id) })}</span>
          <span className="stamp">{f.state(loan.status)}</span>
          {loan.overdue && <span className="stamp stamp--ink">{t('loan.overdue')}</span>}
          {loan.viewerRole && <span className="muted">{t(`loan.as.${loan.viewerRole}`)}</span>}
        </div>
        <h1 tabIndex={-1}>{loan.itemTitle}</h1>
        <p className="item__meta">
          {t('dash.period', { from: date(loan.startAt), to: date(loan.returnBy) })}
        </p>
        {loan.status === 'APPROVED' && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>{t('loan.handover')}</span>
          </p>
        )}
      </header>
      <section aria-labelledby="loan-facts">
        <div className="section-head">
          <h2 id="loan-facts">{t('need.details')}</h2>
        </div>
        <dl className="facts">
          <Row label={t('loan.item')}>
            <Link to={`/lend/${loan.itemId}`}>{loan.itemTitle}</Link>
          </Row>
          {loan.viewerRole && (
            <Row label={t('deal.otherSide')}>
              <UserLink userId={loan.viewerRole === 'LENDER' ? loan.borrowerId : loan.lenderId} />
            </Row>
          )}
          <Row label={t('loan.period')}>
            {t('dash.period', { from: date(loan.startAt), to: date(loan.returnBy) })}
          </Row>
          <Row label={t('lend.deposit')}>
            {loan.deposit ? f.taka(loan.deposit) : t('lend.noDeposit')}
          </Row>
          {loan.message && <Row label={t('loan.message')}>{loan.message}</Row>}
          {loan.declineReason && <Row label={t('loan.declined')}>{loan.declineReason}</Row>}
          {loan.returnedAt && <Row label={t('loan.returned')}>{date(loan.returnedAt)}</Row>}
          {loan.transactionId && (
            <Row label={t('loan.deal')}>
              <Link to={`/deals/${loan.transactionId}`}>{dealCode(loan.transactionId)}</Link>
            </Row>
          )}
        </dl>
      </section>
      <aside className="item__side" aria-label={t('need.details')}>
        <div className="panel">
          <Actions loan={loan} />
        </div>
      </aside>
      <section className="item__wide" aria-labelledby="loan-timeline">
        <div className="section-head">
          <h2 id="loan-timeline">{t('loan.timeline')}</h2>
        </div>
        <ol className="timeline">
          {[...loan.transitions].reverse().map((tr, i) => (
            <li key={i}>
              <time className="code" dateTime={tr.at}>
                {date(tr.at)}
              </time>
              <span>{tr.from ? `${f.state(tr.from)} → ${f.state(tr.to)}` : f.state(tr.to)}</span>
              <span className="muted">
                {tr.actorId === me
                  ? t('deal.byYou')
                  : tr.actorRole === 'SYSTEM'
                    ? t('deal.by.SYSTEM')
                    : t(`dash.role.${tr.actorRole}`)}
                {tr.reason && ` · “${tr.reason}”`}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Actions({ loan }: { loan: LoanDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [asking, setAsking] = useState<'decline' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const run = useMutation({
    mutationFn: ({ action, reason: r }: { action: LoanAction; reason?: string }) =>
      lendingApi.act(loan.id, action, r ? { reason: r } : {}, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setAsking(null);
      qc.setQueryData(['loans', loan.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (loan.actions.length === 0) return <p className="muted">{t('deal.noActions')}</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!asking) return;
    const r = reason.trim();
    if ((asking === 'decline' || r) && r.length < 3) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ action: asking, ...(r ? { reason: r } : {}) });
  };
  return (
    <div className="item__actions">
      {asking === null && (
        <>
          {loan.actions.includes('approve') && (
            <button
              type="button"
              className="btn btn--block"
              disabled={run.isPending}
              onClick={() => run.mutate({ action: 'approve' })}
            >
              {t('loan.cmd.approve')}
            </button>
          )}
          {loan.actions.includes('decline') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setAsking('decline')}
            >
              {t('loan.cmd.decline')}
            </button>
          )}
          {loan.actions.includes('cancel') && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => setAsking('cancel')}
            >
              {t('loan.cmd.cancel')}
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
              {t(asking === 'decline' ? 'loan.cmd.decline' : 'loan.cmd.cancel')}
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
