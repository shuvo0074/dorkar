import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Segmented, SelectField, TextAreaField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { useCan } from '../../features/auth/permissions';
import { useSession } from '../../features/auth/session';
import {
  deskApi,
  type CaseStatus,
  type Decision,
  type ModCaseDetail,
} from '../../features/desk/api';
import { DeskCrumb, StaffPage, targetLink } from '../../features/desk/tools';
import type { ReportTarget } from '../../features/trust/api';
import { errorMessage } from '../../lib/errors';
import { shortCode, useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

const TARGETS: ReportTarget[] = [
  'LISTING',
  'NEED',
  'OFFER',
  'REVIEW',
  'USER',
  'MESSAGE',
  'AUCTION',
  'LEND_ITEM',
];

export default function ModerationRoute() {
  const { id } = useParams();
  return (
    <StaffPage
      needs="moderation:case:read"
      from={id ? `/desk/moderation/${id}` : '/desk/moderation'}
    >
      {id ? <CaseLoader id={id} /> : <Queue />}
    </StaffPage>
  );
}

function Queue() {
  const { t } = useI18n();
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'OPEN') as CaseStatus;
  const targetType = (params.get('target') || undefined) as ReportTarget | undefined;
  const list = usePaged(['desk', 'cases', status, targetType], (cursor) =>
    deskApi.cases({ status, targetType }, cursor),
  );
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('mod.title')}</h1>
        <p className="desk__lede">{t('mod.lede')}</p>
      </header>
      <section aria-labelledby="cases-title">
        <div className="section-head">
          <h2 id="cases-title">{t('mod.title')}</h2>
        </div>
        <div className="desk__controls">
          <Segmented
            legend={t('mod.status')}
            name="case-status"
            value={status}
            onChange={(v) => set('status', v)}
            options={(['OPEN', 'ACTIONED', 'DISMISSED'] as const).map((s) => ({
              value: s,
              label: f.state(s),
            }))}
          />
          <SelectField
            compact
            label={t('mod.target')}
            value={targetType ?? ''}
            onChange={(v) => set('target', v)}
            placeholder={t('staff.any')}
            options={TARGETS.map((x) => ({ value: x, label: t(`target.${x}`) }))}
          />
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('mod.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((c) => (
              <li key={c.id}>
                <span className="ledger__art code">{c.priority}</span>
                <div>
                  <Link className="ledger__title" to={`/desk/moderation/${c.id}`}>
                    {t(`target.${c.targetType}`)} · {t('mod.reports', { n: c.reportCount })}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      shortCode('C', c.id),
                      t('mod.topReason', { reason: t(`report.reason.${c.topReason}`) }),
                      c.targetHidden && t('mod.hidden'),
                      c.assignedTo
                        ? t('staff.assigned', { who: shortCode('M', c.assignedTo) })
                        : t('staff.unassigned'),
                      f.relative(c.openedAt),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}

function CaseLoader({ id }: { id: string }) {
  const c = useQuery({ queryKey: ['desk', 'case', id], queryFn: () => deskApi.case(id) });
  if (c.isPending) return <LedgerSkeleton rows={6} />;
  if (c.isError) return <LoadError onRetry={() => void c.refetch()} />;
  return <CasePage c={c.data} />;
}

function CasePage({ c }: { c: ModCaseDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const can = useCan();
  const me = useSession().account?.id;
  const qc = useQueryClient();
  const [action, setAction] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['desk', 'case', c.id] });
    void qc.invalidateQueries({ queryKey: ['desk', 'cases'] });
  };
  const assign = useMutation({ mutationFn: () => deskApi.assignCase(c.id), onSuccess: refresh });
  const decide = useMutation({
    mutationFn: () => deskApi.decide(c.id, action!, reason.trim()),
    onSuccess: () => {
      setAction(null);
      setReason('');
      refresh();
    },
  });
  const link = targetLink(c.targetType, c.targetId);
  const options: Decision[] = [];
  if (c.status === 'OPEN') {
    if (c.targetType !== 'USER' && can('moderation:content:hide')) options.push('HIDE');
    options.push('DISMISS');
  }
  if (c.targetHidden && c.targetType !== 'USER' && can('moderation:content:restore'))
    options.push('RESTORE');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t('staff.reasonHint'));
    setError(undefined);
    decide.mutate();
  };

  return (
    <article className="item">
      <header className="item__head">
        <p className="crumb">
          <Link to="/desk/moderation">{t('mod.title')}</Link>
        </p>
        <div className="item__tag">
          <span className="code">{t('mod.case', { code: shortCode('C', c.id) })}</span>
          <span className="stamp">{f.state(c.status)}</span>
          {c.targetHidden && <span className="stamp stamp--ink">{t('mod.hidden')}</span>}
        </div>
        <h1 tabIndex={-1}>
          {t(`target.${c.targetType}`)} · {t('mod.reports', { n: c.reportCount })}
        </h1>
        <p className="item__meta">
          {link ? (
            <Link to={link}>{t('mod.openTarget')}</Link>
          ) : (
            <span className="code">{c.targetId}</span>
          )}
          {' · '}
          {t('mod.priority', { n: c.priority })}
        </p>
        {c.targetType === 'USER' && (
          <p className="alert alert--note">
            <NoteIcon />
            <span>
              {t('mod.userTarget')}{' '}
              <Link to={`/desk/accounts?id=${c.targetId}`}>{t('staff.tool.accounts')}</Link>
            </span>
          </p>
        )}
      </header>

      <section aria-labelledby="reports-title">
        <div className="section-head">
          <h2 id="reports-title">{t('mod.reportsTitle')}</h2>
        </div>
        <ol className="timeline">
          {c.reports.map((r) => (
            <li key={r.id}>
              <time className="code" dateTime={r.createdAt}>
                {date(r.createdAt)}
              </time>
              <span>
                <strong>{t(`report.reason.${r.reason}`)}</strong> · {shortCode('M', r.reporterId)}
              </span>
              {r.details && <span className="muted">“{r.details}”</span>}
            </li>
          ))}
        </ol>
      </section>

      <aside className="item__side" aria-label={t('staff.tools')}>
        <div className="panel">
          <p className="muted">
            {c.assignedTo
              ? t('staff.assigned', {
                  who: c.assignedTo === me ? t('staff.you') : shortCode('M', c.assignedTo),
                })
              : t('staff.unassigned')}
          </p>
          <div className="item__actions">
            {c.status === 'OPEN' && c.assignedTo !== me && (
              <button
                type="button"
                className="btn btn--outline btn--small"
                disabled={assign.isPending}
                onClick={() => assign.mutate()}
              >
                {t('staff.assignMe')}
              </button>
            )}
            {action === null &&
              options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={
                    o === 'HIDE' ? 'btn btn--danger btn--small' : 'btn btn--outline btn--small'
                  }
                  onClick={() => setAction(o)}
                >
                  {t(`mod.action.${o}`)}
                </button>
              ))}
            {action && (
              <form className="counter" onSubmit={submit} noValidate>
                <TextAreaField
                  label={t('staff.reason')}
                  hint={t('staff.reasonHint')}
                  value={reason}
                  onChange={setReason}
                  maxLength={500}
                  rows={3}
                  error={error}
                />
                <div className="formactions">
                  <button type="submit" className="btn btn--small" disabled={decide.isPending}>
                    {t(`mod.action.${action}`)}
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline btn--small"
                    onClick={() => setAction(null)}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            )}
            {(decide.isError || assign.isError) && (
              <p className="alert" role="alert">
                <AlertIcon />
                <span>{errorMessage(decide.error ?? assign.error, t)}</span>
              </p>
            )}
          </div>
        </div>
      </aside>

      {c.actions.length > 0 && (
        <section className="item__wide" aria-labelledby="mod-history">
          <div className="section-head">
            <h2 id="mod-history">{t('mod.history')}</h2>
          </div>
          <ol className="timeline">
            {[...c.actions].reverse().map((a) => (
              <li key={a.id}>
                <time className="code" dateTime={a.createdAt}>
                  {date(a.createdAt)}
                </time>
                <span>
                  <strong>{t(`mod.kind.${a.action}`)}</strong> ·{' '}
                  {a.moderatorId === me ? t('staff.you') : shortCode('M', a.moderatorId)}
                </span>
                {a.reason && <span className="muted">“{a.reason}”</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
