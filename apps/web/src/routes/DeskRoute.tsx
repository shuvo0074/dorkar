import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LedgerSkeleton, LoadError, SignedInOnly, StaffOnly } from '../components/ui/Status';
import { useCan } from '../features/auth/permissions';
import { DeskToolLinks, useIsStaff } from '../features/desk/tools';
import {
  dashboardApi,
  Metrics,
  type Metric,
  type MetricChange,
  type Summary,
} from '../features/dashboard/api';
import { addDays, dhakaDay, useFormat } from '../features/dashboard/format';
import { InkChart } from '../features/dashboard/InkChart';
import { useI18n } from '../lib/i18n';

/** The figures shown in the period table, in reading order (the funnel first). */
const FIGURES: Metric[] = [
  'signups',
  'needs_published',
  'offers_submitted',
  'offers_accepted',
  'transactions_created',
  'transactions_completed',
  'gmv_completed',
  'transactions_cancelled',
  'disputes_opened',
  'auctions_opened',
  'bids_placed',
  'bookings_confirmed',
  'loans_approved',
  'messages_sent',
  'reviews_created',
];
const PERIODS = [1, 7, 30] as const;

export default function DeskRoute() {
  return (
    <SignedInOnly from="/desk">
      <Desk />
    </SignedInOnly>
  );
}

function Desk() {
  const { t, date } = useI18n();
  const can = useCan();
  const isStaff = useIsStaff();
  const summary = useQuery({
    queryKey: ['me', 'desk', 'summary'],
    queryFn: dashboardApi.summary,
    enabled: can('dashboard:read'),
    refetchInterval: 60_000,
  });
  if (!can('dashboard:read'))
    return isStaff ? (
      <div className="desk">
        <header className="desk__head">
          <h1 tabIndex={-1}>{t('desk.title')}</h1>
          <DeskToolLinks />
        </header>
      </div>
    ) : (
      <StaffOnly />
    );

  return (
    <div className="desk">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('desk.title')}</h1>
        <p className="desk__lede">{t('desk.lede')}</p>
        <div className="desk__meta">
          {summary.data && (
            <span className="muted">
              {t('desk.updated', { when: date(summary.data.generatedAt) })}
            </span>
          )}
          <button
            type="button"
            className="linkbtn"
            disabled={summary.isFetching}
            onClick={() => void summary.refetch()}
          >
            {t('desk.refresh')}
          </button>
        </div>
        <DeskToolLinks />
      </header>

      {summary.isPending && <LedgerSkeleton rows={4} />}
      {summary.isError && <LoadError onRetry={() => void summary.refetch()} />}
      {summary.data && (
        <>
          <Figures summary={summary.data} />
          <Gauges summary={summary.data} />
        </>
      )}
      <FunnelSection />
      <OverTime />
    </div>
  );
}

function Figures({ summary }: { summary: Summary }) {
  const { t } = useI18n();
  const f = useFormat();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const period = summary.periods.find((p) => p.days === days) ?? summary.periods[0];
  if (!period) return null;
  const byMetric = new Map(period.metrics.map((m) => [m.metric, m]));

  return (
    <section className="desk__figures" aria-labelledby="figures-title">
      <div className="section-head">
        <h2 id="figures-title">{t('desk.figures')}</h2>
        <p>
          {t('desk.figures.note', {
            from: f.day(period.previousFrom),
            to: f.day(period.previousTo),
          })}
        </p>
      </div>
      <fieldset className="segmented">
        <legend className="visually-hidden">{t('desk.period')}</legend>
        {PERIODS.map((d) => (
          <label key={d}>
            <input
              type="radio"
              name="desk-period"
              value={d}
              checked={days === d}
              onChange={() => setDays(d)}
            />
            <span>{t(`desk.period.${d}`)}</span>
          </label>
        ))}
      </fieldset>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{t('desk.col.metric')}</th>
            <th scope="col">{t('desk.col.now')}</th>
            <th scope="col">{t('desk.col.before')}</th>
            <th scope="col">{t('desk.col.change')}</th>
          </tr>
        </thead>
        <tbody>
          {FIGURES.map((metric) => {
            const m = byMetric.get(metric);
            if (!m) return null;
            return (
              <tr key={metric}>
                <th scope="row">{t(`metric.${metric}`)}</th>
                <td className="code">{f.metric(metric, m.current)}</td>
                <td className="code muted">{f.metric(metric, m.previous)}</td>
                <td>
                  <Change m={m} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Up/down in ink weight and sign only (no colour coding, per the three-inks rule). */
function Change({ m }: { m: MetricChange }) {
  const { t, num } = useI18n();
  if (m.change === 0) return <span className="change muted">{t('desk.change.same')}</span>;
  if (m.changePct === null)
    return <span className="change change--up">{t('desk.change.new')}</span>;
  const up = m.change > 0;
  return (
    <span className={up ? 'change change--up' : 'change'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : '−'}
      {num(Math.abs(Math.round(m.changePct)))}%
    </span>
  );
}

function Gauges({ summary }: { summary: Summary }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const g = summary.gauges;
  const cells: Array<[string, number]> = [
    [t('gauge.openNeeds'), g.needsByStatus['OPEN'] ?? 0],
    [t('gauge.activeListings'), g.activeListings],
    [t('gauge.liveAuctions'), g.liveAuctions],
    [t('gauge.upcomingBookings'), g.upcomingBookings],
    [t('gauge.activeBookings'), g.activeBookings],
    [t('gauge.activeLoans'), g.activeLoans],
    [t('gauge.openDisputes'), g.openDisputes],
    [t('gauge.pendingVerifications'), g.pendingVerifications],
  ];
  const states = g.transactionsByState.filter((s) => s.count > 0);

  return (
    <section className="desk__now" aria-labelledby="now-title">
      <div className="section-head">
        <h2 id="now-title">{t('desk.now')}</h2>
      </div>
      <dl className="tally">
        {cells.map(([label, value]) => (
          <div key={label} className="tally__cell">
            <dt>{label}</dt>
            <dd>{num(value)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="desk__sub">{t('desk.byState')}</h3>
      {states.length === 0 ? (
        <p className="muted">{t('dash.none')}</p>
      ) : (
        <ul className="statelist">
          {states.map((s) => (
            <li key={s.state}>
              <span>{f.state(s.state)}</span>
              <span className="code">
                {t('desk.byState.value', { n: s.count, amount: f.taka(s.amount) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OverTime() {
  const { t } = useI18n();
  const f = useFormat();
  const [metric, setMetric] = useState<Metric>('transactions_completed');
  const [interval, setIntervalChoice] = useState<'day' | 'week'>('day');
  const to = dhakaDay();
  const from = addDays(to, interval === 'day' ? -29 : -83);
  const series = useQuery({
    queryKey: ['me', 'desk', 'series', metric, interval, from, to],
    queryFn: () => dashboardApi.series(metric, interval, from, to),
  });

  return (
    <section className="desk__chart" aria-labelledby="chart-title">
      <div className="section-head">
        <h2 id="chart-title">{t('desk.chart')}</h2>
      </div>
      <div className="desk__controls">
        <div className="field field--compact">
          <label className="label" htmlFor="chart-metric">
            {t('desk.chart.metric')}
          </label>
          <div className="field__control">
            <select
              id="chart-metric"
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
            >
              {Metrics.map((m) => (
                <option key={m} value={m}>
                  {t(`metric.${m}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="segmented">
          <legend className="label">{t('desk.chart.interval')}</legend>
          {(['day', 'week'] as const).map((i) => (
            <label key={i}>
              <input
                type="radio"
                name="chart-interval"
                value={i}
                checked={interval === i}
                onChange={() => setIntervalChoice(i)}
              />
              <span>{t(`desk.chart.${i}`)}</span>
            </label>
          ))}
        </fieldset>
      </div>
      {series.isPending && <LedgerSkeleton rows={3} />}
      {series.isError && <LoadError onRetry={() => void series.refetch()} />}
      {series.data && (
        <InkChart
          series={series.data}
          caption={t('desk.chart.range', {
            metric: t(`metric.${metric}`),
            from: f.day(series.data.from),
            to: f.day(series.data.to),
          })}
        />
      )}
    </section>
  );
}

function FunnelSection() {
  const { t, num } = useI18n();
  const to = dhakaDay();
  const from = addDays(to, -29);
  const funnel = useQuery({
    queryKey: ['me', 'desk', 'funnel', from, to],
    queryFn: () => dashboardApi.funnel(from, to),
  });
  const first = funnel.data?.steps[0]?.count ?? 0;

  return (
    <section className="desk__funnel" aria-labelledby="funnel-title">
      <div className="section-head">
        <h2 id="funnel-title">{t('desk.funnel')}</h2>
        <p>{t('desk.funnel.note')}</p>
      </div>
      {funnel.isPending && <LedgerSkeleton rows={4} />}
      {funnel.isError && <LoadError onRetry={() => void funnel.refetch()} />}
      {funnel.data && (
        <ol className="funnel">
          {funnel.data.steps.map((s, i) => (
            <li key={s.step}>
              <span className="funnel__step">{num(i + 1)}</span>
              <div className="funnel__body">
                <div className="funnel__line">
                  <span className="funnel__label">{t(`funnel.${s.step}`)}</span>
                  <span className="code">{num(s.count)}</span>
                </div>
                <div className="funnel__track" aria-hidden="true">
                  <div className="funnel__bar" style={{ width: `${barWidth(s.count, first)}%` }} />
                </div>
                {i > 0 && s.conversionPct !== null && (
                  <p className="funnel__conv">
                    {s.conversionPct > 100
                      ? t('desk.funnel.beyond')
                      : t('desk.funnel.conv', { pct: Math.round(s.conversionPct) })}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Bar length relative to the first step, capped at the full track: later steps can exceed it
 * (completed deals also count direct purchases, rentals and loans that never had a need).
 */
function barWidth(count: number, first: number): number {
  if (first <= 0) return count > 0 ? 100 : 0;
  return Math.min(100, Math.max((count / first) * 100, count > 0 ? 1 : 0));
}
