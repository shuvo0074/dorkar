import { Modes, type Mode } from '@web/features/needs/modes';
import { LayoutAnimation, StyleSheet, useWindowDimensions, View } from 'react-native';
import { modeIcon } from '../features/needs/modeIcons';
import { useI18n } from '../lib/i18n';
import { Pressy, reduceMotion } from '../ui/Pressy';
import { T } from '../ui/Text';
import { c } from './tokens';

const spring = { duration: 380, update: { type: 'spring' as const, springDamping: 0.72 } };

/**
 * A track of five: the chosen tile turns ink and grows to show its name, the others shrink to
 * icons (names stay for screen readers). On very narrow phones every tile shows its name instead.
 */
export function ModeTiles({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  const narrow = useWindowDimensions().width < 360;
  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={t('home.mode')}>
      {Modes.map((m) => {
        const on = m === value;
        const Icon = modeIcon[m];
        return (
          <View key={m} style={{ flex: !narrow && on ? 2.8 : 1 }}>
            <Pressy
              scale={0.93}
              testID={`mode-${m}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={t(`mode.${m}`)}
              onPress={() => {
                if (!reduceMotion()) LayoutAnimation.configureNext(spring);
                onChange(m);
              }}
              style={[styles.tile, narrow && styles.tileNarrow, on && styles.on]}
            >
              <Icon size={20} color={on ? c.primaryFg : c.ink} strokeWidth={2.1} />
              {on || narrow ? (
                <T v="code" numberOfLines={1} color={on ? c.primaryFg : c.ink} style={styles.name}>
                  {t(`mode.${m}`)}
                </T>
              ) : null}
            </Pressy>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: 6,
    padding: 6,
    marginHorizontal: -6,
    borderRadius: 22,
    backgroundColor: c.ground,
  },
  tile: {
    minHeight: 56,
    borderRadius: 17,
    backgroundColor: c.paper,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  tileNarrow: { flexDirection: 'column', gap: 2 },
  on: { backgroundColor: c.primaryBg },
  name: { fontSize: 14 },
});
