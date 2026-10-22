import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LedgerSkeleton, LoadError, SignedInOnly, StaffOnly } from '../components/ui/Status';
import { useCan } from '../features/auth/permissions';
import {
  ActorTypes,
  dashboardApi,
  type Activity,
  type ActivityFilter,
  type ActorType,
} from '../features/dashboard/api';
import { shortCode, useFormat } from '../features/dashboard/format';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { FilterPanel } from '../components/ui/FilterPanel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILTER_KEYS = [
  'service',
  'action',
  'actorType',
  'actorId',
  'targetType',
  'targetId',
  'from',
  'to',
] as const;

/** Filters live in the URL so a filtered log can be bookmarked or shared with a colleague. */
function readFilter(params: URLSearchParams): ActivityFilter {
  const get = (k: string) => params.get(k) || undefined;
  const actorType = get('actorType');
  const actorId = get('actorId');
  const from = get('from');
  const to = get('to');
  return {
    service: get('service'),
    action: get('action'),
    actorType: ActorTypes.includes(actorType as ActorType) ? (actorType as ActorType) : undefined,
    actorId: actorId && UUID.test(actorId) ? actorId : undefined,
    targetType: get('targetType'),
    targetId: get('targetId'),
    from: from && DAY.test(from) ? from : undefined,
    to: to && DAY.test(to) ? to : undefined,
  };
}

export default function ActivityRoute() {
  return (
    <SignedInOnly from="/desk/activity">
      <ActivityLog />
    </SignedInOnly>
  );
}

function ActivityLog() {
  const { t } = useI18n();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params);
  const allowed = can('audit:read');

  const log = useInfiniteQuery({
    queryKey: ['me', 'desk', 'activity', filter],
    queryFn: ({ pageParam }) => dashboardApi.activity(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: allowed,
  });
  if (!allowed) return <StaffOnly />;

  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const apply = (next: ActivityFilter) => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = next[k];
      if (v) q.set(k, v);
    }
    setParams(q);
  };

  return (
    <div className="activity">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/desk">{t('desk.title')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('log.title')}</h1>
        <p className="desk__lede">{t('log.lede')}</p>
      </header>

      <Filters key={params.toString()} filter={filter} onApply={apply} />

      <section aria-labelledby="log-title" aria-busy={log.isFetching}>
        <div className="section-head">
          <h2 id="log-title">{t('log.entries')}</h2>
          {log.data && <p>{t('log.count', { n: rows.length })}</p>}
        </div>
        {log.isPending && <LedgerSkeleton rows={5} />}
        {log.isError && <LoadError onRetry={() => void log.refetch()} />}
        {log.data && rows.length === 0 && <p className="muted">{t('log.empty')}</p>}
        {rows.length > 0 && (
          <ol className="ledger logrows">
            {rows.map((a) => (
              <LogRow key={a.id} a={a} onFilter={(f) => apply({ ...filter, ...f })} />
            ))}
          </ol>
        )}
        {log.hasNextPage && (
          <div className="logmore">
            <button
              type="button"
              className="btn btn--outline btn--small"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {log.isFetchingNextPage ? t('loading') : t('log.more')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Filters({
  filter,
  onApply,
}: {
  filter: ActivityFilter;
  onApply: (f: ActivityFilter) => void;
}) {
  const { t, num } = useI18n();
  const f = useFormat();
  const facets = useQuery({ queryKey: ['me', 'desk', 'facets'], queryFn: dashboardApi.facets });
  const [draft, setDraft] = useState<ActivityFilter>(filter);
  const [error, setError] = useState<string | null>(null);
  const exportCsv = useMutation({ mutationFn: () => dashboardApi.exportCsv(filter) });

  const set = (k: keyof ActivityFilter, v: string) =>
    setDraft((d) => ({ ...d, [k]: v === '' ? undefined : v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.actorId && !UUID.test(draft.actorId)) return setError(t('log.invalidId'));
    if (draft.from && draft.to && draft.from > draft.to) return setError(t('log.badRange'));
    setError(null);
    onApply(draft);
  };

  const download = async () => {
    const blob = await exportCsv.mutateAsync();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dorkar-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <FilterPanel titleId="filters-title" title={t('log.filters')}>
      <form onSubmit={submit} noValidate>
        <div className="filters__grid">
          <Select
            id="f-service"
            label={t('log.service')}
            value={draft.service ?? ''}
            onChange={(v) => set('service', v)}
            options={(facets.data?.services ?? []).map((s) => ({
              value: s.service,
              label: `${f.service(s.service)} (${num(s.count)})`,
            }))}
            current={filter.service}
          />
          <Select
            id="f-action"
            label={t('log.action')}
            value={draft.action ?? ''}
            onChange={(v) => set('action', v)}
            options={(facets.data?.actions ?? []).map((a) => ({
              value: a.action,
              label: `${a.label} (${num(a.count)})`,
            }))}
            current={filter.action}
            optionLang="en"
          />
          <Select
            id="f-actor-type"
            label={t('log.actorType')}
            value={draft.actorType ?? ''}
            onChange={(v) => set('actorType', v)}
            options={ActorTypes.map((a) => ({ value: a, label: t(`actor.${a}`) }))}
          />
          <div className="field field--compact">
            <label className="label" htmlFor="f-actor-id">
              {t('log.actorId')}
            </label>
            <div className="field__control">
              <input
                id="f-actor-id"
                value={draft.actorId ?? ''}
                onChange={(e) => set('actorId', e.target.value.trim())}
                spellCheck={false}
                autoComplete="off"
                placeholder="0192f0c4-…"
              />
            </div>
          </div>
          <div className="field field--compact">
            <label className="label" htmlFor="f-from">
              {t('log.from')}
            </label>
            <div className="field__control">
              <input
                id="f-from"
                type="date"
                value={draft.from ?? ''}
                onChange={(e) => set('from', e.target.value)}
              />
            </div>
          </div>
          <div className="field field--compact">
            <label className="label" htmlFor="f-to">
              {t('log.to')}
            </label>
            <div className="field__control">
              <input
                id="f-to"
                type="date"
                value={draft.to ?? ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </div>
          </div>
        </div>
        {error && (
          <p className="alert" role="alert">
            <span />
            <span>{error}</span>
          </p>
        )}
        <div className="filters__actions">
          <button type="submit" className="btn btn--small">
            {t('log.apply')}
          </button>
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => {
              setDraft({});
              setError(null);
              onApply({});
            }}
          >
            {t('log.reset')}
          </button>
          <button
            type="button"
            className="btn btn--outline btn--small filters__export"
            disabled={exportCsv.isPending}
            onClick={() => void download()}
          >
            {exportCsv.isPending ? t('log.exporting') : t('log.export')}
          </button>
        </div>
        <p className="filters__note muted">{t('log.export.note')}</p>
        {exportCsv.isError && (
          <p className="alert" role="alert">
            <span />
            <span>{errorMessage(exportCsv.error, t)}</span>
          </p>
        )}
      </form>
    </FilterPanel>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
  current,
  optionLang,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  /** The applied value, kept selectable even if it is not among the facets. */
  current?: string | undefined;
  /** Server-provided labels are English. */
  optionLang?: string;
}) {
  const { t } = useI18n();
  const all =
    current && !options.some((o) => o.value === current)
      ? [{ value: current, label: current }, ...options]
      : options;
  return (
    <div className="field field--compact">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="field__control">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('log.any')}</option>
          {all.map((o) => (
            <option key={o.value} value={o.value} lang={optionLang}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function LogRow({ a, onFilter }: { a: Activity; onFilter: (f: ActivityFilter) => void }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const label = f.activity(a.action, a.label);
  const actor =
    a.actor.displayName ??
    (a.actor.id
      ? `${t(`actor.${a.actor.type}`)} ${shortCode('M', a.actor.id)}`
      : t(`actor.${a.actor.type}`));
  const target = a.target?.type
    ? `${a.target.type.toLowerCase()}${a.target.id ? ` #${a.target.id.replace(/-/g, '').slice(-6).toUpperCase()}` : ''}`
    : null;

  return (
    <li>
      <span className="ledger__art code logrows__service">{f.service(a.service).slice(0, 3)}</span>
      <details className="logrows__body">
        <summary>
          <span className="ledger__title" lang={label.lang}>
            {label.text}
          </span>
          <span className="ledger__meta">
            <time dateTime={a.occurredAt}>{date(a.occurredAt)}</time> · {f.service(a.service)} ·{' '}
            {actor}
            {target && <> · {target}</>}
          </span>
        </summary>
        <dl className="logrows__facts">
          <dt>{t('log.action')}</dt>
          <dd className="code">{a.action}</dd>
          <dt>{t('log.actor')}</dt>
          <dd>
            {t(`actor.${a.actor.type}`)}
            {a.actor.id && <span className="code"> {a.actor.id}</span>}
            {a.actor.id && (
              <button
                type="button"
                className="linkbtn"
                onClick={() => onFilter({ actorId: a.actor.id ?? undefined })}
              >
                {t('log.byActor')}
              </button>
            )}
          </dd>
          {a.target && (
            <>
              <dt>{t('log.target')}</dt>
              <dd>
                <span className="code">
                  {a.target.type} {a.target.id}
                </span>
                {a.target.type && a.target.id && (
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() =>
                      onFilter({
                        targetType: a.target?.type ?? undefined,
                        targetId: a.target?.id ?? undefined,
                      })
                    }
                  >
                    {t('log.byTarget')}
                  </button>
                )}
              </dd>
            </>
          )}
          {a.requestId && (
            <>
              <dt>{t('log.request')}</dt>
              <dd className="code">{a.requestId}</dd>
            </>
          )}
          {a.ipHash && (
            <>
              <dt>{t('log.ip')}</dt>
              <dd className="code">{a.ipHash.slice(0, 16)}…</dd>
            </>
          )}
          {Object.keys(a.metadata).length > 0 && (
            <>
              <dt>{t('log.metadata')}</dt>
              <dd>
                <pre className="logrows__meta">{JSON.stringify(a.metadata, null, 2)}</pre>
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}
