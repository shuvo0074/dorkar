import { Biro } from '../../components/ui/Biro';
import { useI18n } from '../../lib/i18n';
import type { Series } from './api';
import { useFormat } from './format';

/**
 * A printed column chart: hatched ink columns on a ruled baseline, the tallest one filled solid
 * and its figure circled in ballpoint. Columns are HTML so they stay crisp at any width; the
 * figures are also in a table for screen readers.
 */
export function InkChart({ series, caption }: { series: Series; caption: string }) {
  const { t } = useI18n();
  const f = useFormat();
  const values = series.points.map((p) => p.value);
  const max = Math.max(0, ...values);
  const peakIndex = max > 0 ? values.indexOf(max) : -1;
  const peak = peakIndex >= 0 ? series.points[peakIndex]! : null;
  const ticks = tickIndexes(series.points.length);

  return (
    <figure className="chart">
      <figcaption className="chart__caption">{caption}</figcaption>
      {max === 0 ? (
        <p className="muted chart__empty">{t('desk.chart.empty')}</p>
      ) : (
        <>
          <div className="chart__plot" aria-hidden="true">
            <span className="chart__max code">{f.metric(series.metric, max)}</span>
            <ol className="chart__cols">
              {series.points.map((p, i) => (
                <li
                  key={p.start}
                  className={i === peakIndex ? 'chart__col chart__col--peak' : 'chart__col'}
                  style={{ height: `${Math.max((p.value / max) * 100, p.value > 0 ? 2 : 0)}%` }}
                >
                  {i === peakIndex && (
                    <span className={peakClass(i, series.points.length)}>
                      {f.metric(series.metric, p.value)}
                      <Biro draw key={`${series.metric}-${series.interval}-${p.start}`} tilt={-4} />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
          <div className="chart__ticks" aria-hidden="true">
            {ticks.map((i) => (
              <span
                key={i}
                style={{ left: `${((i + 0.5) / series.points.length) * 100}%` }}
                className="code"
              >
                {f.day(series.points[i]!.start)}
              </span>
            ))}
          </div>
          {peak && (
            <p className="chart__total">
              {t('desk.chart.total', {
                total: f.metric(series.metric, series.total),
                peak: f.metric(series.metric, peak.value),
                day: f.day(peak.start),
              })}
            </p>
          )}
        </>
      )}
      <table className="visually-hidden">
        <caption>{t('desk.chart.table')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('desk.chart.date')}</th>
            <th scope="col">{t('desk.chart.value')}</th>
          </tr>
        </thead>
        <tbody>
          {series.points.map((p) => (
            <tr key={p.start}>
              <td>{f.day(p.start)}</td>
              <td>{f.metric(series.metric, p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The peak figure sits centred over its column, or flush to the plot edge near the ends. */
function peakClass(i: number, n: number): string {
  const at = (i + 0.5) / n;
  if (at > 0.88) return 'chart__peak chart__peak--end code';
  if (at < 0.12) return 'chart__peak chart__peak--start code';
  return 'chart__peak code';
}

/** First, last and up to three evenly spaced labels in between. */
function tickIndexes(n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  const step = Math.max(1, Math.round((n - 1) / 4));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  if (n - 1 - out[out.length - 1]! < step / 2) out.pop();
  out.push(n - 1);
  return out;
}
