import { dashboardApi, type PersonalDashboard } from '@web/features/dashboard/api';
import { shortCode, useFormat } from '@web/features/dashboard/format';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentType, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { TabSignedIn, useTabTop } from '../features/account/TabPage';
import { goTo, type NavTarget } from '../features/notifications/links';
import { c, r, space } from '../design/tokens';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { Button, LinkText } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { GavelIcon, HandIcon, KeyIcon, ShieldIcon, type IconProps } from '../ui/icons';
import { Card, Divider, LoadError, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Fact, Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

/** Deal states that are finished: everything else is "in progress". */
const FINAL = new Set(['COMPLETED', 'CANCELLED', 'REFUNDED', 'EXPIRED']);
const inProgress = (byState: Record<string, number>) =>
  Object.entries(byState).reduce((n, [s, count]) => (FINAL.has(s) ? n : n + count), 0);

/** Every place the dashboard points to, for the shortcuts at the foot of the page. */
const SHORTCUTS: Array<[NavTarget, MessageKey]> = [
  [{ name: 'MyNeeds' }, 'myNeeds.title'],
  [{ name: 'MyOffers' }, 'myOffers.title'],
  [{ name: 'MyListings' }, 'myListings.title'],
  [{ name: 'Deals' }, 'nav.deals'],
  [{ name: 'MyAuctions' }, 'dash.auctions'],
  [{ name: 'Bookings' }, 'dash.bookings'],
  [{ name: 'Loans' }, 'dash.loans'],
  [{ name: 'Disputes' }, 'dash.disputes'],
];

export default function DashboardScreen() {
  return (
    <TabSignedIn>
      <Dashboard />
    </TabSignedIn>
  );
}

function Dashboard() {
  const { t } = useI18n();
  const nav = useNav();
  const top = useTabTop();
  const dash = useQuery({ queryKey: ['me', 'dashboard'], queryFn: dashboardApi.personal });
  const qc = useQueryClient();

  return (
    <Screen
      bottomInset={false}
      contentStyle={{ paddingTop: top }}
      refreshing={dash.isRefetching}
      onRefresh={() => {
        void qc.invalidateQueries({ queryKey: ['me', 'dashboard'] });
        void qc.invalidateQueries({ queryKey: ['me', 'activity'] });
      }}
    >
      <Stack gap={6}>
        <PageTitle>{t('dash.title')}</PageTitle>
        <T color={c.inkSoft}>{t('dash.lede')}</T>
      </Stack>
      {dash.isPending ? <Skeleton rows={4} /> : null}
      {dash.isError ? <LoadError onRetry={() => void dash.refetch()} /> : null}
      {dash.data ? <Overview d={dash.data} /> : null}
      <MyActivity />
      <Section title={t('dash.shortcuts')}>
        <Row>
          {SHORTCUTS.map(([to, label]) => (
            <Button
              key={to.name}
              kind="outline"
              small
              label={t(label)}
              onPress={() => goTo(nav, to)}
            />
          ))}
        </Row>
      </Section>
    </Screen>
  );
}

function Overview({ d }: { d: PersonalDashboard }) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const live = inProgress(d.buyer.transactionsByState) + inProgress(d.seller.transactionsByState);

  return (
    <>
      {/* The four figures that matter, each a way into the page that acts on it. */}
      <View style={styles.figures}>
        <Figure
          to={{ name: 'MyNeeds' }}
          label={t('dash.figure.waiting')}
          hot={d.buyer.offersAwaitingResponse > 0}
        >
          {num(d.buyer.offersAwaitingResponse)}
        </Figure>
        <Figure to={{ name: 'MyNeeds' }} label={t('dash.figure.openNeeds')}>
          {num(d.buyer.openNeeds)}
        </Figure>
        <Figure to={{ name: 'Deals' }} label={t('dash.figure.live')}>
          {num(live)}
        </Figure>
        <Figure to={{ name: 'Deals' }} label={t('dash.figure.earned')}>
          {f.taka(d.seller.earnings)}
        </Figure>
      </View>

      <Section
        title={t('dash.buyer')}
        right={<LinkText label={t('myNeeds.title')} onPress={() => nav.navigate('MyNeeds')} />}
      >
        <Card>
          <Fact label={t('dash.spent')}>{f.taka(d.buyer.totalSpent)}</Fact>
          <Breakdown groups={[[t('dash.deals'), d.buyer.transactionsByState]]} />
        </Card>
      </Section>

      <Section title={t('dash.seller')}>
        <Row style={styles.links}>
          <LinkText label={t('myOffers.title')} onPress={() => nav.navigate('MyOffers')} />
          <LinkText label={t('myListings.title')} onPress={() => nav.navigate('MyListings')} />
        </Row>
        <Card>
          <Fact label={t('dash.rating')}>
            <T v="bodyStrong" align="right">
              {d.seller.rating && d.seller.rating.average !== null
                ? t('dash.rating.value', {
                    avg: num(Math.round(d.seller.rating.average * 10) / 10),
                    n: d.seller.rating.count,
                  })
                : t('dash.rating.none')}
            </T>
            {d.seller.rating && d.seller.rating.completedCount > 0 ? (
              <T v="small" color={c.inkSoft} align="right">
                {t('dash.completed', { n: d.seller.rating.completedCount })}
              </T>
            ) : null}
          </Fact>
          <Breakdown
            groups={[
              [t('dash.offers'), d.seller.offersByStatus],
              [t('dash.deals'), d.seller.transactionsByState],
            ]}
          />
        </Card>
      </Section>

      {d.auctions.owned > 0 || d.auctions.bidding > 0 || d.auctions.live.length > 0 ? (
        <Ledger
          title={t('dash.auctions')}
          note={t('dash.auctions.note', { owned: d.auctions.owned, bidding: d.auctions.bidding })}
          more={{ name: 'MyAuctions' }}
          icon={GavelIcon}
          rows={d.auctions.live.map((a) => ({
            key: a.auctionId,
            to: { name: 'Auction', params: { id: a.auctionId } },
            title: t('dash.auction', { code: shortCode('A', a.auctionId) }),
            meta: [t(`dash.role.${a.role}`), a.endsAt && t('dash.ends', { when: date(a.endsAt) })],
          }))}
        />
      ) : null}

      {d.bookings.asOwner > 0 || d.bookings.asRenter > 0 || d.bookings.items.length > 0 ? (
        <Ledger
          title={t('dash.bookings')}
          note={t('dash.bookings.note', { renter: d.bookings.asRenter, owner: d.bookings.asOwner })}
          more={{ name: 'Bookings' }}
          icon={KeyIcon}
          rows={d.bookings.items.map((b) => ({
            key: b.bookingId,
            to: { name: 'Booking', params: { id: b.bookingId } },
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
      ) : null}

      {d.loans.asLender > 0 || d.loans.asBorrower > 0 || d.loans.items.length > 0 ? (
        <Ledger
          title={t('dash.loans')}
          note={t('dash.loans.note', { lender: d.loans.asLender, borrower: d.loans.asBorrower })}
          more={{ name: 'Loans' }}
          icon={HandIcon}
          rows={d.loans.items.map((l) => ({
            key: l.loanId,
            to: { name: 'Loan', params: { id: l.loanId } },
            title: t('dash.loan', { code: shortCode('L', l.loanId) }),
            meta: [
              t(`dash.role.${l.role}`),
              f.state(l.status),
              l.returnBy && t('dash.returnBy', { when: date(l.returnBy, 'short') }),
            ],
          }))}
        />
      ) : null}

      {d.disputes.open > 0 || d.disputes.items.length > 0 ? (
        <Ledger
          title={t('dash.disputes')}
          note={t('dash.disputes.note', { n: d.disputes.open })}
          more={{ name: 'Disputes' }}
          icon={ShieldIcon}
          rows={d.disputes.items.map((x) => ({
            key: x.disputeId,
            to: { name: 'Dispute', params: { id: x.disputeId } },
            title: t('dash.dispute', { code: shortCode('T', x.transactionId) }),
            meta: [t(`dash.role.${x.role}`), f.state(x.status)],
          }))}
        />
      ) : null}
    </>
  );
}

/** A figure whose whole face goes to the page behind it. The one that asks for action stands out. */
function Figure({
  to,
  label,
  hot,
  children,
}: {
  to: NavTarget;
  label: string;
  hot?: boolean;
  children: ReactNode;
}) {
  const nav = useNav();
  return (
    <Pressable accessibilityRole="link" style={styles.figure} onPress={() => goTo(nav, to)}>
      <Card style={hot ? styles.figureHot : styles.figureCard}>
        <T v="small" color={hot ? c.onHot : c.inkSoft}>
          {label}
        </T>
        <T v="price" color={hot ? c.onHot : c.ink}>
          {children}
        </T>
      </Card>
    </Pressable>
  );
}

/** Per-status counts, folded away: the totals above answer most visits. Hidden when empty. */
function Breakdown({ groups }: { groups: Array<[string, Record<string, number>]> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!groups.some(([, counts]) => Object.values(counts).some((n) => n > 0))) return null;
  return (
    <Stack>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.fold}
        onPress={() => setOpen((v) => !v)}
      >
        <T v="bodyStrong" color={c.accent}>
          {t('dash.byStatus')} {open ? '−' : '+'}
        </T>
      </Pressable>
      {open
        ? groups.map(([title, counts]) => <Counts key={title} title={title} counts={counts} />)
        : null}
    </Stack>
  );
}

/** A small list of "state: count", hidden when empty. */
function Counts({ title, counts }: { title: string; counts: Record<string, number> }) {
  const { num } = useI18n();
  const f = useFormat();
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <Stack gap={6}>
      <T v="label" color={c.inkSoft}>
        {title}
      </T>
      {entries.map(([s, n]) => (
        <Fact key={s} label={f.state(s)}>
          {num(n)}
        </Fact>
      ))}
    </Stack>
  );
}

function Ledger({
  title,
  note,
  more,
  icon: Icon,
  rows,
}: {
  title: string;
  note: string;
  more: NavTarget;
  icon: ComponentType<IconProps>;
  rows: Array<{ key: string; to: NavTarget; title: string; meta: Array<string | null | false> }>;
}) {
  const { t } = useI18n();
  const nav = useNav();
  return (
    <Section title={title}>
      <T v="small" color={c.inkSoft}>
        {note}
      </T>
      <LinkText label={t('dash.seeAll')} onPress={() => goTo(nav, more)} />
      {rows.length === 0 ? (
        <T color={c.inkSoft}>{t('dash.none')}</T>
      ) : (
        <Card>
          {rows.map((row, i) => (
            <Stack key={row.key}>
              {i > 0 ? <Divider /> : null}
              <Pressable
                accessibilityRole="link"
                style={styles.ledgerRow}
                onPress={() => goTo(nav, row.to)}
              >
                <View style={styles.tile}>
                  <Icon size={22} color={c.ink} />
                </View>
                <View style={styles.grow}>
                  <T v="bodyStrong">{row.title}</T>
                  <T v="small" color={c.inkSoft}>
                    {row.meta.filter(Boolean).join(' · ')}
                  </T>
                </View>
              </Pressable>
            </Stack>
          ))}
        </Card>
      )}
    </Section>
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
    <Section title={t('dash.activity')}>
      <Chips
        label={t('dash.activity.scope')}
        value={scope}
        onChange={(v) => setScope(v as 'mine' | 'about-me')}
        options={[
          { value: 'mine', label: t('dash.activity.mine') },
          { value: 'about-me', label: t('dash.activity.about') },
        ]}
      />
      {log.isPending ? <Skeleton rows={3} /> : null}
      {log.isError ? <LoadError onRetry={() => void log.refetch()} /> : null}
      {log.data && rows.length === 0 ? <T color={c.inkSoft}>{t('dash.activity.empty')}</T> : null}
      {rows.map((a) => (
        <Stack key={a.id} gap={2}>
          <T v="code" color={c.inkSoft}>
            {date(a.occurredAt)}
          </T>
          <T>{f.activity(a.action, a.label).text}</T>
          <T v="small" color={c.inkSoft}>
            {f.service(a.service)}
            {a.actor ? ` · ${t('actor.team')}` : ''}
          </T>
        </Stack>
      ))}
      {log.hasNextPage ? (
        <Button
          kind="outline"
          small
          block
          busy={log.isFetchingNextPage}
          label={log.isFetchingNextPage ? t('loading') : t('dash.more')}
          onPress={() => void log.fetchNextPage()}
        />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  figures: { flexDirection: 'row', flexWrap: 'wrap', gap: space.gap },
  figure: { flexGrow: 1, flexBasis: '45%' },
  figureCard: { flexGrow: 1, gap: 4 },
  figureHot: { flexGrow: 1, gap: 4, backgroundColor: c.hot },
  links: { gap: 16 },
  fold: { minHeight: 44, justifyContent: 'center' },
  ledgerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  tile: {
    width: 44,
    height: 44,
    borderRadius: r.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.paperShade,
  },
  grow: { flex: 1 },
});
