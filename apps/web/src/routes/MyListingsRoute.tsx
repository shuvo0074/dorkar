import { useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { catalogApi, type ListingStatus } from '../features/catalog/api';
import { kindGlyph, listingCode, usePrice } from '../features/catalog/ListingEntry';
import { MediaImage } from '../features/media/Photos';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';

const FILTERS = ['', 'PUBLISHED', 'DRAFT', 'PAUSED', 'SOLD_OUT', 'WITHDRAWN'] as const;

export default function MyListingsRoute() {
  return (
    <SignedInOnly from="/my/listings">
      <MyListings />
    </SignedInOnly>
  );
}

function MyListings() {
  const { t } = useI18n();
  const f = useFormat();
  const price = usePrice();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'listings', status], (cursor) =>
    catalogApi.myListings((status || undefined) as ListingStatus | undefined, cursor),
  );

  return (
    <div className="browse">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/dashboard">{t('nav.dashboard')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('myListings.title')}</h1>
        <p className="desk__lede">{t('myListings.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--small" to="/listings/new">
            {t('myListings.new')}
          </Link>
        </div>
      </header>

      <section aria-labelledby="mine-title">
        <div className="section-head">
          <h2 id="mine-title">{t('listings.title')}</h2>
        </div>
        <Segmented
          legend={t('myNeeds.status')}
          hideLegend
          name="my-listings-status"
          value={status}
          onChange={setStatus}
          options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
        />
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && (
          <p className="muted">{t(status ? 'myNeeds.emptyStatus' : 'myListings.empty')}</p>
        )}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((l) => {
              const Glyph = kindGlyph[l.kind];
              return (
                <li key={l.id}>
                  <span className="ledger__art ledger__art--photo">
                    {l.mediaIds[0] ? (
                      <MediaImage id={l.mediaIds[0]} fallback={<Glyph />} />
                    ) : (
                      <Glyph />
                    )}
                  </span>
                  <div>
                    <Link className="ledger__title" to={`/listings/${l.id}`}>
                      {l.title}
                    </Link>
                    <p className="ledger__meta">
                      {[
                        listingCode(l.id),
                        f.state(l.status),
                        price(l),
                        t('listing.availableN', { n: l.quantityAvailable }),
                      ].join(' · ')}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
