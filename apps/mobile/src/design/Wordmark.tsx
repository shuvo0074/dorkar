import { StyleSheet, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { T } from '../ui/Text';
import { c } from './tokens';

/** A glow "d" badge before the wordmark. */
export function Wordmark() {
  const { t } = useI18n();
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="header"
      accessibilityLabel={t('brand.latin')}
    >
      <View style={styles.badge}>
        <T v="section" color={c.onBrand} style={styles.d}>
          d
        </T>
      </View>
      <T v="section" style={styles.latin}>
        {t('brand.latin').toLowerCase()}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: c.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  d: { fontSize: 17, lineHeight: 22 },
  latin: { letterSpacing: -0.4 },
});
