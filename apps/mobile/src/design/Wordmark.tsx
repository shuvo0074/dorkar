import { StyleSheet, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { T } from '../ui/Text';
import { c } from './tokens';

/** dorkar. with a violet dot, beside দরকার, on the ground: there is no bar. */
export function Wordmark() {
  const { t } = useI18n();
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="header"
      accessibilityLabel={t('brand.latin')}
    >
      <T v="section" style={styles.latin}>
        {t('brand.latin').toLowerCase()}
        <T v="section" color={c.brand} style={styles.latin}>
          .
        </T>
      </T>
      <T v="small" color={c.inkSoft}>
        {t('brand.bangla')}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  latin: { fontSize: 24, lineHeight: 30, letterSpacing: -1 },
});
