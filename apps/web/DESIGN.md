---
name: Dorkar
description: A demand-first marketplace drawn as the pocket wallet every Bangladeshi phone user already knows.
colors:
  ground: '#f2f5f3'
  paper: '#ffffff'
  paper-shade: '#e9eeeb'
  field: '#f7f9f8'
  ink: '#121417'
  ink-soft: '#4a5350'
  line: '#dfe5e2'
  line-strong: '#c6d1cc'
  brand: '#0b6e4f'
  brand-ink: '#08553d'
  brand-tint: '#e3f2ec'
  hot: '#ff5a36'
  hot-tint: '#ffe6df'
  red-ink: '#b3361a'
  red-tint: '#fdece7'
typography:
  family: "'Hind Siliguri', system-ui, sans-serif (Latin and Bengali in one family)"
  display:
    fontSize: 'clamp(2rem, 8.6vw, 3.4rem)'
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: '-0.015em'
  page-title:
    fontSize: 'clamp(1.9rem, 7vw, 2.8rem)'
    fontWeight: 700
  section-title:
    fontSize: 'clamp(1.2rem, 3vw, 1.45rem)'
    fontWeight: 700
  body:
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontSize: '0.8rem'
    fontWeight: 700
    letterSpacing: '0.06em'
    textTransform: 'uppercase (none in Bangla)'
  button:
    fontSize: '1.05rem'
    fontWeight: 700
rounded:
  card: '20px'
  hero-card: '24px'
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

**North star: "Pocket Wallet".** Dorkar works like the mobile-money and recharge-shop apps in
everyone's pocket: a green app bar, big service tiles, one task per screen, white cards on a pale
ground, and a clear receipt-like confirmation for every action. It is chosen for the main
audience: everyday consumers on mid-range Android phones, one thumb, often in sunlight.

The look must stay Dorkar's own: the green is a deep forest green (not a wallet brand's pink,
orange or purple), the wordmark is lowercase **dorkar** beside **দরকার**, and coral marks the one
thing you picked.

## Colour

- **Ground and cards.** The page is `ground`; content sits on white `paper` cards with a soft
  two-layer shadow. Fields use `field` with a `line-strong` border and turn white with a green
  ring when focused.
- **Brand green** is the app bar, the home hero band, links, the active tab, focus rings and the
  selection ring. `brand-tint` fills icon tiles and quiet badges.
- **Coral (`hot`)** fills only the chosen mode tile and the raised Post button, always with ink
  text and icons on it (white on coral fails contrast).
- **Warnings** use `red-ink` text on `red-tint`; badges with counts use white on `red-ink`.
- Each need mode keeps its own tile tint (Buy coral, Rent yellow, Borrow blue, Hire green, Source
  violet) so a list reads at a glance.

## Type

One family, Hind Siliguri, covers Latin and Bengali, so both languages share one rhythm. Headings
are bold and sentence case. Small section labels are uppercase with tracking in English and plain
in Bangla. Prices and codes use tabular numbers.

## Layout and components

- **App bar:** green, wordmark left, language switch right; top navigation and the account pill
  appear from 900px. On the home page the bar continues into a full-bleed hero band with
  rounded bottom corners on phones, and the composer card overlaps it.
- **Tab bar (phones):** Home, Inbox, a raised coral **Post** button in the middle, Dashboard,
  Account. Signed-out visitors see Home, Post and Sign in, with Post kept centred. The active tab
  gets a green pill behind its icon. Respects the safe-area inset.
- **Mode tiles:** five equal tiles with a line icon and label; arrow keys move the choice (radio
  group). The chosen tile fills coral and lifts.
- **Lists ("ledgers"):** a white card of rows: 48px tinted icon tile, title and meta, action on
  the right; on phones actions drop under the text.
- **Catalog:** needs show as rows with a mode tile; listings with photos show as a two-column
  card grid with the photo on top.
- **Filters:** on phones the filter form folds behind a **Show filters** button so results come
  first, and the mode chips scroll sideways on one line.
- **Forms:** each numbered section is its own card; on phones primary actions fill the width.
- **Buttons:** ink primary, white outline secondary, red-ink outline for danger; 52px tall
  (44px small); press scales to 0.97.
- **Chat:** bubbles on a pale panel; your own messages in brand green.

## Motion

Short and springy: tiles lift on hover and squash on press, the selection ring pops in, cards
lift on hover. All of it collapses under `prefers-reduced-motion`.

## Accessibility

WCAG 2.2 AA: body text 7:1+, coral never carries white text, focus is a 2.5px green ring (white on
the green bar), every control is at least 44px, inputs are 16px+ so phones do not zoom, and the
layout reflows to a single column at 200% zoom.
