/**
 * Postage-stamp drawings in one etching hand: 48-unit plate, heavy contour (2), lighter detail
 * (1.3) and hatch shading (0.8). Catalog plates pass through the shared `#ink-print` filter
 * (see InkDefs) so lines wobble and wear like newsprint ink. Decorative (aria-hidden): the
 * surrounding text names the thing.
 */
import type { ReactNode, SVGProps } from 'react';

function Glyph({ children, ...rest }: { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" className="glyph" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

/** Hatch shading: thin parallel strokes. */
const H = ({ d }: { d: string }) => <path className="hatch" d={d} />;
/** Secondary detail line. */
const L = (props: SVGProps<SVGPathElement>) => <path className="detail" {...props} />;

/** Shared filter defs, rendered once by the app shell. */
export function InkDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id="ink-print" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="n"
          scale="1.3"
          xChannelSelector="R"
          yChannelSelector="G"
          result="d"
        />
        <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="2" result="w" />
        <feColorMatrix
          in="w"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -9 0 0 0 7.4"
          result="wear"
        />
        <feComposite in="d" in2="wear" operator="in" />
      </filter>
    </svg>
  );
}

export const PhoneGlyph = () => (
  <Glyph>
    <path d="M16.5 7.6c0-1 .8-1.8 1.8-1.8h11.3c1 0 1.9.8 1.9 1.8v32.6c0 1-.8 1.9-1.8 1.9H18.4c-1 0-1.9-.8-1.9-1.9z" />
    <L d="M18.8 12.5h10.4v21.6H18.8zM21.5 9.3h5M31.6 13v4M31.6 19v2.5" />
    <circle className="fill" cx="24" cy="37.6" r="1.3" />
    <H d="M18.8 22.5l6.6-6.6M18.8 27l10.4-10.4M18.8 31.5l10.4-10.4M21.3 34.1l7.9-7.9M25.8 34.1l3.4-3.4" />
    <H d="M33 9.5c1.2 1 1.7 2.6 1.7 4.4v24.5" />
  </Glyph>
);

export const BusGlyph = () => (
  <Glyph>
    <path d="M5.5 33.5V20c0-3 2-5.5 5-5.5H31c2.3 0 4 1 5.3 3l5.3 7.8c.6.9.9 1.9.9 3v5.2H5.5z" />
    <L d="M9 18.5h7v6H9zM19 18.5h7v6h-7zM29 18.5h3.4l3.6 6H29zM5.5 27.5h37" />
    <H d="M10.5 18.5v6M12.5 18.5v6M14.5 18.5v6M20.5 18.5v6M22.5 18.5v6M24.5 18.5v6M30.5 18.5v6" />
    <circle cx="14" cy="34" r="3.8" style={{ fill: 'var(--paper)' }} />
    <circle cx="34" cy="34" r="3.8" style={{ fill: 'var(--paper)' }} />
    <circle className="fill" cx="14" cy="34" r="1.2" />
    <circle className="fill" cx="34" cy="34" r="1.2" />
    <H d="M3 40.5h42M7 42.5h34" />
  </Glyph>
);

export const LadderGlyph = () => (
  <Glyph>
    <path d="M16 5.5l-4.2 36.5M30 5.5l6.2 36.5" strokeWidth="2.3" />
    <L d="M15.3 12H31M14.6 19h17.6M13.8 26h19.5M13 33h21.5" />
    <H d="M8 43h32M10 45h12M27 45h11M33.5 33l1.6 9M32.5 26l1.6 7" />
  </Glyph>
);

export const CameraGlyph = () => (
  <Glyph>
    <path d="M6.5 16.5C6.5 15.1 7.6 14 9 14h6l2.6-4h12.8l2.6 4h6c1.4 0 2.5 1.1 2.5 2.5v19c0 1.4-1.1 2.5-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5z" />
    <circle cx="24" cy="25.5" r="8" />
    <L d="M24 21a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9M36 18.5h2.5M9.5 18h4" />
    <H d="M19.2 31.8a8 8 0 0 0 11.4-.6M18 29.6a8 8 0 0 0 13.6.6M9.5 22v12M11.5 22v12M36.5 23v11M38.5 23v11" />
  </Glyph>
);

export const BagGlyph = () => (
  <Glyph>
    <path d="M9 17.5h30l-2.5 23c-.1 1-.9 1.7-1.9 1.7H13.4c-1 0-1.8-.7-1.9-1.7z" />
    <path d="M17 17.5v-4.3a7 7 0 0 1 14 0v4.3" />
    <L d="M19 17.5v-4a5 5 0 0 1 10 0v4" />
    <H d="M12 24.5h24M12.7 31h22.6M13.4 37h21.2M18 17.5l1.5 24.5M24 17.5V42M30 17.5L28.5 42M13.5 20.5h21" />
  </Glyph>
);

export const DeskGlyph = () => (
  <Glyph>
    <path d="M3.5 20h25M6.5 20v20M25.5 20v20M34 9.5V40M34 26h9v14" />
    <L d="M3.5 22.2h25M6.5 28h19M12 20v-6.5h9V20M14 13.5l2.5-5M34 18h4" />
    <H d="M8 24.5h16M8 26h16M35.5 28h6M35.5 30h6M2 43h44" />
  </Glyph>
);

export const FanGlyph = () => (
  <Glyph>
    <path d="M24 4v10" strokeWidth="2.3" />
    <circle cx="24" cy="17" r="3.2" />
    <path d="M21.4 15.6C15 12 8 12.5 4.5 15c4 2.5 10.5 3.8 16.8 3.2M26.6 15.6C33 12 40 12.5 43.5 15c-4 2.5-10.5 3.8-16.8 3.2M23.6 20c-1.2 7-.6 14 1.6 18 2.2-4 2.6-11 .6-17.7" />
    <H d="M8.5 14.5l2.5 2.2M11.5 13.8l2.8 2.6M14.5 13.6l2.7 2.6M33 13.6l-2.6 2.6M36 13.8l-2.6 2.6M24.4 25l1.6 0M24.5 29h1.7M24.8 33h1.5" />
    <L d="M9 27.5c3.2 4 8.4 6.5 14.5 6.5M39 27.5c-1.4 1.8-3.3 3.3-5.5 4.4" strokeDasharray="2 3" />
  </Glyph>
);

export const HangerGlyph = () => (
  <Glyph>
    <L d="M21 9.8a3 3 0 1 1 3 3c-.9 0-1.6.7-1.6 1.6v1.8" />
    <path d="M22.4 16.2 8 25.2h32z" />
    <path d="M14.5 22l-2.5 20h24l-2.5-20" />
    <L d="M24 25.2V42M19.5 25.2l4.5 5 4.5-5" />
    <circle className="fill" cx="25.8" cy="33.5" r=".9" />
    <circle className="fill" cx="25.8" cy="37.6" r=".9" />
    <H d="M13.5 30l3.5-3.5M13 34.5l6.5-6.5M12.6 39l9-9M15 41l6.5-6.5M34.5 30l-3.5-3.5M35 34.5l-6.5-6.5M35.4 39l-6-6" />
  </Glyph>
);

export const BooksGlyph = () => (
  <Glyph>
    <path d="M8 34.5h32v6H8zM10.5 28.5h28v6h-28zM7 22.5h30v6H7z" />
    <L d="M12 37.5h12M14 31.5h18M11 25.5h9M30 8l8 11.5-2.6 1.8-8-11.5zM27.4 9.8 26 7.3l3-1.4" />
    <H d="M33 34.5v6M35 34.5v6M37 34.5v6M12.5 28.5v6M14.5 28.5v6M31 22.5v6M33 22.5v6M35 22.5v6M5 43h38" />
  </Glyph>
);

export const BicycleGlyph = () => (
  <Glyph>
    <circle cx="12" cy="31" r="7.5" />
    <circle cx="36" cy="31" r="7.5" />
    <L d="M12 31l7-12h12l5 12M19 19l5 12h-12M24 31l7-12M17 15.5h5M31 19l-1.5-5h4" />
    <circle className="fill" cx="24" cy="31" r="1.4" />
    <H d="M6.2 26.5l1.5 1M5 31h2.5M6.2 35.5l1.5-1M41.8 26.5l-1.5 1M43 31h-2.5M41.8 35.5l-1.5-1M4 42h40" />
  </Glyph>
);

export const SewingGlyph = () => (
  <Glyph>
    <path d="M7 36.5V15c0-2 1.6-3.5 3.5-3.5h21c2 0 3.5 1.6 3.5 3.5v6.5H16v15" />
    <path d="M4 36.5h40v4H4z" />
    <L d="M27 21.5v6.5M25.5 28h3M38 14a4 4 0 1 1 0 8M11 15.5h17" />
    <H d="M9 18l4-4M9 22.5l6-6M9 27l6-6M9 31.5l6-6M10.5 34.5l4.5-4.5M6 38.5h36" />
  </Glyph>
);

export const ChairsGlyph = () => (
  <Glyph>
    <path d="M13 9.5h14l-1.5 13H14.5zM14.5 22.5L11 41M25.5 22.5L29 41M14 31h12" />
    <L d="M21 7.5h14l-1.5 13M33.5 20.5L37 39M27.5 29h7" />
    <H d="M15 12.5h10.5M15 15h10.2M15 17.5h10M15.2 20h9.6M8 43h33" />
  </Glyph>
);

export const ShirtGlyph = () => (
  <Glyph>
    <path d="M17.5 7.5L8 12.5l3 9 4-2V41h18V19.5l4 2 3-9-9.5-5c-.8 2.5-3.3 4.2-6.5 4.2s-5.7-1.7-6.5-4.2z" />
    <L d="M24 11.7V41M18.2 9.5l5.8 5.5 5.8-5.5" />
    <circle className="fill" cx="25.8" cy="20" r=".9" />
    <circle className="fill" cx="25.8" cy="26" r=".9" />
    <circle className="fill" cx="25.8" cy="32" r=".9" />
    <H d="M15 24l4-4M15 29l6-6M15 34l8-8M15.5 39l6.5-6.5M10 15l2-2" />
  </Glyph>
);

export const AircoGlyph = () => (
  <Glyph>
    <path d="M5.5 10.5h37c1 0 1.8.8 1.8 1.8v11.4c0 1-.8 1.8-1.8 1.8h-37c-1 0-1.8-.8-1.8-1.8V12.3c0-1 .8-1.8 1.8-1.8z" />
    <L d="M7 20.5h34M7 23h34M36 14.5h4" />
    <L d="M11 30c2 2.5 0 5 2 7.5M20 30c2 2.5 0 5 2 7.5M29 30c2 2.5 0 5 2 7.5M38 30c2 2.5 0 5 2 7.5" />
    <H d="M6 12.5l3-2M6 15.5l5.5-5M6 18.5l8.5-8" />
  </Glyph>
);

export const CookerGlyph = () => (
  <Glyph>
    <path d="M9.5 21.5h29v15c0 3-2.5 5.5-5.5 5.5H15c-3 0-5.5-2.5-5.5-5.5z" />
    <path d="M8 21.5c0-4.5 7-8 16-8s16 3.5 16 8z" />
    <L d="M21.5 13.7v-2h5v2M9.5 26.5H5.5M38.5 26.5h4M14 30h20" />
    <rect className="fill" x="21" y="33" width="6" height="3.5" rx="0.6" />
    <L d="M19 8.5c-1.3-1.5 1.3-3 0-4.5M24 7.5c-1.3-1.5 1.3-3 0-4.5M29 8.5c-1.3-1.5 1.3-3 0-4.5" />
    <H d="M11.5 24l3 0M11 27.5l1.5 2M11.5 32l3 3.5M12.5 37l2.5 3M35 24l1.5 0M36.5 27.5l-1.5 2M36.5 32l-3 3.5" />
  </Glyph>
);

export const LaptopGlyph = () => (
  <Glyph>
    <path d="M10 13.5c0-1 .8-1.8 1.8-1.8h24.4c1 0 1.8.8 1.8 1.8V31H10z" />
    <path d="M5 31h38l-2.5 5h-33z" />
    <L d="M21 33.5h6M12.5 14.2h23v14.3h-23z" />
  </Glyph>
);

export const PersonGlyph = () => (
  <Glyph>
    <circle cx="24" cy="16.5" r="7" />
    <path d="M10.5 41c.6-8.3 6.4-13.5 13.5-13.5S36.9 32.7 37.5 41" />
  </Glyph>
);

/* Navigation set: same hand, plus a dot that fills on the current route. */
export const CatalogIcon = () => (
  <Glyph>
    <path d="M8 8h13v13H8zM27 8h13v13H27zM8 27h13v13H8zM27 27h13v13H27z" />
    <circle className="navdot" cx="33.5" cy="33.5" r="3" />
  </Glyph>
);

export const PenIcon = () => (
  <Glyph>
    <path d="M32.5 7.5l8 8L18 38l-10 2 2-10z" />
    <path d="M28 12l8 8" />
    <circle className="navdot" cx="11" cy="11" r="3" />
  </Glyph>
);

export const PersonIcon = () => (
  <Glyph>
    <circle cx="24" cy="15.5" r="7" />
    <path d="M10.5 41c.6-8.3 6.4-13.5 13.5-13.5S36.9 32.7 37.5 41" />
    <circle className="navdot" cx="38" cy="10" r="3" />
  </Glyph>
);

export const AlertIcon = () => (
  <Glyph>
    <path d="M24 5.5 43.5 40H4.5z" stroke="currentColor" />
    <path d="M24 18v10" stroke="currentColor" strokeWidth="3" />
    <circle cx="24" cy="34" r="1.8" fill="currentColor" stroke="none" />
  </Glyph>
);

export const NoteIcon = () => (
  <Glyph>
    <circle cx="24" cy="24" r="18" />
    <path d="M24 21v13" strokeWidth="3" />
    <circle className="fill" cx="24" cy="14.5" r="1.9" />
  </Glyph>
);
