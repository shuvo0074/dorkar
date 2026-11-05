import { Modes, type Mode } from '@web/features/needs/modes';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { modeIcon } from '../features/needs/modeIcons';
import { useI18n } from '../lib/i18n';
import { reduceMotion } from '../ui/Pressy';
import { T } from '../ui/Text';
import { c, r } from './tokens';

const GAP = 6;

/** Five glass tiles; a glow pill springs along under the chosen one. */
export function ModeTiles({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  const [width, setWidth] = useState(0);
  const cell = width ? (width - GAP * (Modes.length - 1)) / Modes.length : 0;
  const index = Modes.indexOf(value);
  const x = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);
  useEffect(() => {
    if (!cell) return;
    const to = index * (cell + GAP);
    if (!placed.current || reduceMotion()) {
      placed.current = true;
      x.setValue(to);
    } else
      Animated.spring(x, { toValue: to, useNativeDriver: true, speed: 16, bounciness: 9 }).start();
  }, [index, cell, x]);

  return (
    <View
      style={styles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('home.mode')}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {cell ? (
        <Animated.View style={[styles.pill, { width: cell, transform: [{ translateX: x }] }]} />
      ) : null}
      {Modes.map((m) => {
        const on = m === value;
        const Icon = modeIcon[m];
        return (
          <Pressable
            key={m}
            testID={`mode-${m}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={t(`mode.${m}`)}
            onPress={() => onChange(m)}
            style={({ pressed }) => [styles.tile, on && styles.tileOn, pressed && styles.pressed]}
          >
            <Icon size={20} color={on ? c.onHot : c.ink} />
            <T v="code" numberOfLines={1} color={on ? c.onHot : c.ink} style={styles.name}>
              {t(`mode.${m}`)}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: GAP },
  pill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: r.tile,
    backgroundColor: c.hot,
    shadowColor: c.hot,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  tile: {
    flex: 1,
    minHeight: 72,
    borderRadius: r.tile,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.065)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
  },
  tileOn: { backgroundColor: 'transparent', borderColor: 'transparent' },
  pressed: { transform: [{ scale: 0.94 }] },
  name: { fontSize: 12.5 },
});
