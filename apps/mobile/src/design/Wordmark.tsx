import { StyleSheet, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { T } from '../ui/Text';
import { c } from './tokens';

/** Lowercase dorkar beside দরকার, always white on the green bar. */
export function Wordmark() {
  const { t } = useI18n();
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="header"
      accessibilityLabel={t('brand.latin')}
    >
      <T v="section" color={c.onBrand} style={styles.latin}>
        {t('brand.latin').toLowerCase()}
      </T>
      <T v="small" color={c.onBrand} style={styles.bn}>
        {t('brand.bangla')}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  latin: { fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  bn: { opacity: 0.85 },
});
