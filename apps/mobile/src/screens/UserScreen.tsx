import { useCategories } from '@web/features/catalog/categories';
import { trustApi, type PublicProfile } from '@web/features/trust/api';
import { shortCode, useFormat } from '@web/lib/format';
import { useLayoutEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { NotFound } from '../features/account/NotFound';
import { useSession } from '../features/auth/session';
import { ReportButton } from '../features/trust/ReportButton';
import { Rating, ReviewItem } from '../features/trust/DealReviews';
import { useProfile } from '../features/trust/UserLink';
import { c, space } from '../design/tokens';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Card, Divider, LoadError, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact, MoreButton, Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function UserScreen() {
  const { id } = useParams<'User'>()!;
  const profile = useProfile(id);
  if (profile.isPending)
    return (
      <Screen>
        <Skeleton rows={5} />
      </Screen>
    );
  if (profile.error instanceof ApiError && profile.error.status === 404) return <NotFound />;
  if (profile.isError)
    return (
      <Screen>
        <LoadError onRetry={() => void profile.refetch()} />
      </Screen>
    );
  return (
    <Profile
      p={profile.data}
      refreshing={profile.isRefetching}
      onRefresh={() => void profile.refetch()}
    />
  );
}

function Profile({
  p,
  refreshing,
  onRefresh,
}: {
  p: PublicProfile;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const categories = useCategories();
  const me = useSession().account?.id;
  const rep = p.reputation;

  useLayoutEffect(() => nav.setOptions({ title: p.displayName }), [nav, p.displayName]);

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      {p.bio ? <T color={c.inkSoft}>{p.bio}</T> : null}

      <Card>
        <Fact label={t('account.member')}>{shortCode('M', p.id)}</Fact>
        <Fact label={t('account.joined')}>{date(p.memberSince, 'short')}</Fact>
        <Fact label={t('profile.type')}>
          {t(p.userType === 'BUSINESS' ? 'profile.business' : 'profile.individual')}
        </Fact>
        {p.district ? <Fact label={t('place.district')}>{f.district(p.district)}</Fact> : null}
        {p.badges.length > 0 ? (
          <Fact label={t('profile.verified')}>
            <Row style={styles.badges}>
              {p.badges.map((b) => (
                <Badge key={b} tone="good" label={t(`badge.${b}`)} />
              ))}
            </Row>
          </Fact>
        ) : null}
      </Card>

      <View style={styles.tally} accessibilityLabel={t('profile.deals')}>
        <Tally
          label={t('reviews.title')}
          value={
            rep?.ratingAverage !== null && rep?.ratingAverage !== undefined
              ? num(Math.round(rep.ratingAverage * 10) / 10)
              : '—'
          }
        />
        <Tally label={t('profile.completed')} value={num(rep?.completedCount ?? 0)} />
        <Tally label={t('profile.cancelled')} value={num(rep?.cancelledCount ?? 0)} />
        <Tally label={t('profile.disputed')} value={num(rep?.disputedCount ?? 0)} />
      </View>

      {p.seller ? (
        <Section title={t('profile.sells')}>
          <Card>
            <Fact label={t('profile.roles')}>
              {p.seller.roles.map((r) => t(`role.${r}`)).join(', ') || '—'}
            </Fact>
            <Fact label={t('profile.categories')}>
              {p.seller.categoryIds
                .map((id) => categories.name(id))
                .filter(Boolean)
                .join(', ') || '—'}
            </Fact>
            <Fact label={t('profile.areas')}>
              {p.seller.serviceDistricts.map((d) => f.district(d)).join(', ') ||
                t('profile.anywhere')}
            </Fact>
            <Fact label={t('profile.delivery')}>
              {p.seller.deliveryModes.map((d) => f.delivery(d)).join(', ') || '—'}
            </Fact>
          </Card>
        </Section>
      ) : null}

      <Reviews userId={p.id} />
      {me !== p.id ? <ReportButton targetType="USER" targetId={p.id} /> : null}
    </Screen>
  );
}

function Tally({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.cell}>
      <T v="small" color={c.inkSoft}>
        {label}
      </T>
      <T v="price">{value}</T>
    </Card>
  );
}

function Reviews({ userId }: { userId: string }) {
  const { t, num } = useI18n();
  const list = usePaged(['users', userId, 'reviews'], (cursor) =>
    trustApi.userReviews(userId, cursor),
  );
  const summary = list.data?.pages[0]?.summary;

  return (
    <Section title={t('reviews.title')}>
      {summary ? (
        summary.ratingAverage !== null ? (
          <Row>
            <Rating value={summary.ratingAverage} />
            <T v="small" color={c.inkSoft}>
              {t('profile.rating', {
                avg: num(Math.round(summary.ratingAverage * 10) / 10),
                n: summary.ratingCount,
              })}
            </T>
          </Row>
        ) : (
          <T v="small" color={c.inkSoft}>
            {t('profile.noRating')}
          </T>
        )
      ) : null}
      {list.isPending ? <Skeleton rows={3} /> : null}
      {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('reviews.empty')}</T> : null}
      {list.rows.map((r, i) => (
        <Stack key={r.id}>
          {i > 0 ? <Divider /> : null}
          <ReviewItem review={r} />
        </Stack>
      ))}
      <MoreButton query={list} label={t('reviews.more')} />
    </Section>
  );
}

const styles = StyleSheet.create({
  badges: { justifyContent: 'flex-end' },
  tally: { flexDirection: 'row', flexWrap: 'wrap', gap: space.gap },
  cell: { flexGrow: 1, flexBasis: '45%', gap: 4 },
});
