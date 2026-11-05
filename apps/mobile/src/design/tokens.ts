import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import type { Mode } from '@web/features/needs/modes';

/**
 * Aurora Glass: the design's single source of values, from apps/web/DESIGN.md. Screens and the
 * ui/ kit read only from here, so a design branch changes this file and src/design/ and nothing
 * else.
 */
export const designName = 'Aurora Glass';

export const c = {
  ground: '#07080f',
  /** Cards are glass: they show the aurora through. */
  paper: 'rgba(255,255,255,0.065)',
  /** Opaque surface for sheets and dialogs, which must hide what is under them. */
  sheet: '#0d0f18',
  paperShade: 'rgba(255,255,255,0.08)',
  field: 'rgba(255,255,255,0.06)',
  fieldFocus: 'rgba(255,255,255,0.11)',
  ink: '#f3f5fa',
  inkSoft: '#b8bed0',
  placeholder: '#8d94a8',
  line: 'rgba(255,255,255,0.1)',
  lineStrong: 'rgba(255,255,255,0.2)',
  /** The glow: links, focus, active tab, "this one". */
  brand: '#9ff3e4',
  brandInk: '#9ff3e4',
  brandTint: 'rgba(159,243,228,0.14)',
  /** Anything filled with glow or white takes dark type. */
  onBrand: '#07080f',
  hot: '#9ff3e4',
  hotTint: 'rgba(255,79,163,0.18)',
  onHot: '#07080f',
  accent: '#9ff3e4',
  primaryBg: '#f3f5fa',
  primaryFg: '#07080f',
  redInk: '#ff9b8a',
  redTint: 'rgba(255,110,90,0.14)',
  badgeBg: '#ff9b8a',
  badgeFg: '#07080f',
  chatMineBg: '#9ff3e4',
  chatMineFg: '#07080f',
  chatTheirsBg: 'rgba(255,255,255,0.09)',
  chatTheirsFg: '#f3f5fa',
  overlay: 'rgba(0,0,0,0.6)',
  skeleton: 'rgba(255,255,255,0.1)',
} as const;

export const r = { hero: 28, card: 24, tile: 18, control: 14, button: 16, chip: 999 } as const;

export const space = { gutter: 16, gap: 12, section: 20 } as const;

/** Primary buttons and fields are 52 tall, everything else at least 44. */
export const size = { primary: 52, small: 44, tabBar: 64 } as const;

const shadow = (height: number, radius: number, opacity: number, elevation: number): ViewStyle => ({
  shadowColor: '#000000',
  shadowOffset: { width: 0, height },
  shadowRadius: radius,
  shadowOpacity: opacity,
  elevation,
});

export const elevation = {
  /** A shadow under translucent glass would show through it: glass cards get a light edge instead. */
  card: {} as ViewStyle,
  lift: shadow(0, 18, 0.55, 0),
} as const;

/** Extra card edge; a hairline on designs whose cards don't stand out by shadow alone. */
export const cardEdge: ViewStyle = { borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)' };

export const statusBar: 'light-content' | 'dark-content' = 'light-content';

export const keyboardAppearance: 'light' | 'dark' = 'dark';
export const themeVariant: 'light' | 'dark' = 'dark';

type Weight = 400 | 500 | 600 | 700 | 800;
const hind: Record<Weight, string> = {
  400: 'HindSiliguri-Regular',
  500: 'HindSiliguri-Medium',
  600: 'HindSiliguri-SemiBold',
  700: 'HindSiliguri-Bold',
  800: 'HindSiliguri-Bold',
};
const grotesk: Record<Weight, string> = {
  400: 'SpaceGrotesk-Regular',
  500: 'SpaceGrotesk-Medium',
  600: 'SpaceGrotesk-SemiBold',
  700: 'SpaceGrotesk-Bold',
  800: 'SpaceGrotesk-Bold',
};

/** Space Grotesk for Latin; it has no Bengali, so Bangla uses Hind Siliguri. */
export const fontFor = (lang: 'en' | 'bn', weight: Weight) =>
  (lang === 'bn' ? hind : grotesk)[weight];

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
  display: { size: 44, line: 44, weight: 700, tracking: -1.9 },
  title: { size: 28, line: 32, weight: 700, tracking: -0.8 },
  section: { size: 20, line: 26, weight: 700, tracking: -0.3 },
  body: { size: 16, line: 24, weight: 400 },
  bodyStrong: { size: 16, line: 24, weight: 600 },
  small: { size: 14, line: 20, weight: 400 },
  label: { size: 13, line: 18, weight: 700, tracking: 0.8, upper: true },
  button: { size: 17, line: 22, weight: 700 },
  price: { size: 20, line: 26, weight: 700 },
  code: { size: 12, line: 16, weight: 600, tracking: 0.3 },
};

/** Tabular digits where the platform can. */
export const tabular: TextStyle = Platform.OS === 'ios' ? { fontVariant: ['tabular-nums'] } : {};

/** Each need mode keeps its own tile tint so a list reads at a glance. */
export const modeTint: Record<Mode, string> = {
  BUY: 'rgba(255,79,163,0.18)',
  RENT: 'rgba(255,214,102,0.16)',
  BORROW: 'rgba(124,92,255,0.24)',
  HIRE: 'rgba(159,243,228,0.14)',
  SOURCE: 'rgba(196,181,253,0.18)',
};
