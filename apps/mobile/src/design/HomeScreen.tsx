import { useRoute, type RouteProp } from '@react-navigation/native';
import { useEffect, useRef, type ComponentType } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type ComposerHandle } from '../features/needs/Composer';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav, type RootParams, type TabParams } from '../nav/routes';
import { HowItWorks, LatestNeeds } from '../screens/homeParts';
import { GavelIcon, GridIcon, HandIcon, ListIcon, type IconProps } from '../ui/icons';
import { Card, Screen } from '../ui/Layout';
import { T } from '../ui/Text';
import { LangToggle } from './AppHeader';
import { c, r, space } from './tokens';
import { Wordmark } from './Wordmark';

const browse: Array<{
  to: 'Needs' | 'Listings' | 'LendItems' | 'Auctions';
  icon: ComponentType<IconProps>;
  label: MessageKey;
}> = [
  { to: 'Needs', icon: ListIcon, label: 'feed.title' },
  { to: 'Listings', icon: GridIcon, label: 'nav.listings' },
  { to: 'LendItems', icon: HandIcon, label: 'nav.lend' },
  { to: 'Auctions', icon: GavelIcon, label: 'nav.auctions' },
];

export function useFocusComposer() {
  const route = useRoute<RouteProp<TabParams, 'Home'>>();
  const composer = useRef<ComposerHandle>(null);
  const stamp = route.params?.focusComposer;
  useEffect(() => {
    if (stamp) composer.current?.focus();
  }, [stamp]);
  return composer;
}

/** The green bar runs into a full-bleed hero with rounded bottom corners; the composer overlaps it. */
export function HomeScreen() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const composer = useFocusComposer();
  return (
    <Screen bottomInset={false} contentStyle={styles.content}>
      <View style={[styles.hero, { paddingTop: insets.top + 10 }]}>
        <View style={styles.heroBar}>
          <Wordmark />
          <LangToggle />
        </View>
        <T v="small" color={c.onBrand} style={styles.kicker}>
          {t('brand.tagline')}
        </T>
        <T v="display" color={c.onBrand} accessibilityRole="header">
          {t('home.title')}
        </T>
      </View>
      <View style={styles.body}>
        <Card style={styles.composer}>
          <T color={c.inkSoft}>{t('home.lede')}</T>
          <Composer ref={composer} />
        </Card>
        <View style={styles.browse}>
          {browse.map(({ to, icon: Icon, label }) => (
            <Pressable
              key={to}
              accessibilityRole="link"
              onPress={() =>
                (nav as unknown as { navigate: (n: keyof RootParams) => void }).navigate(to)
              }
              style={styles.browseItem}
            >
              <View style={styles.browseIcon}>
                <Icon size={22} color={c.brand} />
              </View>
              <T v="code" align="center" style={styles.browseText}>
                {t(label)}
              </T>
            </Pressable>
          ))}
        </View>
        <Card>
          <LatestNeeds />
        </Card>
        <HowItWorks />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 0, gap: 0 },
  hero: {
    backgroundColor: c.brand,
    paddingHorizontal: space.gutter,
    paddingBottom: 54,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    gap: 10,
  },
  heroBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { opacity: 0.9, marginTop: 8 },
  body: { paddingHorizontal: space.gutter, gap: space.section },
  composer: { marginTop: -38, borderRadius: r.hero },
  browse: { flexDirection: 'row', gap: 8 },
  browseItem: { flex: 1, alignItems: 'center', gap: 6, minHeight: 44 },
  browseIcon: {
    width: 52,
    height: 52,
    borderRadius: r.tile,
    backgroundColor: c.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browseText: { fontSize: 12.5 },
});
