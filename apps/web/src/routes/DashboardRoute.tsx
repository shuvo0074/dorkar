import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CrateGlyph, GavelGlyph, KeyGlyph, ScalesGlyph } from '../components/glyphs/glyphs';
import { Biro } from '../components/ui/Biro';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { useIsStaff } from '../features/desk/tools';
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

/** Every place the dashboard points to, for the shortcuts at the foot of the page. */
const SHORTCUTS = [
  ['/my/needs', 'myNeeds.title'],
  ['/my/offers', 'myOffers.title'],
  ['/my/listings', 'myListings.title'],
  ['/deals', 'nav.deals'],
  ['/my/auctions', 'dash.auctions'],
  ['/bookings', 'dash.bookings'],
  ['/loans', 'dash.loans'],
  ['/disputes', 'dash.disputes'],
] as const;

function Dashboard() {
  const { t } = useI18n();
  const isStaff = useIsStaff();
  const dash = useQuery({ queryKey: ['me', 'dashboard'], queryFn: dashboardApi.personal });

  return (
    <div className="dash">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('dash.title')}</h1>
        <p className="desk__lede">{t('dash.lede')}</p>
        {isStaff && (
          <p className="desk__meta">
            <Link to="/desk">{t('dash.staffLink')}</Link>
          </p>
        )}
      </header>

      {dash.isPending && <LedgerSkeleton rows={4} />}
      {dash.isError && <LoadError onRetry={() => void dash.refetch()} />}
      {dash.data && <Overview d={dash.data} />}
      <MyActivity />

      <nav className="dash__shortcuts" aria-label={t('dash.shortcuts')}>
        <h2 className="desk__sub">{t('dash.shortcuts')}</h2>
        <ul>
          {SHORTCUTS.map(([to, label]) => (
            <li key={to}>
              <Link to={to}>{t(label)}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Overview({ d }: { d: PersonalDashboard }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const live = inProgress(d.buyer.transactionsByState) + inProgress(d.seller.transactionsByState);

  return (
    <>
      {/* The four figures that matter, each a way into the page that acts on it. */}
      <dl className="tally tally--big tally--links" aria-label={t('dash.title')}>
        <Figure to="/my/needs" label={t('dash.figure.waiting')}>
          {/* The one figure that asks for action gets the pen. */}
          {d.buyer.offersAwaitingResponse > 0 ? (
            <span className="tally__mark">
              {num(d.buyer.offersAwaitingResponse)}
              <Biro draw tilt={-5} />
            </span>
          ) : (
            num(0)
          )}
        </Figure>
        <Figure to="/my/needs" label={t('dash.figure.openNeeds')}>
          {num(d.buyer.openNeeds)}
        </Figure>
        <Figure to="/deals" label={t('dash.figure.live')}>
          {num(live)}
        </Figure>
        <Figure to="/deals" label={t('dash.figure.earned')}>
          {f.taka(d.seller.earnings)}
        </Figure>
      </dl>

      <section aria-labelledby="buyer-title">
        <SectionHead id="buyer-title" title={t('dash.buyer')}>
          <Link to="/my/needs">{t('myNeeds.title')}</Link>
        </SectionHead>
        <dl className="facts">
          <dt>{t('dash.spent')}</dt>
          <dd>{f.taka(d.buyer.totalSpent)}</dd>
        </dl>
        <Breakdown groups={[[t('dash.deals'), d.buyer.transactionsByState]]} />
      </section>

      <section aria-labelledby="seller-title">
        <SectionHead id="seller-title" title={t('dash.seller')}>
          <Link to="/my/offers">{t('myOffers.title')}</Link>
          <Link to="/my/listings">{t('myListings.title')}</Link>
        </SectionHead>
        <dl className="facts">
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
        <Breakdown
          groups={[
            [t('dash.offers'), d.seller.offersByStatus],
            [t('dash.deals'), d.seller.transactionsByState],
          ]}
        />
      </section>

      {(d.auctions.owned > 0 || d.auctions.bidding > 0 || d.auctions.live.length > 0) && (
        <Ledger
          id="auctions"
          title={t('dash.auctions')}
          note={t('dash.auctions.note', { owned: d.auctions.owned, bidding: d.auctions.bidding })}
          more="/my/auctions"
          rows={d.auctions.live.map((a) => ({
            key: a.auctionId,
            href: `/auctions/${a.auctionId}`,
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
          more="/bookings"
          rows={d.bookings.items.map((b) => ({
            key: b.bookingId,
            href: `/bookings/${b.bookingId}`,
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
          more="/loans"
          rows={d.loans.items.map((l) => ({
            key: l.loanId,
            href: `/loans/${l.loanId}`,
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
          more="/disputes"
          rows={d.disputes.items.map((x) => ({
            key: x.disputeId,
            href: `/disputes/${x.disputeId}`,
            art: <ScalesGlyph />,
            title: t('dash.dispute', { code: shortCode('T', x.transactionId) }),
            meta: [t(`dash.role.${x.role}`), f.state(x.status)],
          }))}
        />
      )}
    </>
  );
}

/** A tally cell whose whole face links to the page behind the figure. */
function Figure({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <div className="tally__cell">
      <dt>
        <Link to={to}>{label}</Link>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function SectionHead({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="section-head">
      <h2 id={id}>{title}</h2>
      <p className="section-head__links">{children}</p>
    </div>
  );
}

/** Per-status counts, folded away: the totals above answer most visits. Hidden when empty. */
function Breakdown({ groups }: { groups: Array<[string, Record<string, number>]> }) {
  const { t } = useI18n();
  if (!groups.some(([, counts]) => Object.values(counts).some((n) => n > 0))) return null;
  return (
    <details className="breakdown">
      <summary>{t('dash.byStatus')}</summary>
      {groups.map(([title, counts]) => (
        <Counts key={title} title={title} counts={counts} />
      ))}
    </details>
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
  more,
  rows,
}: {
  id: string;
  title: string;
  note: string;
  more: string;
  rows: Array<{
    key: string;
    href: string;
    art: ReactNode;
    title: string;
    meta: Array<string | null | false>;
  }>;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>
          {note} · <Link to={more}>{t('dash.seeAll')}</Link>
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{t('dash.none')}</p>
      ) : (
        <ul className="ledger">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="ledger__art">{r.art}</span>
              <div>
                <Link className="ledger__title code" to={r.href}>
                  {r.title}
                </Link>
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
