import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import type { Mode } from '@web/features/needs/modes';

/**
 * Pocket Wallet: the design's single source of values, from apps/web/DESIGN.md. Screens and the
 * ui/ kit read only from here, so a design branch changes this file and src/design/ and nothing
 * else.
 */
export const designName = 'Pocket Wallet';

export const c = {
  ground: '#f2f5f3',
  paper: '#ffffff',
  /** Opaque surface for sheets and dialogs, which must hide what is under them. */
  sheet: '#ffffff',
  paperShade: '#e9eeeb',
  field: '#f7f9f8',
  fieldFocus: '#ffffff',
  ink: '#121417',
  inkSoft: '#4a5350',
  placeholder: '#6b7572',
  line: '#dfe5e2',
  lineStrong: '#c6d1cc',
  brand: '#0b6e4f',
  brandInk: '#08553d',
  brandTint: '#e3f2ec',
  /** Text and icons on brand. */
  onBrand: '#ffffff',
  hot: '#ff5a36',
  hotTint: '#ffe6df',
  /** Never white on coral: it fails contrast. */
  onHot: '#121417',
  /** Links and "this one" (focus, selection ring, active tab). */
  accent: '#0b6e4f',
  primaryBg: '#121417',
  primaryFg: '#ffffff',
  redInk: '#b3361a',
  redTint: '#fdece7',
  badgeBg: '#b3361a',
  badgeFg: '#ffffff',
  chatMineBg: '#0b6e4f',
  chatMineFg: '#ffffff',
  chatTheirsBg: '#ffffff',
  chatTheirsFg: '#121417',
  overlay: 'rgba(18,20,23,0.45)',
  skeleton: '#e6ece9',
} as const;

export const r = { hero: 24, card: 20, tile: 18, control: 14, button: 16, chip: 999 } as const;

export const space = { gutter: 16, gap: 12, section: 20 } as const;

/** Primary buttons and fields are 52 tall, everything else at least 44. */
export const size = { primary: 52, small: 44, tabBar: 64 } as const;

const shadow = (height: number, radius: number, opacity: number, elevation: number): ViewStyle => ({
  shadowColor: '#121417',
  shadowOffset: { width: 0, height },
  shadowRadius: radius,
  shadowOpacity: opacity,
  elevation,
});

export const elevation = {
  card: shadow(6, 20, 0.07, 2),
  lift: shadow(14, 30, 0.12, 6),
} as const;

/** Extra card edge; a hairline on designs whose cards don't stand out by shadow alone. */
export const cardEdge: ViewStyle = {};

export const statusBar: 'light-content' | 'dark-content' = 'light-content';

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

/** One family covers Latin and Bengali, so both languages share one rhythm. */
export const fontFor = (_lang: 'en' | 'bn', weight: Weight) => hind[weight];

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
  display: { size: 34, line: 38, weight: 700, tracking: -0.4 },
  title: { size: 28, line: 34, weight: 700 },
  section: { size: 20, line: 26, weight: 700 },
  body: { size: 16, line: 24, weight: 400 },
  bodyStrong: { size: 16, line: 24, weight: 600 },
  small: { size: 14, line: 20, weight: 400 },
  label: { size: 13, line: 18, weight: 700, tracking: 0.8, upper: true },
  button: { size: 17, line: 22, weight: 700 },
  price: { size: 20, line: 26, weight: 700 },
  code: { size: 12, line: 16, weight: 600, tracking: 0.4 },
};

/** Tabular digits where the platform can. */
export const tabular: TextStyle = Platform.OS === 'ios' ? { fontVariant: ['tabular-nums'] } : {};

/** Each need mode keeps its own tile tint so a list reads at a glance. */
export const modeTint: Record<Mode, string> = {
  BUY: '#ffe6df',
  RENT: '#fff1c7',
  BORROW: '#e4ecff',
  HIRE: '#e3f2ec',
  SOURCE: '#efe7fb',
};
