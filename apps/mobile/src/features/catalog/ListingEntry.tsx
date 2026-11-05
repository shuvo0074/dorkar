import { useFormat } from '@web/lib/format';
import { shortCode } from '@web/lib/format';
import type { Listing, ListingKind } from '@web/features/catalog/api';
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { c, cardEdge, elevation, r } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { BuyIcon, KeyIcon, UserIcon, type IconProps } from '../../ui/icons';
import { MediaImage } from '../../ui/Misc';
import { T } from '../../ui/Text';

export const kindIcon: Record<ListingKind, ComponentType<IconProps>> = {
  PRODUCT: BuyIcon,
  SERVICE: UserIcon,
  RENTAL: KeyIcon,
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

/** A listing as a card with its photo on top; lay these out two to a row. */
export function ListingEntry({ listing }: { listing: Listing }) {
  const f = useFormat();
  const price = usePrice();
  const nav = useNav();
  const Kind = kindIcon[listing.kind];
  const stamp = (
    <View style={styles.stamp}>
      <Kind size={32} color={c.inkSoft} />
    </View>
  );
  return (
    <Pressable
      accessibilityRole="link"
      style={({ pressed }) => [styles.card, elevation.card, cardEdge, pressed && styles.pressed]}
      onPress={() => nav.navigate('Listing', { id: listing.id })}
    >
      <View style={styles.art}>
        {listing.mediaIds[0] ? (
          <MediaImage id={listing.mediaIds[0]} style={styles.image} fallback={stamp} />
        ) : (
          stamp
        )}
      </View>
      <View style={styles.text}>
        <T v="bodyStrong" numberOfLines={2}>
          {listing.title}
        </T>
        <T v="small" color={c.inkSoft} numberOfLines={2}>
          {price(listing)} · {f.district(listing.district)}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, backgroundColor: c.paper, borderRadius: r.tile },
  pressed: { opacity: 0.7 },
  art: {
    aspectRatio: 1,
    backgroundColor: c.paperShade,
    borderTopLeftRadius: r.tile,
    borderTopRightRadius: r.tile,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  stamp: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  text: { padding: 10, gap: 2 },
});
