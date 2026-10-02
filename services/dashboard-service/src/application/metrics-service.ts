import { AppError, Errors, type RequestContext } from '@dorkar/kernel';
import {
  addDays,
  compare,
  daysInRange,
  dhakaDay,
  periodWindow,
  zeroFill,
  type Change,
  type Interval,
  type IsoDay,
  type PeriodWindow,
  type SeriesPoint,
} from '../domain/calendar';
import { Metrics, type Metric } from '../domain/metrics';
import type { DashboardReader, Funnel, Gauges, Money, PersonalCounts, SummaryCache } from './ports';

export const SUMMARY_PERIODS = [1, 7, 30] as const;
export const MAX_SERIES_DAYS = 366;

export interface Summary {
  generatedAt: string;
  today: IsoDay;
  gauges: Gauges;
  periods: Array<PeriodWindow & { metrics: Array<Change & { metric: Metric }> }>;
}

export interface Series {
  metric: Metric;
  dimension: string;
  interval: Interval;
  from: IsoDay;
  to: IsoDay;
  total: number;
  points: SeriesPoint[];
}

export interface FunnelReport {
  from: IsoDay;
  to: IsoDay;
  steps: Array<{ step: keyof Funnel; count: number; conversionPct: number | null }>;
}

const bdt = (amount: number): Money => ({ amount, currency: 'BDT' });

/** Admin platform metrics: summary (cached), time series and the demand funnel. */
export class MetricsService {
  constructor(
    private readonly reader: DashboardReader,
    private readonly cache: SummaryCache<Summary>,
    private readonly opts: { cacheSeconds: number; now: () => Date },
  ) {}

  async summary(): Promise<Summary> {
    const cached = await this.cache.get();
    if (cached) return cached;
    const now = this.opts.now();
    const today = dhakaDay(now);
    const windows = SUMMARY_PERIODS.map((d) => periodWindow(today, d));
    const [gauges, ...totals] = await Promise.all([
      this.reader.gauges(),
      ...windows.flatMap((w) => [
        this.reader.totals(w.from, w.to),
        this.reader.totals(w.previousFrom, w.previousTo),
      ]),
    ]);
    const summary: Summary = {
      generatedAt: now.toISOString(),
      today,
      gauges: gauges,
      periods: windows.map((w, i) => {
        const cur = totals[2 * i] as Partial<Record<Metric, number>>;
        const prev = totals[2 * i + 1] as Partial<Record<Metric, number>>;
        return {
          ...w,
          metrics: Metrics.map((metric) => ({
            metric,
            ...compare(cur[metric] ?? 0, prev[metric] ?? 0),
          })),
        };
      }),
    };
    if (this.opts.cacheSeconds > 0) await this.cache.set(summary, this.opts.cacheSeconds);
    return summary;
  }

  async timeseries(q: {
    metric: Metric;
    dimension: string;
    from: IsoDay;
    to: IsoDay;
    interval: Interval;
  }): Promise<Series> {
    assertRange(q.from, q.to);
    const rows = await this.reader.daily(q.metric, q.dimension, q.from, q.to);
    const points = zeroFill(rows, q.from, q.to, q.interval);
    return { ...q, total: points.reduce((a, p) => a + p.value, 0), points };
  }

  async funnel(from: IsoDay, to: IsoDay): Promise<FunnelReport> {
    assertRange(from, to);
    const f = await this.reader.funnel(from, to);
    const order: Array<keyof Funnel> = [
      'needsPublished',
      'needsWithOffer',
      'offersAccepted',
      'transactionsCompleted',
    ];
    return {
      from,
      to,
      steps: order.map((step, i) => {
        const prev = i === 0 ? null : f[order[i - 1]!];
        return {
          step,
          count: f[step],
          conversionPct:
            prev === null || prev === 0 ? null : Math.round((f[step] / prev) * 1000) / 10,
        };
      }),
    };
  }

  /** Default range for range-less queries: the last 30 Dhaka days. */
  defaultRange(): { from: IsoDay; to: IsoDay } {
    const to = dhakaDay(this.opts.now());
    return { from: addDays(to, -29), to };
  }
}

function assertRange(from: IsoDay, to: IsoDay) {
  if (from > to) throw Errors.validation('`from` must not be after `to`.');
  if (daysInRange(from, to) > MAX_SERIES_DAYS) {
    throw new AppError('VALIDATION_FAILED', `A range covers at most ${MAX_SERIES_DAYS} days.`, {
      maxDays: MAX_SERIES_DAYS,
    });
  }
}

export interface PersonalDashboard {
  buyer: {
    openNeeds: number;
    offersAwaitingResponse: number;
    transactionsByState: Record<string, number>;
    totalSpent: Money;
  };
  seller: {
    offersByStatus: Record<string, number>;
    transactionsByState: Record<string, number>;
    earnings: Money;
    rating: PersonalCounts['rating'];
  };
  auctions: PersonalCounts['auctions'];
  bookings: PersonalCounts['bookings'];
  loans: PersonalCounts['loans'];
  disputes: PersonalCounts['disputes'];
}

/** The member's own dashboard, from per-account projections. */
export class PersonalDashboardService {
  constructor(private readonly reader: DashboardReader) {}

  async get(ctx: RequestContext): Promise<PersonalDashboard> {
    if (!ctx.actor) throw Errors.unauthenticated();
    const c = await this.reader.personal(ctx.actor.id, 10);
    return {
      buyer: {
        openNeeds: c.openNeeds,
        offersAwaitingResponse: c.offersAwaitingResponse,
        transactionsByState: c.buyerTransactions,
        totalSpent: bdt(c.totalSpent),
      },
      seller: {
        offersByStatus: c.offersSentByStatus,
        transactionsByState: c.sellerTransactions,
        earnings: bdt(c.earnings),
        rating: c.rating,
      },
      auctions: c.auctions,
      bookings: c.bookings,
      loans: c.loans,
      disputes: c.disputes,
    };
  }
}
