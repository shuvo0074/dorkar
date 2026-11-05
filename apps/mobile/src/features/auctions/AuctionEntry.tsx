import { auctionCode, type Auction } from '@web/features/auctions/api';
import { useFormat } from '@web/lib/format';
import { c } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { GavelIcon } from '../../ui/icons';
import { EntryCard, EntryStamp } from '../catalog/pageParts';

/** An auction as a card; lay these out two to a row. */
export function AuctionEntry({ a }: { a: Auction }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const price = a.leadingAmount ?? a.startPrice;
  return (
    <EntryCard
      art={
        <EntryStamp>
          <GavelIcon size={32} color={c.inkSoft} />
        </EntryStamp>
      }
      code={auctionCode(a.id)}
      title={a.title}
      meta={[
        t(`auctions.kind.${a.kind}`),
        f.taka(price),
        a.status === 'OPEN' && t('auction.endsIn', { when: f.relative(a.endsAt) }),
      ]
        .filter(Boolean)
        .join(' · ')}
      onPress={() => nav.navigate('Auction', { id: a.id })}
    />
  );
}
