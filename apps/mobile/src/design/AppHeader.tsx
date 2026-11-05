import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import type { RouteName } from '../nav/routes';
import { titleKeys } from '../nav/titles';
import { BackIcon } from '../ui/icons';
import { T } from '../ui/Text';
import { c, r, space } from './tokens';

export function LangToggle() {
  const { t, lang, setLang } = useI18n();
  return (
    <Pressable
      testID="lang"
      accessibilityRole="button"
      accessibilityLabel={t('lang.switch')}
      onPress={() => setLang(lang === 'en' ? 'bn' : 'en')}
      style={styles.square}
    >
      <T v="small" style={styles.langText}>
        {t('lang.other')}
      </T>
    </Pressable>
  );
}

/** No bar: white squares for back and language, the page's name heavy on the ground. */
export function StackHeader({ navigation, route, options, back }: NativeStackHeaderProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const key = titleKeys[route.name as RouteName];
  const title = options.title ?? (key ? t(key) : '');
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
      {back ? (
        <Pressable
          testID="back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={navigation.goBack}
          style={[styles.square, styles.back]}
        >
          <BackIcon size={20} strokeWidth={2.4} />
        </Pressable>
      ) : null}
      <T v="section" numberOfLines={1} accessibilityRole="header" style={styles.title}>
        {title}
      </T>
      <LangToggle />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: c.ground,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: space.gutter,
    paddingBottom: 8,
  },
  title: { flex: 1 },
  square: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: c.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: { paddingHorizontal: 0 },
  langText: { fontFamily: 'HindSiliguri-SemiBold' },
});
