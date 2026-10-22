---
name: Dorkar
description: A demand-first marketplace drawn at night, frosted glass over slow aurora light.
colors:
  ground: '#07080f'
  glass: 'rgb(255 255 255 / 0.065)'
  glass-strong: 'rgb(255 255 255 / 0.11)'
  field: 'rgb(255 255 255 / 0.06)'
  ink: '#f3f5fa'
  ink-soft: '#b8bed0'
  line: 'rgb(255 255 255 / 0.1)'
  line-strong: 'rgb(255 255 255 / 0.2)'
  on-accent: '#07080f'
  glow: '#9ff3e4'
  glow-tint: 'rgb(159 243 228 / 0.14)'
  violet: '#7c5cff'
  pink: '#ff4fa3'
  red-ink: '#ff9b8a'
  red-tint: 'rgb(255 110 90 / 0.14)'
typography:
  latin: "'Space Grotesk', 'Hind Siliguri', system-ui, sans-serif"
  bengali: "'Hind Siliguri' (Space Grotesk has no Bengali; the stack falls through to it)"
  display:
    fontSize: 'clamp(2.4rem, 11vw, 4.4rem)'
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: '-0.045em'
  page-title:
    fontSize: 'clamp(1.9rem, 7vw, 2.8rem)'
    fontWeight: 700
    letterSpacing: '-0.03em'
  body:
    fontSize: '1rem'
    lineHeight: 1.5
  label:
    fontSize: '0.8rem'
    fontWeight: 700
    letterSpacing: '0.06em'
    textTransform: 'uppercase (none in Bangla)'
rounded:
  card: '24px'
  hero-card: '28px'
  tile: '18px'
  control: '14px'
  button: '16px'
  chip: '999px'
spacing:
  gutter: 'clamp(16px, 4vw, 40px)'
  tab-bar: '64px + safe-area-inset-bottom'
  touch: '44px minimum, 52px for primary buttons and fields'
---

# Design System: Dorkar

## Overview

**North star: "Aurora Glass".** The app lives on a near-black night. Three soft lights (glow
cyan, violet, pink) drift very slowly behind the page, and everything you read or touch sits on
frosted glass above them. One colour, the glow, means "this one": the chosen mode, the active
tab, links, focus and the Post button. Everything else is white type at two strengths.

## Colour

- **Night and glass.** The page is `ground`. Cards are `glass` with a 1px light inner edge and a
  deep shadow (both in `--shadow`). Fields are `field`, turning `glass-strong` with a glow border
  when focused.
- **Glow** carries links, focus rings, the selection ring, the active tab pill, the chosen mode
  tile and the raised Post button. Anything filled with glow or white uses `on-accent` (dark)
  type.
- **Violet and pink** only appear in the aurora and in mode tints; they never carry text.
- **Warnings** use `red-ink` on `red-tint`; count badges are dark type on `red-ink`.
- A veil (`rgb(7 8 15 / 0.28)`) over the aurora keeps `ink-soft` above 7:1 on glass wherever a
  light drifts.

## Type

Space Grotesk for Latin (tight negative tracking on display sizes), Hind Siliguri for Bengali
through the font stack. Headings are bold and sentence case; small labels are uppercase with
tracking in English and plain in Bangla. Prices and codes use tabular numbers.

## Layout and components

- **App bar:** sticky dark glass with a glow "d" badge before the wordmark and the language
  switch; top navigation (the current page as a white pill) and a glow Sign in/Account pill
  from 900px.
- **Tab bar (phones):** near-opaque dark glass so content never ghosts through; Home, Inbox, a
  raised glowing **Post** button, Dashboard, Account. The active tab gets a glow pill behind its
  icon. Respects the safe-area inset.
- **Mode tiles:** five glass tiles; a glow pill slides under the chosen one (CSS only, with a
  plain fill fallback where `:has()` is missing). Arrow keys move the choice.
- **Home:** large two-line title on the night, then the composer as the main glass card;
  on desktop the latest needs sit in a second glass card beside it.
- **Lists, filters, forms, chat:** as in the shared structure (rows with tinted mode tiles,
  filters folded behind Show filters on phones, each form section its own card); your own chat
  bubbles are glow with dark type.

## Motion and performance

The aurora uses radial gradients moved with transforms only (no filter blur), so it stays cheap
on mid-range phones; backdrop blur is limited to the app bar, tab bar and the hero card. Tiles
squash on press, the glow pill springs between tiles, buttons glow on hover. Under
`prefers-reduced-motion` the aurora stops and transitions collapse.

## Accessibility

WCAG 2.2 AA: `ink` 18:1 and `ink-soft` 10:1 on the night (7:1+ on glass), dark type on every
glow or white fill, 2.5px glow focus ring, 44px minimum targets, 16px+ inputs, single column at
200% zoom, `color-scheme: dark` so native pickers match.
