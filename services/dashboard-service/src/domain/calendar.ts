/**
 * Calendar arithmetic on Asia/Dhaka days. Bangladesh has no daylight saving time, so a fixed
 * +06:00 offset is exact. Days are ISO dates (`YYYY-MM-DD`), compared as strings.
 */
export type IsoDay = string;

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

const toMs = (day: IsoDay) => Date.parse(`${day}T00:00:00Z`);
const fromMs = (ms: number): IsoDay => new Date(ms).toISOString().slice(0, 10);

/** The Asia/Dhaka calendar day an instant falls on. */
export const dhakaDay = (at: Date | string): IsoDay =>
  fromMs(new Date(at).getTime() + DHAKA_OFFSET_MS);

/** Start of an Asia/Dhaka day as an instant. */
export const dhakaDayStart = (day: IsoDay): Date => new Date(toMs(day) - DHAKA_OFFSET_MS);

export const addDays = (day: IsoDay, n: number): IsoDay => fromMs(toMs(day) + n * DAY_MS);

/** Number of days in the inclusive range [from, to]. */
export const daysInRange = (from: IsoDay, to: IsoDay): number =>
  Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;

/** Monday of the ISO week containing `day`. */
export const weekStart = (day: IsoDay): IsoDay => {
  const dow = new Date(toMs(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
};

export type Interval = 'day' | 'week';

export interface SeriesPoint {
  /** First day of the bucket (the Monday for weekly buckets). */
  start: IsoDay;
  value: number;
}

/**
 * Buckets daily values over [from, to] with zeros for missing days. Weekly buckets are ISO
 * weeks labelled by their Monday; edge weeks only count days inside the range.
 */
export function zeroFill(
  rows: ReadonlyArray<{ day: IsoDay; value: number }>,
  from: IsoDay,
  to: IsoDay,
  interval: Interval,
): SeriesPoint[] {
  const byDay = new Map<IsoDay, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.value);
  const points: SeriesPoint[] = [];
  const index = new Map<IsoDay, SeriesPoint>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const start = interval === 'day' ? d : weekStart(d);
    let p = index.get(start);
    if (!p) {
      p = { start, value: 0 };
      index.set(start, p);
      points.push(p);
    }
    p.value += byDay.get(d) ?? 0;
  }
  return points;
}

export interface PeriodWindow {
  days: number;
  from: IsoDay;
  to: IsoDay;
  previousFrom: IsoDay;
  previousTo: IsoDay;
}

/** The last `days` days ending today (inclusive) and the same-length period just before. */
export const periodWindow = (today: IsoDay, days: number): PeriodWindow => ({
  days,
  from: addDays(today, -(days - 1)),
  to: today,
  previousFrom: addDays(today, -(2 * days - 1)),
  previousTo: addDays(today, -days),
});

export interface Change {
  current: number;
  previous: number;
  change: number;
  /** Percentage change vs the previous period; null when the previous period was zero. */
  changePct: number | null;
}

export const compare = (current: number, previous: number): Change => ({
  current,
  previous,
  change: current - previous,
  changePct: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
});
