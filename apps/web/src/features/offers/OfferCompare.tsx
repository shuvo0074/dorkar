import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../../components/forms/fields';
import { Biro } from '../../components/ui/Biro';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { shortCode, useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { Need } from '../needs/api';
import { liveOffer, offersApi } from './api';

/**
 * The requester's comparison of offers on one need: cheapest or newest first, live ones by
 * default. The offers waiting for the requester's answer are circled.
 */
export function OfferCompare({ need }: { need: Need }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const [sort, setSort] = useState<'newest' | 'price_asc'>('price_asc');
  const [scope, setScope] = useState<'live' | 'all'>('live');
  const list = usePaged(['offers', 'need', need.id, sort], (cursor) =>
    offersApi.forNeed(need.id, sort, undefined, cursor),
  );
  const rows = scope === 'live' ? list.rows.filter((o) => liveOffer(o.status)) : list.rows;

  return (
    <section className="item__wide" aria-labelledby="offers-title">
      <div className="section-head">
        <h2 id="offers-title">{t('compare.title')}</h2>
        {list.data && <p>{t('need.offers', { n: list.rows.length })}</p>}
      </div>
      <div className="desk__controls">
        <Segmented
          legend={t('compare.sort')}
          name="offer-sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'price_asc', label: t('compare.cheapest') },
            { value: 'newest', label: t('compare.newest') },
          ]}
        />
        <Segmented
          legend={t('myNeeds.status')}
          name="offer-scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'live', label: t('compare.live') },
            { value: 'all', label: t('compare.all') },
          ]}
        />
      </div>
      {list.isPending && <LedgerSkeleton rows={3} />}
      {list.isError && <LoadError onRetry={() => void list.refetch()} />}
      {list.data && rows.length === 0 && (
        <p className="muted">{t(list.rows.length === 0 ? 'compare.empty' : 'compare.emptyLive')}</p>
      )}
      {rows.length > 0 && (
        <ul className="ledger offers">
          {rows.map((o) => {
            const mine = o.awaiting === 'BUYER';
            return (
              <li key={o.id}>
                <span className="ledger__art offers__price">
                  <span className="code">{shortCode('O', o.id)}</span>
                </span>
                <div>
                  <Link className="ledger__title offers__amount" to={`/offers/${o.id}`}>
                    {f.taka(o.price)}
                    {o.quantity !== 1 && <span className="muted"> × {num(o.quantity)}</span>}
                  </Link>
                  <p className="ledger__meta">
                    {[
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
                  </p>
                </div>
                {liveOffer(o.status) &&
                  (mine ? (
                    <span className="ledger__here">
                      {t('compare.yourTurn')}
                      <Biro tilt={-3} />
                    </span>
                  ) : (
                    <span className="muted">{t('compare.theirTurn')}</span>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <MoreButton query={list} />
    </section>
  );
}
