import { auctionCode, auctionsApi } from '@web/features/auctions/api';
import { useFormat } from '@web/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { c } from '../design/tokens';
import { LedgerRow, PagedSection, useRefresh } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav } from '../nav/routes';
import { GavelIcon } from '../ui/icons';
import { Screen } from '../ui/Layout';
import { usePaged } from '../ui/Misc';

export default function MyAuctionsScreen() {
  return (
    <SignedInOnly>
      <Page />
    </SignedInOnly>
  );
}

function Page() {
  const qc = useQueryClient();
  const pull = useRefresh(() =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['me', 'auctions'] }),
      qc.invalidateQueries({ queryKey: ['me', 'bids'] }),
    ]),
  );
  return (
    <Screen {...pull}>
      <Running />
      <MyBids />
    </Screen>
  );
}

function Running() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const list = usePaged(['me', 'auctions'], (cursor) => auctionsApi.mine(cursor));
  return (
    <PagedSection
      title={t('myAuctions.running')}
      query={list}
      empty={t('myAuctions.empty')}
      renderRow={(a) => (
        <LedgerRow
          art={<GavelIcon size={24} color={c.ink} />}
          title={a.title}
          meta={[
            auctionCode(a.id),
            t(`auctions.kind.${a.kind}`),
            f.state(a.status),
            a.leadingAmount ? f.taka(a.leadingAmount) : t('auction.noBids'),
          ].join(' · ')}
          onPress={() => nav.navigate('Auction', { id: a.id })}
        />
      )}
    />
  );
}

function MyBids() {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const list = usePaged(['me', 'bids'], (cursor) => auctionsApi.myBids(cursor));
  return (
    <PagedSection
      title={t('myAuctions.bids')}
      query={list}
      empty={t('myAuctions.noBids')}
      renderRow={(b) => (
        <LedgerRow
          artText={t(`bid.${b.status}`)}
          title={b.auction.title}
          meta={[
            f.taka(b.amount),
            f.state(b.auction.status),
            b.auction.leadingAmount && `${t('auction.leading')} ${f.taka(b.auction.leadingAmount)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          onPress={() => nav.navigate('Auction', { id: b.auction.id })}
        />
      )}
    />
  );
}
