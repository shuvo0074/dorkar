import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { c, r, size } from '../design/tokens';
import { Pressy } from './Pressy';
import { T } from './Text';

type Kind = 'primary' | 'outline' | 'danger' | 'accent' | 'link';

const fg: Record<Kind, string> = {
  primary: c.primaryFg,
  outline: c.ink,
  danger: c.redInk,
  accent: c.onHot,
  link: c.accent,
};

/** Ink primary, outline secondary, red outline for danger, and a plain link. */
export function Button({
  label,
  onPress,
  kind = 'primary',
  small,
  block,
  disabled,
  busy,
  icon,
  testID,
}: {
  label: string;
  onPress?: () => void;
  kind?: Kind;
  small?: boolean;
  block?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  testID?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressy
      testID={testID}
      onPress={off ? undefined : onPress}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={[
        styles.base,
        { minHeight: small ? size.small : size.primary },
        kind === 'primary' && { backgroundColor: c.primaryBg },
        kind === 'accent' && { backgroundColor: c.hot },
        kind === 'outline' && styles.outline,
        kind === 'danger' && styles.danger,
        kind === 'link' && styles.link,
        block && styles.block,
        off ? styles.off : null,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator color={fg[kind]} size="small" /> : icon}
        <T v="button" color={fg[kind]} style={small ? styles.smallText : null}>
          {label}
        </T>
      </View>
    </Pressy>
  );
}

/** Text that acts: for inline "see all" and retry links. */
export function LinkText({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <T
      v="bodyStrong"
      color={c.accent}
      accessibilityRole="link"
      onPress={onPress}
      suppressHighlighting
    >
      {label}
    </T>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: r.button,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  block: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  outline: { borderWidth: 1.5, borderColor: c.lineStrong, backgroundColor: 'transparent' },
  danger: { borderWidth: 1.5, borderColor: c.redInk, backgroundColor: 'transparent' },
  link: { paddingHorizontal: 4, backgroundColor: 'transparent' },
  off: { opacity: 0.45 },
  smallText: { fontSize: 15 },
});
