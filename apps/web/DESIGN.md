---
name: Dorkar
description: A demand-first marketplace drawn as a printed need catalog on newsprint, circled in ballpoint.
colors:
  newsprint: '#e6e2d8'
  newsprint-shade: '#dcd7cb'
  ink: '#111111'
  ink-soft: '#3a3833'
  newsprint-mid: '#b9b5ad'
  hall-red: '#c8322d'
  hall-red-ink: '#a8241f'
  biro-blue: '#24398f'
typography:
  display:
    fontFamily: "Anton, 'Noto Sans Bengali Variable', 'Arial Narrow', sans-serif"
    fontSize: 'clamp(3.4rem, 15vw, 6rem)'
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: '0.01em'
  headline:
    fontFamily: "Anton, 'Noto Sans Bengali Variable', 'Arial Narrow', sans-serif"
    fontSize: 'clamp(1.8rem, 4vw, 2.3rem)'
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: '0.01em'
  title:
    fontFamily: "Anton, 'Noto Sans Bengali Variable', 'Arial Narrow', sans-serif"
    fontSize: '1.5rem'
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '0.01em'
  label:
    fontFamily: "Anton, 'Noto Sans Bengali Variable', 'Arial Narrow', sans-serif"
    fontSize: '1.2rem'
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '0.03em'
  button:
    fontFamily: "Anton, 'Noto Sans Bengali Variable', 'Arial Narrow', sans-serif"
    fontSize: '1.45rem'
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '0.04em'
  body:
    fontFamily: "'Courier Prime', 'Noto Sans Bengali Variable', 'Courier New', monospace"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "'Courier Prime', 'Noto Sans Bengali Variable', 'Courier New', monospace"
    fontSize: '1rem'
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '0.02em'
    fontFeature: "'tnum' 1"
  bangla-display:
    fontFamily: "'Noto Sans Bengali Variable', sans-serif"
    fontWeight: 760
    lineHeight: 1.08
    letterSpacing: '0'
    fontVariation: "'wdth' 68"
rounded:
  plate: '0px'
  tag: '3px'
  ctl: '4px'
  box: '4px'
spacing:
  xs: '8px'
  sm: '14px'
  md: '18px'
  lg: '32px'
  xl: '48px'
  gutter: 'clamp(16px, 4vw, 40px)'
  nav: '64px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.newsprint}'
    typography: '{typography.button}'
    rounded: '{rounded.ctl}'
    padding: '6px 22px 4px'
    height: '52px'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.button}'
    rounded: '{rounded.ctl}'
    padding: '6px 22px 4px'
    height: '52px'
  button-danger:
    backgroundColor: 'transparent'
    textColor: '{colors.hall-red-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.ctl}'
    padding: '6px 22px 4px'
    height: '52px'
  button-small:
    rounded: '{rounded.ctl}'
    padding: '4px 14px 2px'
    height: '44px'
  field:
    backgroundColor: '#eeebe4'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.ctl}'
    padding: '14px'
    height: '56px'
  mode-key-tile:
    backgroundColor: '{colors.hall-red}'
    textColor: '{colors.newsprint}'
    typography: '{typography.display}'
    height: '44px'
  mode-key-tile-selected:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.newsprint}'
  catalog-plate:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.plate}'
  alert:
    backgroundColor: 'transparent'
    textColor: '{colors.hall-red-ink}'
    typography: '{typography.code}'
    rounded: '{rounded.ctl}'
    padding: '12px 14px'
  bottom-nav:
    backgroundColor: '{colors.newsprint}'
    textColor: '{colors.ink}'
    height: '64px'
---

# Design System: Dorkar

## Overview

**Creative North Star: "The Circle Catalog"**

Dorkar is drawn as a printed convention catalog on cheap newsprint: every Need is a numbered square with a postage-stamp etching, coded by mode letter, and the reader circles what matters in ballpoint. The page is ink on paper and nothing else. Black ink carries the type, rules and drawings. One hall red carries codes, keys and structural rules. One ballpoint blue is the only hand on the page, and it only ever draws loops, wavy underlines and focus.

Density is a catalog's density: tight ruled grids of small plates with terse monospace captions, set against one or two very large condensed headlines per screen. Depth is printed, never lit. Solid ink areas wear the way press ink wears (a procedural speckle mask), stamp drawings wobble slightly through an ink-print filter, and the paper carries a faint fibre grain. There are no shadows, no gradients and no translucent layers. State is shown the way a printer would show it: a second ruled frame, an ink fill replacing red, a ballpoint circle.

The world rejects the marketplace category's listing grid with a search bar, photo cards and promo carousel. It is built for slow phones and bright sunlight: high-contrast ink on light paper, 44px+ touch targets, one font file per role.

**Key Characteristics:**

- Newsprint ground with paper grain; ink black for everything structural.
- Anton condensed caps for display; Courier Prime for catalog text and codes; Noto Sans Bengali condensed for Bangla display.
- Ruled boxes (2px and 1.5px ink rules), 4px corners on controls and boxes, square stamp plates.
- Printed-ink wear on solid fills; etched 48-unit line drawings through the ink-print filter.
- One ballpoint loop that draws on once, and is the only motion in the world.

## Colors

A three-ink press run on newsprint: black, one red, one ballpoint blue, with every color role fenced by its contrast.

### Primary

- **Ink Black** (`ink`): All text, rules, box borders, stamp drawings, the primary button fill and the selected mode tile. 14.6:1 on newsprint.
- **Ink Soft** (`ink-soft`): Secondary text: hints, meta lines under catalog entries, definition-list terms, footnotes. 9.0:1 on newsprint; still legible in sunlight.

### Secondary

- **Hall Red** (`hall-red`): Fills and large type only. The masthead rule (3px), the danger-zone rule (3px), the mode key tiles, the active top-nav underline, the big step numerals. 4.1:1 on newsprint, so it passes only for large display type (Anton at 1.5rem+) and non-text marks. Never body or caption text.
- **Hall Red Ink** (`hall-red-ink`): The red for small text and thin strokes: error alerts, invalid field borders, the danger button, the confirm box border. 5.5:1 on newsprint.

### Tertiary

- **Biro Blue** (`biro-blue`): The hand. Ballpoint loops, the wavy underline on a welcome line, the "this device" annotation inside its loop, the text caret, and the focus ring (2.5px outline, 3px offset). 7.9:1 on newsprint. Nothing printed is ever blue.

### Neutral

- **Newsprint** (`newsprint`): The page ground, overlaid with an 180px turbulence grain tile (9% alpha, warm). Also the text color on ink and red fills, and the theme-color.
- **Newsprint Shade** (`newsprint-shade`): Hover fill on quiet controls (language toggle), scrollbar track.
- **Newsprint Mid** (`newsprint-mid`): Loading skeleton dashes only. 1.6:1; never text.
- **Field Paper** (newsprint mixed 70% with white, about #eeebe4): The inside of text fields and OTP boxes, a slightly brighter sheet so the writable area reads. Placeholder text on it is #5f5b52 (5.0:1).

### Named Rules

**The Three Inks Rule.** Black prints, red codes, blue is the hand. A new surface gets no fourth hue; status, success and emphasis are expressed in ink weight, rules and the ballpoint loop.

**The Red Size Rule.** `hall-red` appears only as fills, rules and type at 1.5rem or larger. Any red under that size is `hall-red-ink`.

**The Hand-Only Blue Rule.** `biro-blue` is reserved for things a person would draw with a pen on the printed page, plus keyboard focus and the caret. Buttons, links, icons and headings are never blue.

## Typography

**Display Font:** Anton (with Noto Sans Bengali Variable, Arial Narrow)
**Body Font:** Courier Prime 400 and 700 (with Noto Sans Bengali Variable, Courier New)
**Bangla Display:** Noto Sans Bengali Variable, condensed through its width axis

**Character:** A heavy condensed poster face shouting in caps over a typewriter that reads like catalog small print. The contrast is the hierarchy; there is no third family and no medium weights in Latin.

### Hierarchy

- **Display** (Anton 400, clamp(3.4rem, 15vw, 6rem), 0.98): One page title per screen ("WHAT DO YOU NEED?", "YOUR ACCOUNT"), uppercase, balanced wrap, max 7ch on phones and 12ch on desktop for the home title. Sign-in and not-found go to 6.5rem and 7rem.
- **Headline** (Anton 400, clamp(1.8rem, 4vw, 2.3rem), 0.98): Section heads, always sitting on a 1.5px ink rule (2px when a ledger follows), with an optional right-aligned Courier note at 0.85rem in ink-soft.
- **Title** (Anton 400, 1.5rem, 1): Step titles and sub-heads.
- **Label** (Anton 400, 1.2rem, 0.03em, uppercase): Field labels, definition terms (1.1rem in ink-soft), mode names (1.05rem), nav items (1.3rem top, 0.95rem bottom).
- **Body** (Courier Prime 400, 1rem, 1.5): Ledes at 1.05 to 1.08rem capped at 44ch; hints 0.92rem; catalog captions 0.82rem uppercase with meta at 0.78rem.
- **Code** (Courier Prime 700, tabular numerals, 0.02em): Catalog codes (B-01, S-05), member and session codes, the field prefix. Large member codes switch to Anton at 2.4rem.

### Bangla (`:lang(bn)`)

Anton has no Bengali, so Bangla display falls through to Noto Sans Bengali Variable, set condensed and heavy: headings and `.display` at width 68% / weight 760 / line-height 1.08 / no tracking; labels at width 75% / 700 / 1.05rem; buttons at 78% / 700 / 1.2rem; mode names 75% / 650; nav 80% / 650. The wordmark's দরকার is 66% / 780 at 0.82em. Bangla body text keeps Courier's fallback to Noto and opens line-height to 1.65. Catalog titles drop uppercase in Bangla.

### Named Rules

**The Caps Are Latin Rule.** Uppercase and positive tracking apply to Latin only. Every display or label style that sets tracking or caps must carry a `:lang(bn)` counterpart that resets tracking to 0 and sets width and weight explicitly.

**The No Synthesis Rule.** `font-synthesis: none`. Weights that do not exist as files (Anton bold, Courier medium) are never faked.

## Layout

A single column on phones, a two-column catalog spread from 900px. The shell is centered at max 1280px with a fluid gutter (clamp(16px, 4vw, 40px)). Under 900px a fixed three-item thumb bar (64px plus safe-area inset) carries navigation and the shell reserves bottom padding for it; at 900px the bar disappears, the top nav and the masthead tagline (one line per sentence) appear.

The masthead is wordmark left, tagline center, nav right, all bottom-aligned over a 3px hall-red rule. Home at 900px is a 5fr / 6fr grid: composer and how-it-works left, the catalog right behind a 1.5px vertical ink rule with 40px inset. Account becomes two equal columns with the header, member card, actions and danger zone spanning both.

The catalog is an auto-fill grid of plates, min 96px (gap 18px / 12px) on phones and min 112px (22px / 16px) on desktop. Ledger rows collapse their action under the text below 520px. Vertical rhythm steps through 8, 14, 18, 32 to 48px; page sections are 44 to 48px apart.

## Elevation & Depth

Flat. There is no `box-shadow` used for depth anywhere and no gradient. Depth and material come from print: the paper grain on the ground, the ink-wear mask on solid fills, the ink-print filter on drawings, and rule weight (3px red > 2px ink > 1.5px hairline) for hierarchy. The only `box-shadow` values in the system are two-ring spread outlines with zero offset and zero blur, used to draw a second ruled frame as a state.

### Materials

- **Ink wear** (`--ink-wear`): a 160px SVG fractal-noise mask (baseFrequency .32, 3 octaves, alpha threshold -14 / 11.4) applied as `mask-image` to solid ink and red fills (primary button fill, mode key tiles) so they speckle like worn press ink. Applied on a pseudo-element behind the label so text and focus rings stay crisp.
- **Ink print** (`#ink-print`, rendered once by the app shell): displacement (scale 1.3) plus a fine wear knock-out, applied with `filter: url(#ink-print)` to catalog plate and member badge drawings only.
- **Paper grain**: the body background tile; never repeated on components.

### Named Rules

**The Second Frame Rule.** Hover, press and focus-within are shown as a second ink frame 3px outside the first (`0 0 0 3px newsprint, 0 0 0 5px ink`), never as a lift, glow or color shift. The danger button frames in `hall-red-ink`; the active OTP box frames in `biro-blue`.

**The Crisp Type Rule.** Wear and print filters touch fills and drawings, never text, never focus rings.

## Shapes

Ruled rectangles. Controls and boxes (buttons, fields, OTP boxes, mode key, alerts, panels, confirm boxes, language toggle) have barely softened 4px corners. Stamp plates (catalog art, ledger art, member badge) are hard square boxes with no radius, like postage-stamp frames. The small inline tag inside a button is 3px. Borders are 2px ink for controls and panels, 1.5px ink for plates, dividers and inner key separators.

### The Drawing System

All illustrations and icons are SVG line etchings on one 48-unit plate (`viewBox 0 0 48 48`), drawn in one hand with three stroke weights: contour 2 (2.3 for a dominant member), detail 1.3, hatch shading 0.8 with butt caps. Round caps and joins elsewhere. Solid marks are small ink dots. Drawings sit at 70 to 74% of their plate and are decorative (`aria-hidden`); adjacent text names the thing. Navigation icons are the same hand plus a `navdot` circle that fills with ink on the current route. Not every drawing needs hatching (the member badge figure and laptop have none).

### The Ballpoint Loop

One loop shape (16 points on a 100×60 box, overshooting its start like a real pen stroke), re-plotted in real pixels for whatever it circles so the 2.2px blue line keeps one weight at any size, tilted -2 to -3 degrees. It is positioned absolutely with an `inset` that bleeds 6 to 24px past its target, and ignores pointer events.

## Components

### Buttons

Thick, printed, uppercase Anton.

- **Shape:** gently cornered (4px), 2px ink border, min height 52px (44px small), padding 6px 22px 4px (optical, Anton sits high).
- **Primary:** solid ink fill carrying the ink-wear mask, newsprint text. One per view: POST NEED, SEND CODE.
- **Secondary:** outlined, transparent, ink text.
- **Danger:** outlined in `hall-red-ink` with red-ink text (SIGN OUT EVERYWHERE); lives under a 3px hall-red rule.
- **Hover / Active:** the Second Frame (160ms, ease cubic-bezier(0.16, 1, 0.3, 1)). No color change.
- **Disabled:** 55% opacity, not-allowed cursor; a "SOON" tag (1.5px outlined, 3px corners, 0.7em) explains coming features rather than hiding them.
- **Link button:** Courier text with a 1.5px underline, 0.2em offset.

### Inputs / Fields

- **Style:** 2px ink rule, 4px corners, field-paper fill, min height 56px, Courier 1.1rem with 14px padding; optional prefix cell (+880) divided by a 1.5px rule. Label above in Anton label style, hint below at 0.92rem ink-soft.
- **Focus:** the Second Frame around the whole control; caret is biro blue.
- **Error:** border turns `hall-red-ink`, paired with an alert.
- **OTP:** six 4px-cornered boxes (aspect 0.82) showing Anton digits over one transparent real input; the active box gets a biro second frame.

### Mode Key (signature)

The hall key from a printed map: a 2px-ruled strip of five equal tiles (B Buy, R Rent, L Borrow, H Hire, S Source), divided by 1.5px rules. Each tile is a 44px hall-red letter block with the ink-wear mask and a paper Anton letter (2rem), the mode name below. It is a radio group with roving tabindex and arrow keys. The selected tile's letter block turns ink and the tile is circled by a ballpoint loop that draws on.

### Catalog Entry (signature)

A square stamp plate (1.5px ink, no radius) holding an etched drawing through the ink-print filter, then the code in Courier bold, the title in 0.82rem caps, and meta (place, budget, time) in ink-soft. Example entries may be circled in ballpoint to show what a reader marks.

### Ledger Rows

A list under a 2px-ruled section head: 56px square plate (drawing or session code), bold title, ink-soft meta, trailing small button; rows divided by 1.5px rules. The current item carries a biro annotation ("This device") inside its own loop. A destructive confirmation expands inline as a 2px `hall-red-ink` box spanning the row.

### Alerts

2px bordered, 4px corners, 22px drawn icon plus text. Error alerts are `hall-red-ink` and bold; notes are ink and regular.

### Member Card

A 108px square badge (2px ink rule) with the person etching, circled in ballpoint, beside a definition list of Anton terms in ink-soft and bold Courier values.

### Navigation

- **Masthead:** wordmark DORKAR | দরকার (Anton plus condensed Bengali, separated by a 2px ink bar), 3px hall-red rule beneath.
- **Top nav (900px+):** Anton 1.3rem caps; the current route is underlined 3px in hall red, 0.25em offset. Language toggle is a 1.5px outlined 4px-cornered button, min 44px, set in the other language's face.
- **Bottom nav (under 900px):** fixed bar on newsprint with a 2px ink top rule; 26px drawn icons over 0.95rem Anton labels (0.85rem with four items); the current route fills its navdot. Three items signed out (Catalog, Post, Sign in), four signed in (adds Dashboard). Staff reach the desk from the dashboard and the top nav.

### Dashboards

The personal dashboard (`/dashboard`), the staff desk (`/desk`) and the activity log (`/desk/activity`) are built from the same printed parts:

- **Tally:** a ruled grid of big Anton figures (2.4rem, up to 3.6rem on the personal tally) over 0.85rem Courier caps labels; 1.5px rules, 2px top rule. Two columns on phones, four from 900px. The one figure that asks for action (offers waiting for you) is circled in ballpoint when it is above zero.
- **Segmented choice:** a strip of ruled cells (period, day/week, activity scope); the chosen cell is printed solid ink. Real radio inputs underneath, so keyboard and screen readers get a radio group.
- **Figures table:** a ruled ledger with Anton column heads in ink-soft and tabular Courier figures right-aligned. Change is shown as ▲/▼ with a sign and ink weight (bold when up). Never red or green: the three-inks rule holds.
- **Ink chart:** HTML columns with a 1.5px ink outline and a printed 45° hatch tile (an SVG pattern, not a gradient) standing on a 2px baseline. The tallest column is solid ink with the wear mask, and its figure is circled in ballpoint, drawing on once when the measure changes. Values are repeated in a visually hidden table.
- **Funnel:** red step numerals as in How it works, each with a hatched bar sized to the first step (capped at full width). A later step larger than the one before is explained in words, not shown as a percentage over 100.
- **Activity rows:** ledger rows with a three-letter service code in the plate; the row expands (native details) into a hairline-ruled fact box with the action code, actor, target, request, IP fingerprint and recorded facts, and one-click "only this account / item" filters. Server labels are English; Bangla pages use a Bangla table for member-visible actions and mark any English fallback `lang="en"`.

### Motion

One motion exists: the ballpoint loop draws on (stroke-dashoffset 1 to 0, 520ms, cubic-bezier(0.16, 1, 0.3, 1)) when a mode is chosen or a page lands on a circled mark. Buttons only transition their frame and fill (160ms). Under `prefers-reduced-motion: reduce` the loop appears already drawn.

## Do's and Don'ts

### Do:

- **Do** build every surface from ruled boxes: 2px ink for controls and panels, 1.5px for plates and dividers, 3px hall red for the masthead and danger rules.
- **Do** use `hall-red` only for fills, rules and type at 1.5rem+, and `hall-red-ink` for any smaller red text or thin red stroke.
- **Do** reserve `biro-blue` for ballpoint loops, wavy hand underlines, hand annotations inside a loop, focus (2.5px, 3px offset) and the caret.
- **Do** show hover, press and focus-within as the Second Frame (`0 0 0 3px newsprint, 0 0 0 5px ink`).
- **Do** draw new illustrations and icons on the 48-unit plate with the 2 / 1.3 / 0.8 stroke weights, round caps, and run catalog-scale plates through `#ink-print`.
- **Do** put the ink-wear mask on solid ink and red fills via a pseudo-element, leaving the label and focus ring unmasked.
- **Do** give every Anton style a `:lang(bn)` counterpart in condensed Noto Sans Bengali with tracking reset to 0, and open Bangla body line-height to 1.65.
- **Do** keep touch targets at 44px minimum (52px primary buttons, 56px fields).
- **Do** use the ballpoint loop sparingly: on the chosen option, the current device or session, the member badge, and a few example plates; it draws on once and respects reduced motion.

### Don't:

- **Don't** add drop shadows, lifted cards, glows, gradients or translucent overlays; depth is grain, wear and rule weight.
- **Don't** introduce a fourth hue for success, info or links; links are ink with a 1.5px underline.
- **Don't** set body text, captions or small labels in `hall-red`; it is 4.1:1 on newsprint.
- **Don't** print anything in `biro-blue`: no blue buttons, headings, icons or nav states.
- **Don't** round stamp plates, or round controls beyond 4px.
- **Don't** apply the wear mask or ink-print filter to text, focus rings or the page ground.
- **Don't** add a second animation or animate the loop on every render; it is keyed to the change it marks.
- **Don't** use photographs, emoji or third-party icon sets in place of the etched plates.
- **Don't** track out or uppercase Bangla text.

### Open items (not yet achieved)

- The stamp illustrations are hand-authored vector drawings passed through a filter; they should become real etched raster or traced plates matching the board's craft.
- The ink-wear texture is procedural fractal noise applied uniformly; it should become an edge-weighted raster wear texture (heavier at fill edges, as press ink wears).
- The Bengali variable font (about 190 KB) loads on every page because the wordmark uses it, even in English; it should be subset for the wordmark or deferred.
