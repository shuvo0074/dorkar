import { catalogApi, type ListingStatus } from '@web/features/catalog/api';
import { useFormat } from '@web/lib/format';
import { useState } from 'react';
import { c } from '../design/tokens';
import { kindIcon, listingCode, usePrice } from '../features/catalog/ListingEntry';
import { LedgerRow, ledgerPhoto, PagedList } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Stack } from '../ui/Layout';
import { MediaImage, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

const FILTERS = ['', 'PUBLISHED', 'DRAFT', 'PAUSED', 'SOLD_OUT', 'WITHDRAWN'] as const;

export default function MyListingsScreen() {
  return (
    <SignedInOnly>
      <MyListings />
    </SignedInOnly>
  );
}

function MyListings() {
  const { t } = useI18n();
  const f = useFormat();
  const price = usePrice();
  const nav = useNav();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('');
  const list = usePaged(['me', 'listings', status], (cursor) =>
    catalogApi.myListings((status || undefined) as ListingStatus | undefined, cursor),
  );

  return (
    <PagedList
      query={list}
      empty={t(status ? 'myNeeds.emptyStatus' : 'myListings.empty')}
      renderRow={(l) => {
        const Kind = kindIcon[l.kind];
        const glyph = <Kind size={24} color={c.ink} />;
        return (
          <LedgerRow
            art={
              l.mediaIds[0] ? (
                <MediaImage id={l.mediaIds[0]} style={ledgerPhoto} fallback={glyph} />
              ) : (
                glyph
              )
            }
            title={l.title}
            meta={[
              listingCode(l.id),
              f.state(l.status),
              price(l),
              t('listing.availableN', { n: l.quantityAvailable }),
            ].join(' · ')}
            onPress={() => nav.navigate('Listing', { id: l.id })}
          />
        );
      }}
      header={
        <Stack>
          <T color={c.inkSoft}>{t('myListings.lede')}</T>
          <Button small label={t('myListings.new')} onPress={() => nav.navigate('ListingForm')} />
          <Chips
            label={t('myNeeds.status')}
            value={status}
            onChange={(v) => setStatus(v as (typeof FILTERS)[number])}
            options={FILTERS.map((s) => ({ value: s, label: s ? f.state(s) : t('myNeeds.all') }))}
          />
        </Stack>
      }
    />
  );
}
