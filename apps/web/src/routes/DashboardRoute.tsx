import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CrateGlyph, GavelGlyph, KeyGlyph, ScalesGlyph } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useCan } from '../features/auth/permissions';
import { dashboardApi, type PersonalDashboard } from '../features/dashboard/api';
import { shortCode, useFormat } from '../features/dashboard/format';
import { useI18n } from '../lib/i18n';

/** Deal states that are finished: everything else is "in progress". */
const FINAL = new Set(['COMPLETED', 'CANCELLED', 'REFUNDED', 'EXPIRED']);
const inProgress = (byState: Record<string, number>) =>
  Object.entries(byState).reduce((n, [s, c]) => (FINAL.has(s) ? n : n + c), 0);

export default function DashboardRoute() {
  return (
    <SignedInOnly from="/dashboard">
      <Dashboard />
    </SignedInOnly>
  );
}

function Dashboard() {
  const { t } = useI18n();
  const can = useCan();
  const dash = useQuery({ queryKey: ['me', 'dashboard'], queryFn: dashboardApi.personal });

  return (
    <div className="dash">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('dash.title')}</h1>
        <p className="desk__lede">{t('dash.lede')}</p>
        {can('dashboard:read') && (
          <div className="desk__meta">
            <Link className="btn btn--outline btn--small" to="/desk">
              {t('dash.staffLink')}
            </Link>
          </div>
        )}
      </header>

      {dash.isPending && <LedgerSkeleton rows={4} />}
      {dash.isError && <LoadError onRetry={() => void dash.refetch()} />}
      {dash.data && <Overview d={dash.data} />}
      <MyActivity />
    </div>
  );
}

function Overview({ d }: { d: PersonalDashboard }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const live = inProgress(d.buyer.transactionsByState) + inProgress(d.seller.transactionsByState);

  return (
    <>
      <dl className="tally tally--big" aria-label={t('dash.title')}>
        <div className="tally__cell">
          <dt>{t('dash.figure.openNeeds')}</dt>
          <dd>{num(d.buyer.openNeeds)}</dd>
        </div>
        <div className="tally__cell">
          <dt>{t('dash.figure.waiting')}</dt>
          <dd>
            {/* The one figure that asks for action gets the pen. */}
            {d.buyer.offersAwaitingResponse > 0 ? (
              <span className="tally__mark">
                {num(d.buyer.offersAwaitingResponse)}
                <Biro draw tilt={-5} />
              </span>
            ) : (
              num(0)
            )}
          </dd>
        </div>
        <div className="tally__cell">
          <dt>{t('dash.figure.live')}</dt>
          <dd>{num(live)}</dd>
        </div>
        <div className="tally__cell">
          <dt>{t('dash.figure.earned')}</dt>
          <dd>{f.taka(d.seller.earnings)}</dd>
        </div>
      </dl>

      <section aria-labelledby="buyer-title">
        <div className="section-head">
          <h2 id="buyer-title">{t('dash.buyer')}</h2>
        </div>
        <dl className="facts">
          <dt>{t('dash.figure.openNeeds')}</dt>
          <dd>{num(d.buyer.openNeeds)}</dd>
          <dt>{t('dash.figure.waiting')}</dt>
          <dd>{num(d.buyer.offersAwaitingResponse)}</dd>
          <dt>{t('dash.spent')}</dt>
          <dd>{f.taka(d.buyer.totalSpent)}</dd>
        </dl>
        <Counts title={t('dash.deals')} counts={d.buyer.transactionsByState} />
      </section>

      <section aria-labelledby="seller-title">
        <div className="section-head">
          <h2 id="seller-title">{t('dash.seller')}</h2>
        </div>
        <dl className="facts">
          <dt>{t('dash.earnings')}</dt>
          <dd>{f.taka(d.seller.earnings)}</dd>
          <dt>{t('dash.rating')}</dt>
          <dd>
            {d.seller.rating && d.seller.rating.average !== null
              ? t('dash.rating.value', {
                  avg: num(Math.round(d.seller.rating.average * 10) / 10),
                  n: d.seller.rating.count,
                })
              : t('dash.rating.none')}
            {d.seller.rating && d.seller.rating.completedCount > 0 && (
              <span className="facts__aside">
                {t('dash.completed', { n: d.seller.rating.completedCount })}
              </span>
            )}
          </dd>
        </dl>
        <Counts title={t('dash.offers')} counts={d.seller.offersByStatus} />
        <Counts title={t('dash.deals')} counts={d.seller.transactionsByState} />
      </section>

      {(d.auctions.owned > 0 || d.auctions.bidding > 0 || d.auctions.live.length > 0) && (
        <Ledger
          id="auctions"
          title={t('dash.auctions')}
          note={t('dash.auctions.note', { owned: d.auctions.owned, bidding: d.auctions.bidding })}
          rows={d.auctions.live.map((a) => ({
            key: a.auctionId,
            art: <GavelGlyph />,
            title: t('dash.auction', { code: shortCode('A', a.auctionId) }),
            meta: [t(`dash.role.${a.role}`), a.endsAt && t('dash.ends', { when: date(a.endsAt) })],
          }))}
        />
      )}

      {(d.bookings.asOwner > 0 || d.bookings.asRenter > 0 || d.bookings.items.length > 0) && (
        <Ledger
          id="bookings"
          title={t('dash.bookings')}
          note={t('dash.bookings.note', { renter: d.bookings.asRenter, owner: d.bookings.asOwner })}
          rows={d.bookings.items.map((b) => ({
            key: b.bookingId,
            art: <KeyGlyph />,
            title: t('dash.booking', { code: shortCode('R', b.bookingId) }),
            meta: [
              t(`dash.role.${b.role}`),
              f.state(b.status),
              b.startAt &&
                b.endAt &&
                t('dash.period', { from: date(b.startAt, 'short'), to: date(b.endAt, 'short') }),
            ],
          }))}
        />
      )}

      {(d.loans.asLender > 0 || d.loans.asBorrower > 0 || d.loans.items.length > 0) && (
        <Ledger
          id="loans"
          title={t('dash.loans')}
          note={t('dash.loans.note', { lender: d.loans.asLender, borrower: d.loans.asBorrower })}
          rows={d.loans.items.map((l) => ({
            key: l.loanId,
            art: <CrateGlyph />,
            title: t('dash.loan', { code: shortCode('L', l.loanId) }),
            meta: [
              t(`dash.role.${l.role}`),
              f.state(l.status),
              l.returnBy && t('dash.returnBy', { when: date(l.returnBy, 'short') }),
            ],
          }))}
        />
      )}

      {(d.disputes.open > 0 || d.disputes.items.length > 0) && (
        <Ledger
          id="disputes"
          title={t('dash.disputes')}
          note={t('dash.disputes.note', { n: d.disputes.open })}
          rows={d.disputes.items.map((x) => ({
            key: x.disputeId,
            art: <ScalesGlyph />,
            title: t('dash.dispute', { code: shortCode('T', x.transactionId) }),
            meta: [t(`dash.role.${x.role}`), f.state(x.status)],
          }))}
        />
      )}
    </>
  );
}

/** A small ruled list of "state — count", hidden when empty. */
function Counts({ title, counts }: { title: string; counts: Record<string, number> }) {
  const { num } = useI18n();
  const f = useFormat();
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <>
      <h3 className="desk__sub">{title}</h3>
      <ul className="statelist">
        {entries.map(([s, n]) => (
          <li key={s}>
            <span>{f.state(s)}</span>
            <span className="code">{num(n)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Ledger({
  id,
  title,
  note,
  rows,
}: {
  id: string;
  title: string;
  note: string;
  rows: Array<{ key: string; art: ReactNode; title: string; meta: Array<string | null | false> }>;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{t('dash.none')}</p>
      ) : (
        <ul className="ledger">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="ledger__art">{r.art}</span>
              <div>
                <span className="ledger__title code">{r.title}</span>
                <p className="ledger__meta">{r.meta.filter(Boolean).join(' · ')}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MyActivity() {
  const { t, date } = useI18n();
  const f = useFormat();
  const [scope, setScope] = useState<'mine' | 'about-me'>('mine');
  const log = useInfiniteQuery({
    queryKey: ['me', 'activity', scope],
    queryFn: ({ pageParam }) => dashboardApi.myActivity(scope, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section className="dash__activity" aria-labelledby="activity-title">
      <div className="section-head">
        <h2 id="activity-title">{t('dash.activity')}</h2>
      </div>
      <fieldset className="segmented">
        <legend className="visually-hidden">{t('dash.activity.scope')}</legend>
        {(['mine', 'about-me'] as const).map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="activity-scope"
              value={s}
              checked={scope === s}
              onChange={() => setScope(s)}
            />
            <span>{t(s === 'mine' ? 'dash.activity.mine' : 'dash.activity.about')}</span>
          </label>
        ))}
      </fieldset>
      {log.isPending && <LedgerSkeleton rows={3} />}
      {log.isError && <LoadError onRetry={() => void log.refetch()} />}
      {log.data && rows.length === 0 && <p className="muted">{t('dash.activity.empty')}</p>}
      {rows.length > 0 && (
        <ol className="timeline">
          {rows.map((a) => {
            const label = f.activity(a.action, a.label);
            return (
              <li key={a.id}>
                <time className="code" dateTime={a.occurredAt}>
                  {date(a.occurredAt)}
                </time>
                <span lang={label.lang}>{label.text}</span>
                <span className="muted">
                  {f.service(a.service)}
                  {a.actor && <> · {t('actor.team')}</>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {log.hasNextPage && (
        <button
          type="button"
          className="btn btn--outline btn--small"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? t('loading') : t('dash.more')}
        </button>
      )}
    </section>
  );
}
