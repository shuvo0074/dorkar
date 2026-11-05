import { needsApi } from '@web/features/needs/api';
import { needCode } from '@web/features/needs/modes';
import { liveOffer, offersApi, type OfferStatus } from '@web/features/offers/api';
import { shortCode, useFormat } from '@web/lib/format';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { LedgerRow, ModeTile, Rows } from '../features/needs/parts';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Card, LoadError, Row, Screen, Section, Stack } from '../ui/Layout';
import { MoreButton, Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function MyOffersScreen() {
  return (
    <SignedInOnly>
      <MyOffers />
    </SignedInOnly>
  );
}

function MyOffers() {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void Promise.all([
      qc.invalidateQueries({ queryKey: ['me', 'matched-needs'] }),
      qc.invalidateQueries({ queryKey: ['me', 'offers'] }),
    ]).finally(() => setRefreshing(false));
  };
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack>
        <LinkText
          label={t('nav.dashboard')}
          onPress={() => nav.navigate('Tabs', { screen: 'Dashboard' })}
        />
        <T color={c.inkSoft}>{t('myOffers.lede')}</T>
        <Button
          kind="outline"
          small
          label={t('myOffers.browse')}
          onPress={() => nav.navigate('Needs')}
        />
      </Stack>
      <Matched />
      <Sent />
    </Screen>
  );
}

function Matched() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const qc = useQueryClient();
  const list = usePaged(['me', 'matched-needs'], (cursor) => needsApi.matchedNeeds(cursor));
  const dismiss = useMutation({
    mutationFn: needsApi.dismissMatch,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'matched-needs'] }),
  });

  return (
    <Section title={t('matched.title')}>
      <T v="small" color={c.inkSoft}>
        {t('matched.note')}
      </T>
      {list.isPending ? <Skeleton rows={2} /> : null}
      {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('matched.empty')}</T> : null}
      {list.rows.length > 0 ? (
        <Card>
          <Rows>
            {list.rows.map((m) => (
              <LedgerRow
                key={m.matchId}
                art={<ModeTile mode={m.need.mode} />}
                title={m.need.title}
                meta={[
                  needCode(m.need),
                  f.district(m.need.district),
                  f.range(m.need.budget.min, m.need.budget.max) ?? t('entry.open'),
                  t('matched.ends', { when: f.relative(m.need.expiresAt) }),
                ].join(' · ')}
                onPress={() => nav.navigate('Need', { id: m.need.id })}
              >
                {m.status === 'RESPONDED' ? (
                  <T v="small" color={c.inkSoft}>
                    {t('matched.responded')}
                  </T>
                ) : (
                  <Row>
                    <Button
                      small
                      label={t('matched.offer')}
                      onPress={() => nav.navigate('OfferForm', { needId: m.need.id })}
                    />
                    <Button
                      kind="outline"
                      small
                      disabled={dismiss.isPending}
                      label={t('matched.dismiss')}
                      onPress={() => dismiss.mutate(m.matchId)}
                    />
                  </Row>
                )}
              </LedgerRow>
            ))}
          </Rows>
        </Card>
      ) : null}
      <MoreButton query={list} />
    </Section>
  );
}

const FILTERS = ['', 'SUBMITTED', 'COUNTERED_BY_BUYER', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

function Sent() {
  const { t, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'offers', status], (cursor) =>
    offersApi.mine((status || undefined) as OfferStatus | undefined, cursor),
  );

  return (
    <Section title={t('myOffers.sent')}>
      <Chips
        label={t('myNeeds.status')}
        value={status}
        onChange={(v) => setStatus(v as (typeof FILTERS)[number])}
        options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
      />
      {list.isPending ? <Skeleton rows={3} /> : null}
      {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('myOffers.empty')}</T> : null}
      {list.rows.length > 0 ? (
        <Card>
          <Rows>
            {list.rows.map((o) => (
              <LedgerRow
                key={o.id}
                art={
                  <T v="code" color={c.inkSoft}>
                    {shortCode('O', o.id)}
                  </T>
                }
                title={`${f.taka(o.price)}${o.quantity !== 1 ? ` × ${num(o.quantity)}` : ''}`}
                meta={[f.state(o.status), f.relative(o.updatedAt)].join(' · ')}
                aside={
                  liveOffer(o.status) ? (
                    <T v="small" color={c.inkSoft}>
                      {o.awaiting === 'SELLER' ? t('compare.yourTurn') : t('compare.theirTurn')}
                    </T>
                  ) : undefined
                }
                onPress={() => nav.navigate('Offer', { id: o.id })}
              />
            ))}
          </Rows>
        </Card>
      ) : null}
      <MoreButton query={list} />
    </Section>
  );
}
