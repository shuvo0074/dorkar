import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BagGlyph, KeyGlyph, PersonGlyph } from '../../components/glyphs/glyphs';
import { shortCode, useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { MediaImage } from '../media/Photos';
import type { Listing, ListingKind } from './api';

export const kindGlyph: Record<ListingKind, () => ReactNode> = {
  PRODUCT: BagGlyph,
  SERVICE: PersonGlyph,
  RENTAL: KeyGlyph,
};

export const listingCode = (id: string) => shortCode('L', id);

/** "৳1,200 per day" in the page language. */
export function usePrice() {
  const { t } = useI18n();
  const f = useFormat();
  return (l: Pick<Listing, 'price' | 'priceUnit'>) => {
    const unit = l.priceUnit === 'TOTAL' ? '' : t(`unit.${l.priceUnit}`);
    return unit ? `${f.taka(l.price)} ${unit}` : f.taka(l.price);
  };
}

/** A listing as a catalog square: its first photo (or the kind's stamp), code, title, price. */
export function ListingEntry({ listing }: { listing: Listing }) {
  const f = useFormat();
  const price = usePrice();
  const Glyph = kindGlyph[listing.kind];
  return (
    <li className="entry">
      <Link to={`/listings/${listing.id}`} className="entry__link">
        <div className="entry__art">
          {listing.mediaIds[0] ? (
            <MediaImage id={listing.mediaIds[0]} fallback={<Glyph />} />
          ) : (
            <Glyph />
          )}
        </div>
        <span className="entry__code code">{listingCode(listing.id)}</span>
        <span className="entry__title">{listing.title}</span>
        <span className="entry__meta">
          {price(listing)} · {f.district(listing.district)}
        </span>
      </Link>
    </li>
  );
}
