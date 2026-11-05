import { Modes, type Mode } from '@web/features/needs/modes';
import { StyleSheet, View } from 'react-native';
import { modeIcon } from '../features/needs/modeIcons';
import { useI18n } from '../lib/i18n';
import { Pressy } from '../ui/Pressy';
import { T } from '../ui/Text';
import { c, elevation, r } from './tokens';

/** Five equal service tiles with a line icon and a label; the chosen one fills coral and lifts. */
export function ModeTiles({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('home.mode')}>
      {Modes.map((m) => {
        const on = m === value;
        const Icon = modeIcon[m];
        return (
          <View key={m} style={styles.cell}>
            <Pressy
              scale={0.94}
              testID={`mode-${m}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={t(`mode.${m}`)}
              onPress={() => onChange(m)}
              style={[styles.tile, on ? [styles.on, elevation.lift] : styles.off]}
            >
              <View style={[styles.icon, on ? styles.iconOn : null]}>
                <Icon size={20} color={on ? c.onHot : c.ink} />
              </View>
              <T v="code" numberOfLines={1} color={on ? c.onHot : c.ink} style={styles.name}>
                {t(`mode.${m}`)}
              </T>
            </Pressy>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  cell: { flex: 1 },
  tile: {
    alignItems: 'center',
    gap: 6,
    paddingTop: 10,
    paddingBottom: 8,
    borderRadius: r.tile,
    minHeight: 76,
  },
  on: { backgroundColor: c.hot },
  off: { backgroundColor: c.ground },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  iconOn: { backgroundColor: 'rgba(255,255,255,0.28)' },
  name: { fontSize: 12.5 },
});
