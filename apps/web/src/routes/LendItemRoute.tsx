import { findContactInfo } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TextAreaField, TextField } from '../components/forms/fields';
import { AlertIcon, LadderGlyph } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { useCategories } from '../features/catalog/categories';
import { itemCode, lendingApi, type LendItemDetail } from '../features/lending/api';
import { MediaImage } from '../features/media/Photos';
import { MessageButton } from '../features/messages/MessageButton';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { ApiError } from '../lib/http';
import { errorMessage, ruleOf } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useIntent } from '../lib/useIntent';
import NotFoundRoute from './NotFoundRoute';

export default function LendItemRoute() {
  const { id = '' } = useParams();
  const item = useQuery({ queryKey: ['lend-items', id], queryFn: () => lendingApi.item(id) });
  if (item.isPending) return <LedgerSkeleton rows={6} />;
  if (item.error instanceof ApiError && item.error.status === 404) return <NotFoundRoute />;
  if (item.isError) return <LoadError onRetry={() => void item.refetch()} />;
  return <ItemPage item={item.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ItemPage({ item }: { item: LendItemDetail }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const session = useSession();
  const categories = useCategories();
  const r = item.requirements;
  const reqs = [
    r.nidVerified && t('lend.req.nid'),
    r.minCompletedDeals > 0 && t('lend.req.deals', { n: r.minCompletedDeals }),
    r.minRating !== null && t('lend.req.rating', { n: r.minRating }),
  ].filter(Boolean);

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/lend">{t('lend.title')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('lend.code', { code: itemCode(item.id) })}</span>
          {!item.active && <span className="stamp">{t('lend.inactive')}</span>}
        </div>
        <h1 tabIndex={-1}>{item.title}</h1>
        <p className="item__meta">
          {f.district(item.district)} ·{' '}
          {item.deposit ? `${t('lend.deposit')} ${f.taka(item.deposit)}` : t('lend.noDeposit')}
        </p>
      </header>

      <section aria-labelledby="item-about">
        <div className="gallery">
          <div className="gallery__main">
            {item.mediaIds[0] ? (
              <MediaImage id={item.mediaIds[0]} variant="medium" fallback={<LadderGlyph />} />
            ) : (
              <LadderGlyph />
            )}
          </div>
        </div>
        <div className="section-head">
          <h2 id="item-about">{t('lend.about')}</h2>
        </div>
        {item.description && <p className="item__desc">{item.description}</p>}
        <dl className="facts">
          {!item.viewerIsOwner && (
            <Row label={t('lend.lender')}>
              <UserLink userId={item.lenderId} />
            </Row>
          )}
          <Row label={t('need.category')}>{categories.name(item.categoryId) || '—'}</Row>
          <Row label={t('lend.condition')}>{f.condition(item.condition)}</Row>
          <Row label={t('lend.deposit')}>
            {item.deposit ? f.taka(item.deposit) : t('lend.noDeposit')}
          </Row>
          <Row label={t('lend.maxDays')}>{t('lend.days', { n: item.maxLoanDays })}</Row>
          <Row label={t('lend.requirements')}>
            {reqs.length ? reqs.join(' · ') : t('lend.req.anyone')}
          </Row>
          <Row label={t('lend.stats')}>
            {t('lend.statsValue', { n: item.lenderStats.completedLoans })}
            {item.lenderStats.onTimeReturnRate !== null && (
              <span className="facts__aside">
                {t('lend.onTime', {
                  pct: num(Math.round(item.lenderStats.onTimeReturnRate * 100)),
                })}
              </span>
            )}
          </Row>
        </dl>
      </section>

      <aside className="item__side" aria-label={t('lend.ask')}>
        <div className="panel">
          {item.viewerIsOwner ? (
            <OwnerControls item={item} />
          ) : !item.active ? (
            <p className="muted">{t('lend.inactive')}</p>
          ) : session.status !== 'signedIn' ? (
            <Link className="btn btn--block" to="/sign-in" state={{ from: `/lend/${item.id}` }}>
              {t('lend.signIn')}
            </Link>
          ) : (
            <>
              <AskForm item={item} />
              <MessageButton
                contextType="LEND_ITEM"
                contextId={item.id}
                label={t('chat.messageLender')}
              />
            </>
          )}
        </div>
        {!item.viewerIsOwner && <ReportButton targetType="LEND_ITEM" targetId={item.id} />}
      </aside>
    </article>
  );
}

function AskForm({ item }: { item: LendItemDetail }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intent = useIntent();
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const ask = useMutation({
    mutationFn: (input: { startAt: string; returnBy: string; message?: string }) =>
      lendingApi.request({ itemId: item.id, ...input }, intent.key),
    onSuccess: (loan) => {
      intent.renew();
      qc.setQueryData(['loans', loan.id], loan);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/loans/${loan.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !until) return setError(t('common.badDate'));
    if (new Date(until) <= new Date(from)) return setError(t('common.badRange'));
    if (findContactInfo(message)) return setError(t('needForm.contact'));
    setError(undefined);
    ask.mutate({
      startAt: new Date(from).toISOString(),
      returnBy: new Date(until).toISOString(),
      ...(message.trim() ? { message: message.trim() } : {}),
    });
  };
  const notEligible = ruleOf(ask.error) === 'BORROWER_NOT_ELIGIBLE';

  return (
    <form className="buy" onSubmit={submit} noValidate aria-label={t('lend.ask')}>
      <TextField type="datetime-local" label={t('lend.from')} value={from} onChange={setFrom} />
      <TextField
        type="datetime-local"
        label={t('lend.returnBy')}
        value={until}
        onChange={setUntil}
      />
      <TextAreaField
        label={t('lend.message')}
        optional
        value={message}
        onChange={setMessage}
        maxLength={500}
        rows={2}
      />
      <button type="submit" className="btn btn--block" disabled={ask.isPending}>
        {t('lend.send')}
      </button>
      {(error || ask.isError) && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{error ?? (notEligible ? t('lend.notEligible') : errorMessage(ask.error, t))}</span>
        </p>
      )}
    </form>
  );
}

function OwnerControls({ item }: { item: LendItemDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [confirm, setConfirm] = useState(false);
  const done = () => {
    intent.renew();
    setConfirm(false);
    void qc.invalidateQueries({ queryKey: ['lend-items', item.id] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const stop = useMutation({
    mutationFn: () => lendingApi.deactivate(item.id, intent.key),
    onSuccess: done,
  });
  const restart = useMutation({
    mutationFn: () => lendingApi.update(item.id, { active: true }),
    onSuccess: done,
  });
  return (
    <div className="item__actions">
      <p className="label">{t('lend.yours')}</p>
      <Link className="btn btn--outline btn--small" to={`/lend/${item.id}/edit`}>
        {t('common.edit')}
      </Link>
      {item.active ? (
        confirm ? (
          <div className="ledger__confirm" role="group" aria-label={t('lend.deactivate')}>
            <p>{t('lend.deactivateConfirm')}</p>
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              {t('lend.deactivateYes')}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setConfirm(false)}
            >
              {t('common.keep')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--small"
            onClick={() => setConfirm(true)}
          >
            {t('lend.deactivate')}
          </button>
        )
      ) : (
        <button
          type="button"
          className="btn btn--small"
          disabled={restart.isPending}
          onClick={() => restart.mutate()}
        >
          {t('lend.reactivate')}
        </button>
      )}
      {(stop.isError || restart.isError) && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(stop.error ?? restart.error, t)}</span>
        </p>
      )}
    </div>
  );
}
