import { useRoute, type RouteProp } from '@react-navigation/native';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, type ComposerHandle } from '../features/needs/Composer';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav, type TabParams } from '../nav/routes';
import { HowItWorks, LatestNeeds } from '../screens/homeParts';
import { GavelIcon, GridIcon, HandIcon, ListIcon, type IconProps } from '../ui/icons';
import { Card, Screen } from '../ui/Layout';
import { reduceMotion } from '../ui/Pressy';
import { T } from '../ui/Text';
import { LangToggle } from './AppHeader';
import { c, elevation, r, space } from './tokens';
import { Wordmark } from './Wordmark';

type To = 'Needs' | 'Listings' | 'LendItems' | 'Auctions';
const browse: Array<{
  to: To;
  icon: ComponentType<IconProps>;
  label: MessageKey;
  bg: string;
  fg: string;
  plate: string;
}> = [
  {
    to: 'Needs',
    icon: ListIcon,
    label: 'feed.title',
    bg: c.hot,
    fg: c.onHot,
    plate: 'rgba(15,16,32,0.1)',
  },
  {
    to: 'Listings',
    icon: GridIcon,
    label: 'nav.listings',
    bg: c.brand,
    fg: c.onBrand,
    plate: 'rgba(255,255,255,0.18)',
  },
  { to: 'LendItems', icon: HandIcon, label: 'nav.lend', bg: c.paper, fg: c.ink, plate: c.ground },
  {
    to: 'Auctions',
    icon: GavelIcon,
    label: 'nav.auctions',
    bg: c.primaryBg,
    fg: c.primaryFg,
    plate: 'rgba(255,255,255,0.14)',
  },
];

/** Home cards rise in with a short stagger. */
function Rise({ index, children }: { index: number; children: ReactNode }) {
  const v = useRef(new Animated.Value(reduceMotion() ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(v, {
      toValue: 1,
      delay: index * 60,
      useNativeDriver: true,
      speed: 14,
      bounciness: 7,
    }).start();
  }, [v, index]);
  return (
    <Animated.View
      style={{
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** The board: dark hero, composer, four coloured tiles, latest needs, how it works. */
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
    <Screen bottomInset={false} contentStyle={[styles.content, { paddingTop: insets.top + 8 }]}>
      <View style={styles.bar}>
        <Wordmark />
        <LangToggle />
      </View>
      <Rise index={0}>
        <View style={styles.hero}>
          <T v="label" color={c.hot}>
            {t('brand.tagline')}
          </T>
          <T v="display" color={c.primaryFg} accessibilityRole="header">
            {t('home.title')}
          </T>
          <T color="rgba(255,255,255,0.78)">{t('home.lede')}</T>
        </View>
      </Rise>
      <Rise index={1}>
        <Card>
          <Composer ref={composer} />
        </Card>
      </Rise>
      <Rise index={2}>
        <View style={styles.grid}>
          {browse.map(({ to, icon: Icon, label, bg, fg, plate }) => (
            <Pressable
              key={to}
              accessibilityRole="link"
              onPress={() => nav.navigate(to as 'Needs')}
              style={({ pressed }) => [
                styles.tile,
                elevation.card,
                { backgroundColor: bg, transform: [{ scale: pressed ? 0.96 : 1 }] },
              ]}
            >
              <View style={[styles.plate, { backgroundColor: plate }]}>
                <Icon size={22} color={fg} />
              </View>
              <T v="bodyStrong" color={fg}>
                {t(label)}
              </T>
            </Pressable>
          ))}
        </View>
      </Rise>
      <Rise index={3}>
        <Card style={styles.round}>
          <LatestNeeds />
        </Card>
      </Rise>
      <Rise index={4}>
        <Card>
          <HowItWorks />
        </Card>
      </Rise>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingHorizontal: space.gutter },
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hero: { backgroundColor: c.primaryBg, borderRadius: r.hero, padding: 22, gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: {
    width: '47.5%',
    flexGrow: 1,
    minHeight: 124,
    borderRadius: r.card,
    padding: 16,
    justifyContent: 'space-between',
    gap: 12,
  },
  plate: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: r.hero },
});
