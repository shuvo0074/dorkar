import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import type { Mode } from '@web/features/needs/modes';

/**
 * Bento Motion: the design's single source of values, from apps/web/DESIGN.md. Screens and the
 * ui/ kit read only from here, so a design branch changes this file and src/design/ and nothing
 * else.
 */
export const designName = 'Bento Motion';

export const c = {
  ground: '#eef0f4',
  paper: '#ffffff',
  /** Opaque surface for sheets and dialogs, which must hide what is under them. */
  sheet: '#ffffff',
  paperShade: '#e2e5ec',
  field: '#f4f5f8',
  fieldFocus: '#ffffff',
  ink: '#0f1020',
  inkSoft: '#4b4e63',
  placeholder: '#6a6d82',
  line: '#e2e5ec',
  lineStrong: '#c5c8d6',
  brand: '#5b3df5',
  brandInk: '#4527d6',
  brandTint: '#ece8fe',
  /** Text and icons on brand. */
  onBrand: '#ffffff',
  hot: '#c6f432',
  hotTint: '#f1fcd0',
  /** Always ink on lime, never white. */
  onHot: '#0f1020',
  /** Links and "this one" (focus, selection ring). */
  accent: '#5b3df5',
  primaryBg: '#0f1020',
  primaryFg: '#ffffff',
  redInk: '#b42318',
  redTint: '#fdeceb',
  badgeBg: '#b42318',
  badgeFg: '#ffffff',
  chatMineBg: '#5b3df5',
  chatMineFg: '#ffffff',
  chatTheirsBg: '#ffffff',
  chatTheirsFg: '#0f1020',
  overlay: 'rgba(15,16,32,0.45)',
  skeleton: '#e2e5ec',
} as const;

export const r = { hero: 30, card: 26, tile: 17, control: 16, button: 16, chip: 999 } as const;

export const space = { gutter: 14, gap: 12, section: 20 } as const;

/** Primary buttons and fields are 52 tall, everything else at least 44. */
export const size = { primary: 52, small: 44, tabBar: 64 } as const;

const shadow = (height: number, radius: number, opacity: number, elevation: number): ViewStyle => ({
  shadowColor: '#0f1020',
  shadowOffset: { width: 0, height },
  shadowRadius: radius,
  shadowOpacity: opacity,
  elevation,
});

export const elevation = {
  card: shadow(8, 24, 0.07, 2),
  lift: shadow(18, 36, 0.14, 8),
} as const;

/** Extra card edge; a hairline on designs whose cards don't stand out by shadow alone. */
export const cardEdge: ViewStyle = {};

export const statusBar: 'light-content' | 'dark-content' = 'dark-content';

export const keyboardAppearance: 'light' | 'dark' = 'light';
export const themeVariant: 'light' | 'dark' = 'light';

type Weight = 400 | 500 | 600 | 700 | 800;
const hind: Record<Weight, string> = {
  400: 'HindSiliguri-Regular',
  500: 'HindSiliguri-Medium',
  600: 'HindSiliguri-SemiBold',
  700: 'HindSiliguri-Bold',
  800: 'HindSiliguri-Bold',
};
/** Manrope's lightest cut here is 500: body text is 500. */
const manrope: Record<Weight, string> = {
  400: 'Manrope-Medium',
  500: 'Manrope-Medium',
  600: 'Manrope-SemiBold',
  700: 'Manrope-Bold',
  800: 'Manrope-ExtraBold',
};

/** Manrope for Latin; Bangla uses Hind Siliguri for everything. */
export const fontFor = (lang: 'en' | 'bn', weight: Weight) =>
  (lang === 'bn' ? hind : manrope)[weight];

export type Variant =
  | 'display'
  | 'title'
  | 'section'
  | 'body'
  | 'bodyStrong'
  | 'small'
  | 'label'
  | 'button'
  | 'price'
  | 'code';

export const type: Record<
  Variant,
  { size: number; line: number; weight: Weight; tracking?: number; upper?: boolean }
> = {
  display: { size: 34, line: 36, weight: 800, tracking: -1.2 },
  title: { size: 28, line: 32, weight: 800, tracking: -0.8 },
  section: { size: 20, line: 26, weight: 800, tracking: -0.4 },
  body: { size: 16, line: 24, weight: 500 },
  bodyStrong: { size: 16, line: 24, weight: 700 },
  small: { size: 14, line: 20, weight: 500 },
  label: { size: 13, line: 18, weight: 700, tracking: 0.8, upper: true },
  button: { size: 17, line: 22, weight: 800 },
  price: { size: 20, line: 26, weight: 800, tracking: -0.4 },
  code: { size: 12, line: 16, weight: 700, tracking: 0.3 },
};

/** Tabular digits where the platform can. */
export const tabular: TextStyle = Platform.OS === 'ios' ? { fontVariant: ['tabular-nums'] } : {};

/** Each need mode keeps its own tile tint so a list reads at a glance. */
export const modeTint: Record<Mode, string> = {
  BUY: '#f1fcd0',
  RENT: '#fff1c7',
  BORROW: '#e4ecff',
  HIRE: '#ece8fe',
  SOURCE: '#ffe9d6',
};
