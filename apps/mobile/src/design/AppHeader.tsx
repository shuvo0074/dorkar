import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import type { RouteName } from '../nav/routes';
import { titleKeys } from '../nav/titles';
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
      onPress={() => setLang(lang === 'en' ? 'bn' : 'en')}
      style={styles.glass}
    >
      <T v="small" style={styles.langText}>
        {t('lang.other')}
      </T>
    </Pressable>
  );
}

/** Dark glass bar: near-opaque so content never ghosts through. */
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
          onPress={navigation.goBack}
          style={[styles.glass, styles.back]}
        >
          <BackIcon size={20} strokeWidth={2.4} />
        </Pressable>
      ) : null}
      <T v="bodyStrong" numberOfLines={1} accessibilityRole="header" style={styles.title}>
        {title}
      </T>
      <LangToggle />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: 'rgba(13,15,24,0.94)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.lineStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  title: { flex: 1, fontSize: 18 },
  glass: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  back: { paddingHorizontal: 0, borderRadius: 14 },
  langText: { fontFamily: 'HindSiliguri-SemiBold' },
});
