import { useMemo } from 'react';
import { useI18n } from '../../lib/i18n';
import { BN_ACTIVITY } from './activity-labels';
import type { Metric, Money } from './api';

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

/** Locale-aware formatting for dashboard figures. */
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
    const taka = (m: Money | number) =>
      `৳${takaFmt.format((typeof m === 'number' ? m : m.amount) / 100)}`;
    return {
      taka,
      /** A metric's value: money metrics are poisha. */
      metric: (metric: Metric, n: number) => (metric === 'gmv_completed' ? taka(n) : num(n)),
      /** A Dhaka calendar day (YYYY-MM-DD) as "2 Oct". */
      day: (d: string) => dayFmt.format(new Date(`${d}T00:00:00+06:00`)),
      state: (s: string) => {
        const key = `state.${s}`;
        return has(key) ? t(key) : s.toLowerCase().replace(/_/g, ' ');
      },
      /** An activity label in the page language, or the server's English label. */
      activity: (action: string, label: string): { text: string; lang: 'bn' | 'en' } => {
        const bn = lang === 'bn' ? BN_ACTIVITY[action] : undefined;
        return bn ? { text: bn, lang: 'bn' } : { text: label, lang: 'en' };
      },
      service: (s: string) => {
        const key = `service.${s}`;
        return has(key) ? t(key) : s;
      },
    };
  }, [t, has, num, lang]);
}
