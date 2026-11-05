import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { c, fontFor, tabular, type, type Variant } from '../design/tokens';
import { useI18n } from '../lib/i18n';

export interface TProps extends TextProps {
  v?: Variant;
  color?: string;
  align?: TextStyle['textAlign'];
}

/**
 * All app text. Picks the design's face for the current language and weight (React Native has no
 * font stacks), and drops the tracked capitals for Bangla, which has no case.
 */
export function T({ v = 'body', color = c.ink, align, style, children, ...rest }: TProps) {
  const { lang } = useI18n();
  const s = type[v];
  const upper = s.upper && lang !== 'bn';
  const tracking = lang === 'bn' ? 0 : s.tracking;
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={rest.maxFontSizeMultiplier ?? 2}
      style={[
        {
          color,
          fontFamily: fontFor(lang, s.weight),
          fontSize: s.size,
          // Bengali's conjuncts and vowel signs need the extra room.
          lineHeight: lang === 'bn' ? Math.round(s.line * 1.12) : s.line,
          ...(tracking ? { letterSpacing: tracking } : {}),
          ...(upper ? { textTransform: 'uppercase' as const } : {}),
          ...(align ? { textAlign: align } : {}),
          ...(v === 'price' || v === 'code' ? tabular : {}),
        },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}
