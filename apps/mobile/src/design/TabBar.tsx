import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../features/auth/session';
import { useUnread } from '../features/notifications/useUnread';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { BellIcon, ChartIcon, HomeIcon, PlusIcon, UserIcon, type IconProps } from '../ui/icons';
import { Pressy } from '../ui/Pressy';
import { T } from '../ui/Text';
import { c, elevation, size } from './tokens';

const tabs: Record<string, { icon: ComponentType<IconProps>; label: MessageKey }> = {
  Home: { icon: HomeIcon, label: 'nav.catalog' },
  Inbox: { icon: BellIcon, label: 'nav.inbox' },
  Dashboard: { icon: ChartIcon, label: 'nav.dashboard' },
  Account: { icon: UserIcon, label: 'nav.account' },
};

/** Home, Inbox, a raised coral Post, Dashboard, Account; the active tab gets a green pill. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { t, num } = useI18n();
  const { status } = useSession();
  const insets = useSafeAreaInsets();
  const unread = useUnread();
  const nav = useNav();
  const signedIn = status === 'signedIn';
  const active = state.routes[state.index]?.name;

  const tab = (name: string) => {
    const { icon: Icon, label } = tabs[name]!;
    const on = active === name;
    const go = () => {
      if (name === 'Account' && !signedIn) nav.navigate('SignIn');
      else navigation.navigate(name);
    };
    const text = name === 'Account' && !signedIn ? t('nav.signIn') : t(label);
    const badge = name === 'Inbox' && unread > 0;
    return (
      <Pressable
        key={name}
        testID={`tab-${name}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={badge ? t('inbox.badge', { n: unread }) : text}
        onPress={go}
        style={styles.tab}
      >
        <View style={[styles.pill, on && styles.pillOn]}>
          <Icon size={22} color={on ? c.brand : c.inkSoft} />
          {badge ? (
            <View style={styles.count}>
              <T v="code" color={c.badgeFg} style={styles.countText}>
                {unread > 99 ? '99+' : num(unread)}
              </T>
            </View>
          ) : null}
        </View>
        <T v="code" numberOfLines={1} color={on ? c.brand : c.inkSoft}>
          {text}
        </T>
      </Pressable>
    );
  };
  const gap = (k: string) => <View key={k} style={styles.tab} />;

  return (
    <View
      style={[styles.bar, { paddingBottom: insets.bottom, height: size.tabBar + insets.bottom }]}
    >
      {tab('Home')}
      {signedIn ? tab('Inbox') : gap('g1')}
      <View style={styles.tab}>
        <Pressy
          testID="tab-post"
          scale={0.92}
          accessibilityLabel={t('nav.post')}
          onPress={() => navigation.navigate('Home', { focusComposer: Date.now() })}
          style={styles.post}
        >
          <View style={[styles.plus, elevation.lift]}>
            <PlusIcon size={26} color={c.onHot} strokeWidth={2.4} />
          </View>
          <T v="code" color={c.ink}>
            {t('nav.postShort')}
          </T>
        </Pressy>
      </View>
      {signedIn ? tab('Dashboard') : gap('g2')}
      {tab('Account')}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: c.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.line,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  pill: {
    minWidth: 52,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillOn: { backgroundColor: c.brandTint },
  count: {
    position: 'absolute',
    top: -3,
    right: 4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.badgeBg,
  },
  countText: { fontSize: 11, lineHeight: 14 },
  post: { alignItems: 'center', gap: 2, marginTop: -22 },
  plus: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: c.hot,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
