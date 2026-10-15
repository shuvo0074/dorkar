import { Districts, type District } from '@dorkar/contracts';
import { useMemo } from 'react';
import { useI18n } from './i18n';
import type { Money } from './money';

/** Catalog-style short code from a uuid: the last six hex digits, e.g. `A-3F09C2`. */
export const shortCode = (prefix: string, id: string) =>
  `${prefix}-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;

/** YYYY-MM-DD of a moment, on the Dhaka calendar (UTC+6, no DST). */
export function dhakaDay(d: Date = new Date()): string {
  return new Date(d.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface Place {
  division?: string | null | undefined;
  district: string;
  area?: string | null | undefined;
}

/** Locale-aware formatting for money, places, states and days. */
export function useFormat() {
  const { t, has, num, lang } = useI18n();
  return useMemo(() => {
    const locale = lang === 'bn' ? 'bn-BD' : 'en-GB';
    const takaFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const dayFmt = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: 'Asia/Dhaka',
    });
    const relFmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const taka = (m: Money | number) =>
      `৳${takaFmt.format((typeof m === 'number' ? m : m.amount) / 100)}`;
    const keyed = (prefix: string, v: string) => {
      const key = `${prefix}.${v}`;
      return has(key) ? t(key) : v.toLowerCase().replace(/_/g, ' ');
    };
    const district = (d: string) => Districts[d as District]?.[lang] ?? d;
    return {
      taka,
      /** A metric's value: money metrics are poisha. */
      metric: (metric: string, n: number) => (metric === 'gmv_completed' ? taka(n) : num(n)),
      /** A Dhaka calendar day (YYYY-MM-DD) as "2 Oct". */
      day: (d: string) => dayFmt.format(new Date(`${d}T00:00:00+06:00`)),
      state: (s: string) => keyed('state', s),
      condition: (c: string) => keyed('condition', c),
      delivery: (d: string) => keyed('delivery', d),
      service: (s: string) => {
        const key = `service.${s}`;
        return has(key) ? t(key) : s;
      },
      district,
      place: (p: Place | null | undefined) =>
        p ? [p.area, district(p.district)].filter(Boolean).join(', ') : t('place.anywhere'),
      /** "up to ৳80,000", "৳5,000 to ৳8,000", "from ৳500"; null when nothing is set. */
      range: (min: Money | null | undefined, max: Money | null | undefined) => {
        if (min && max) return t('money.between', { min: taka(min), max: taka(max) });
        if (max) return t('money.upTo', { amount: taka(max) });
        if (min) return t('money.from', { amount: taka(min) });
        return null;
      },
      /** "in 3 days", "2 hours ago": coarse, for deadlines and freshness. */
      relative: (iso: string, now = Date.now()) => {
        const s = (Date.parse(iso) - now) / 1000;
        const abs = Math.abs(s);
        if (abs < 60) return relFmt.format(Math.round(s), 'second');
        if (abs < 3600) return relFmt.format(Math.round(s / 60), 'minute');
        if (abs < 86_400) return relFmt.format(Math.round(s / 3600), 'hour');
        return relFmt.format(Math.round(s / 86_400), 'day');
      },
    };
  }, [t, has, num, lang]);
}
