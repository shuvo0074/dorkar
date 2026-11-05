import type { Need } from '@web/features/needs/api';
import { liveOffer, offersApi } from '@web/features/offers/api';
import { shortCode, useFormat } from '@web/lib/format';
import { useState } from 'react';
import { c } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Chips, FieldShell } from '../../ui/Fields';
import { Card, LoadError, Section } from '../../ui/Layout';
import { Badge, MoreButton, Skeleton, usePaged } from '../../ui/Misc';
import { T } from '../../ui/Text';
import { LedgerRow, Rows } from '../needs/parts';

/**
 * The requester's comparison of offers on one need: cheapest or newest first, live ones by
 * default. The offers waiting for the requester's answer carry a hot badge.
 */
export function OfferCompare({ need }: { need: Need }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const [sort, setSort] = useState<'newest' | 'price_asc'>('price_asc');
  const [scope, setScope] = useState<'live' | 'all'>('live');
  const list = usePaged(['offers', 'need', need.id, sort], (cursor) =>
    offersApi.forNeed(need.id, sort, undefined, cursor),
  );
  const rows = scope === 'live' ? list.rows.filter((o) => liveOffer(o.status)) : list.rows;

  return (
    <Section
      title={t('compare.title')}
      right={
        list.data ? (
          <T v="small" color={c.inkSoft}>
            {t('need.offers', { n: list.rows.length })}
          </T>
        ) : undefined
      }
    >
      <FieldShell label={t('compare.sort')}>
        <Chips
          label={t('compare.sort')}
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          options={[
            { value: 'price_asc', label: t('compare.cheapest') },
            { value: 'newest', label: t('compare.newest') },
          ]}
        />
      </FieldShell>
      <FieldShell label={t('myNeeds.status')}>
        <Chips
          label={t('myNeeds.status')}
          value={scope}
          onChange={(v) => setScope(v as typeof scope)}
          options={[
            { value: 'live', label: t('compare.live') },
            { value: 'all', label: t('compare.all') },
          ]}
        />
      </FieldShell>
      {list.isPending ? <Skeleton rows={3} /> : null}
      {list.isError ? <LoadError onRetry={() => void list.refetch()} /> : null}
      {list.data && rows.length === 0 ? (
        <T color={c.inkSoft}>{t(list.rows.length === 0 ? 'compare.empty' : 'compare.emptyLive')}</T>
      ) : null}
      {rows.length > 0 ? (
        <Card>
          <Rows>
            {rows.map((o) => (
              <LedgerRow
                key={o.id}
                art={
                  <T v="code" color={c.inkSoft}>
                    {shortCode('O', o.id)}
                  </T>
                }
                title={`${f.taka(o.price)}${o.quantity !== 1 ? ` × ${num(o.quantity)}` : ''}`}
                meta={[
                  o.sellerDisplayName
                    ? t('compare.seller', { name: o.sellerDisplayName })
                    : t('compare.sellerUnknown'),
                  o.condition && f.condition(o.condition),
                  f.delivery(o.deliveryTerms.method),
                  o.deliveryTerms.feeAmount ? `+${f.taka(o.deliveryTerms.feeAmount)}` : null,
                  f.state(o.status),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aside={
                  liveOffer(o.status) ? (
                    o.awaiting === 'BUYER' ? (
                      <Badge tone="hot" label={t('compare.yourTurn')} />
                    ) : (
                      <T v="small" color={c.inkSoft}>
                        {t('compare.theirTurn')}
                      </T>
                    )
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
