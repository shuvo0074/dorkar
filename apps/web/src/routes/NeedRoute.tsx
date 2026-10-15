import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { useSession } from '../features/auth/session';
import { AttributeList } from '../features/catalog/AttributeList';
import { useCategories } from '../features/catalog/categories';
import {
  needCommands,
  needEditable,
  needsApi,
  type Need,
  type NeedCommand,
} from '../features/needs/api';
import { modeLetter, needCode } from '../features/needs/modes';
import { NeedTermsList } from '../features/needs/NeedTerms';
import { ApiError } from '../lib/http';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import NotFoundRoute from './NotFoundRoute';

export default function NeedRoute() {
  const { id = '' } = useParams();
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) return <LedgerSkeleton rows={6} />;
  if (need.error instanceof ApiError && need.error.status === 404) return <NotFoundRoute />;
  if (need.isError) return <LoadError onRetry={() => void need.refetch()} />;
  return <NeedPage need={need.data} />;
}

function NeedPage({ need }: { need: Need }) {
  const { t, date, num } = useI18n();
  const f = useFormat();
  const session = useSession();
  const categories = useCategories();
  const location = useLocation();
  const notice = (location.state as { notice?: 'posted' | 'draft' } | null)?.notice;
  const mine = session.account?.id === need.requesterId;
  const budget = f.range(need.budget.min, need.budget.max);

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/needs">{t('nav.needs')}</Link>
        </p>
        <div className="item__tag">
          <span className="modetile" aria-hidden="true">
            {modeLetter[need.mode]}
          </span>
          <span className="code">{t('need.code', { code: needCode(need) })}</span>
          <span className="stamp">{f.state(need.status)}</span>
        </div>
        <h1 tabIndex={-1}>{need.title}</h1>
        <p className="item__meta">
          {[
            f.place(need.location),
            budget ?? t('need.budget.none'),
            need.publishedAt
              ? t('need.posted', { when: f.relative(need.publishedAt) })
              : t('need.draft'),
          ].join(' · ')}
        </p>
        {notice && (
          <p className="alert alert--note" role="status">
            <NoteIcon />
            <span>{t(notice === 'posted' ? 'need.notice.posted' : 'need.notice.draft')}</span>
          </p>
        )}
        {mine && need.status === 'HIDDEN' && (
          <p className="alert" role="status">
            <AlertIcon />
            <span>{t('need.hidden')}</span>
          </p>
        )}
      </header>

      <section className="item__body" aria-labelledby="about-title">
        <div className="section-head">
          <h2 id="about-title">{t('need.about')}</h2>
        </div>
        {need.description && <p className="item__desc">{need.description}</p>}
        <dl className="facts">
          <div className="facts__row">
            <dt>{t('need.mode')}</dt>
            <dd>{t(`mode.${need.mode}`)}</dd>
          </div>
          <div className="facts__row">
            <dt>{t('need.category')}</dt>
            <dd>{categories.name(need.categoryId) || '—'}</dd>
          </div>
          <div className="facts__row">
            <dt>{t('need.quantity')}</dt>
            <dd>{num(need.quantity)}</dd>
          </div>
          <div className="facts__row">
            <dt>{t('need.budget')}</dt>
            <dd>
              {budget ?? t('need.budget.none')}
              {need.budget.flexible && <span className="facts__aside">{t('money.flexible')}</span>}
            </dd>
          </div>
          <div className="facts__row">
            <dt>{t('need.place')}</dt>
            <dd>{f.place(need.location)}</dd>
          </div>
          {need.mode !== 'HIRE' && (
            <div className="facts__row">
              <dt>{t('need.delivery')}</dt>
              <dd>{f.delivery(need.deliveryPreference)}</dd>
            </div>
          )}
          {need.mode !== 'HIRE' && (
            <div className="facts__row">
              <dt>{t('need.conditions')}</dt>
              <dd>
                {need.condition.length
                  ? need.condition.map((c) => f.condition(c)).join(', ')
                  : t('need.conditions.any')}
              </dd>
            </div>
          )}
          {need.requiredBy && (
            <div className="facts__row">
              <dt>{t('needForm.requiredBy')}</dt>
              <dd>{date(need.requiredBy, 'short')}</dd>
            </div>
          )}
          <NeedTermsList terms={need.modeTerms} />
          <AttributeList categoryId={need.categoryId} values={need.attributes} />
        </dl>
      </section>

      <aside className="item__side" aria-label={t('need.details')}>
        <div className="panel">
          <p className="item__count">
            {need.offerCount === 0
              ? t('need.offers.none')
              : need.offerCount === 1
                ? t('need.offers.one')
                : t('need.offers', { n: need.offerCount })}
          </p>
          {need.expiresAt && need.status === 'OPEN' && (
            <p className="muted">{t('need.expires', { when: date(need.expiresAt, 'short') })}</p>
          )}
          {mine ? (
            <OwnerControls need={need} />
          ) : session.status === 'signedIn' ? (
            need.status !== 'OPEN' && <p className="muted">{t('need.notOpen')}</p>
          ) : (
            <Link className="btn btn--block" to="/sign-in" state={{ from: `/needs/${need.id}` }}>
              {t('need.signInToOffer')}
            </Link>
          )}
        </div>
      </aside>

      {mine && need.history && need.history.length > 0 && <History need={need} />}
    </article>
  );
}

function OwnerControls({ need }: { need: Need }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (c: NeedCommand) => needsApi.command(need.id, c),
    onSuccess: (saved) => {
      setConfirm(false);
      qc.setQueryData(['needs', need.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const commands = needCommands[need.status];

  return (
    <div className="item__actions">
      <p className="label">{t('need.yours')}</p>
      {need.visibility === 'MATCHED_ONLY' && <p className="muted">{t('need.matchedOnly')}</p>}
      {needEditable(need.status) && (
        <Link className="btn btn--outline btn--small" to={`/needs/${need.id}/edit`}>
          {t('common.edit')}
        </Link>
      )}
      {commands
        .filter((c) => c !== 'close')
        .map((c) => (
          <button
            key={c}
            type="button"
            className={
              c === 'publish' || c === 'renew' ? 'btn btn--small' : 'btn btn--outline btn--small'
            }
            disabled={run.isPending}
            onClick={() => run.mutate(c)}
          >
            {t(`need.cmd.${c}`)}
          </button>
        ))}
      {commands.includes('close') && !confirm && (
        <button
          type="button"
          className="btn btn--danger btn--small"
          onClick={() => setConfirm(true)}
        >
          {t('need.cmd.close')}
        </button>
      )}
      {confirm && (
        <div className="ledger__confirm" role="group" aria-label={t('need.cmd.close')}>
          <p>{t('need.confirm.close')}</p>
          <button
            type="button"
            className="btn btn--danger btn--small"
            disabled={run.isPending}
            onClick={() => run.mutate('close')}
          >
            {t('need.confirm.yes')}
          </button>
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => setConfirm(false)}
          >
            {t('common.keep')}
          </button>
        </div>
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

function History({ need }: { need: Need }) {
  const { t, date } = useI18n();
  const f = useFormat();
  return (
    <section className="item__history" aria-labelledby="history-title">
      <div className="section-head">
        <h2 id="history-title">{t('need.history')}</h2>
      </div>
      <ol className="timeline">
        {[...(need.history ?? [])].reverse().map((h, i) => (
          <li key={i}>
            <time className="code" dateTime={h.at}>
              {date(h.at)}
            </time>
            <span>
              {h.from
                ? t('need.history.entry', { from: f.state(h.from), to: f.state(h.to) })
                : f.state(h.to)}
            </span>
            {h.reason === 'MODERATION' && (
              <span className="muted">{t('need.history.MODERATION')}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
