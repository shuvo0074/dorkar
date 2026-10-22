---
name: Dorkar
description: A demand-first marketplace laid out as a bento board of rounded cards, with short springy motion.
colors:
  ground: '#eef0f4'
  paper: '#ffffff'
  paper-shade: '#e2e5ec'
  field: '#f4f5f8'
  ink: '#0f1020'
  ink-soft: '#4b4e63'
  line: '#e2e5ec'
  line-strong: '#c5c8d6'
  brand: '#5b3df5'
  brand-ink: '#4527d6'
  brand-tint: '#ece8fe'
  hot: '#c6f432'
  hot-tint: '#f1fcd0'
  red-ink: '#b42318'
  red-tint: '#fdeceb'
typography:
  latin: "'Manrope', 'Hind Siliguri', system-ui, sans-serif"
  bangla: "'Hind Siliguri', 'Manrope', system-ui, sans-serif"
  display:
    fontSize: 'clamp(2rem, 8.8vw, 3.6rem)'
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: '-0.035em'
  page-title:
    fontSize: 'clamp(1.9rem, 7vw, 2.8rem)'
    fontWeight: 800
  body:
    fontSize: '1rem'
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontSize: '0.8rem'
    fontWeight: 700
    letterSpacing: '0.06em'
    textTransform: 'uppercase (none in Bangla)'
rounded:
  hero-card: '30px'
  card: '26px'
  tile: '17px'
  control: '16px'
  chip: '999px'
motion:
  spring: 'cubic-bezier(0.3, 1.4, 0.4, 1)'
  out: 'cubic-bezier(0.16, 1, 0.3, 1)'
spacing:
  gutter: 'clamp(14px, 4vw, 40px)'
  tab-bar: '64px floating, 10px above the safe-area inset'
  touch: '44px minimum, 52px for primary buttons and fields'
---

# Design System: Dorkar

## Overview

**North star: "Bento Motion".** The marketplace as a board of rounded cards of mixed sizes. The
one thing to do on a screen sits on the ink-dark card; links and state are violet; the thing you
picked is lime. Every tap gets a short, springy answer: tiles grow, cards lift, buttons squash.
It suits the urban, smartphone-native end of the audience while staying light enough for a
mid-range phone.

## Colour

- **Ground and cards.** Cool grey `ground`, white `paper` cards with a soft two-layer shadow.
- **Ink** is the text colour, the home hero card, the chosen mode tile, the active tab icon and
  primary buttons.
- **Violet (`brand`)** carries links, focus rings, the selection ring, chat bubbles you sent and
  quiet badges (`brand-tint`). White on violet passes AA.
- **Lime (`hot`)** marks the thing you picked: the Post button, the account pill, the first
  dashboard figure, the hero kicker and one browse tile. Always ink on lime, never white.
- **Warnings** use `red-ink` text on `red-tint`.
- Need modes keep their own tile tints (Buy lime, Rent yellow, Borrow blue, Hire violet,
  Source peach).

## Type

Manrope for Latin, heavy (800) and tightly tracked for headings, 500 for body text. Bangla uses
Hind Siliguri for everything (the page switches family when the language is Bangla), at 700 for
headings and without negative tracking.

## Layout and components

- **Header:** no bar; the wordmark **dorkar.** (violet dot) and **দরকার** sit on the ground,
  with a white language button. From 900px the navigation is a white pill with the current page
  in ink, and Sign in / Account is a lime pill.
- **Home (bento):** dark hero card (lime kicker, title, lede), the composer card, four browse
  tiles (lime, violet, white, ink), the latest needs card and the how-it-works card. On desktop
  the hero and the browse tiles share the first row; the composer sits under the hero and the
  needs list runs down the right.
- **Mode tiles:** a track of five; the chosen tile turns ink and grows to show its name while the
  others shrink to icons (their names stay in the accessibility tree). Under 360px every tile
  shows its name under the icon instead.
- **Tab bar (phones):** a floating white pill 10px above the safe area: Home, Inbox, a raised lime
  **Post** square in the middle, Dashboard, Account. The active tab's icon sits on an ink pill.
- **Lists, filters, forms, chat:** as white cards; on phones the browse filters fold behind
  **Show filters**, primary actions fill the width.

## Motion

Spring easing for anything that moves (tile growth, card lift, button squash, the Post button
turning on hover); home cards rise in with a short stagger. Everything collapses to near-instant
under `prefers-reduced-motion`.

## Accessibility

WCAG 2.2 AA: body text 8:1, no white on lime, focus is a 2.5px violet ring, every control is at
least 44px, inputs are 16px+ so phones do not zoom, and layouts reflow to one column at 200% zoom.
