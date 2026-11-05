import { useRoute, type RouteProp } from '@react-navigation/native';
import { useEffect, useRef, type ComponentType } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type ComposerHandle } from '../features/needs/Composer';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav, type TabParams } from '../nav/routes';
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

/** A large title on the night, then the composer as the main glass card. */
export function HomeScreen() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const route = useRoute<RouteProp<TabParams, 'Home'>>();
  const composer = useRef<ComposerHandle>(null);
  const stamp = route.params?.focusComposer;
  useEffect(() => {
    if (stamp) composer.current?.focus();
  }, [stamp]);

  return (
    <Screen bottomInset={false} contentStyle={[styles.content, { paddingTop: insets.top + 10 }]}>
      <View style={styles.bar}>
        <Wordmark />
        <LangToggle />
      </View>
      <View style={styles.hero}>
        <T color={c.inkSoft}>{t('brand.tagline')}</T>
        <T v="display" accessibilityRole="header">
          {t('home.title')}
        </T>
      </View>
      <Card style={styles.composer}>
        <T color={c.inkSoft}>{t('home.lede')}</T>
        <Composer ref={composer} />
      </Card>
      <View style={styles.grid}>
        {browse.map(({ to, icon: Icon, label }) => (
          <Pressable
            key={to}
            accessibilityRole="link"
            onPress={() => nav.navigate(to as 'Needs')}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <Icon size={22} color={c.accent} />
            <T v="bodyStrong" style={styles.shrink}>
              {t(label)}
            </T>
          </Pressable>
        ))}
      </View>
      <Card>
        <LatestNeeds />
      </Card>
      <Card>
        <HowItWorks />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.section },
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hero: { gap: 8, marginTop: 8 },
  composer: { borderRadius: r.hero, padding: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    width: '48%',
    flexGrow: 1,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: r.tile,
    backgroundColor: c.paper,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
  },
  pressed: { transform: [{ scale: 0.97 }] },
  shrink: { flexShrink: 1 },
});
