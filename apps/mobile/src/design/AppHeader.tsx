import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import { titleKeys } from '../nav/titles';
import type { RouteName } from '../nav/routes';
import { BackIcon } from '../ui/icons';
import { T } from '../ui/Text';
import { c } from './tokens';

export function LangToggle() {
  const { t, lang, setLang } = useI18n();
  return (
    <Pressable
      testID="lang"
      accessibilityRole="button"
      accessibilityLabel={t('lang.switch')}
      hitSlop={6}
      onPress={() => setLang(lang === 'en' ? 'bn' : 'en')}
      style={styles.lang}
    >
      <T v="small" color={c.onBrand} style={styles.langText}>
        {t('lang.other')}
      </T>
    </Pressable>
  );
}

/** Green bar on every pushed page: back, the page's name, the language switch. */
export function StackHeader({ navigation, route, options, back }: NativeStackHeaderProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const key = titleKeys[route.name as RouteName];
  const title = options.title ?? (key ? t(key) : '');
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
      {back ? (
        <Pressable
          testID="back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          hitSlop={8}
          onPress={navigation.goBack}
          style={styles.back}
        >
          <BackIcon color={c.onBrand} />
        </Pressable>
      ) : null}
      <T
        v="bodyStrong"
        color={c.onBrand}
        numberOfLines={1}
        accessibilityRole="header"
        style={styles.title}
      >
        {title}
      </T>
      <LangToggle />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: c.brand,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 18 },
  lang: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  langText: { fontWeight: undefined },
});
