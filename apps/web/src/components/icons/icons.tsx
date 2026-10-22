/**
 * Interface icons: 24-unit grid, 2px round strokes, drawn in currentColor so they take the
 * colour of the tile or tab they sit in. Decorative (aria-hidden): the label names the thing.
 */
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Icon>
);

export const ChartIcon = () => (
  <Icon>
    <path d="M4 20h16" />
    <path d="M7 16v-4M12 16V7M17 16v-6" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const ListIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);

export const GridIcon = () => (
  <Icon>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const HandIcon = () => (
  <Icon>
    <path d="M7 10l5-5 5 5M12 5v10M5 19h14" />
  </Icon>
);

export const GavelIcon = () => (
  <Icon>
    <path d="m14 5 5 5M11.5 7.5l5 5M13 6l-6 6 5 5 6-6M9.5 14.5 4 20" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" />
  </Icon>
);

export const ArrowIcon = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

/* One icon per need mode, for the service tiles. */
export const BuyIcon = () => (
  <Icon>
    <path d="M6 7h12l-1 13H7zM9 7a3 3 0 0 1 6 0" />
  </Icon>
);

export const RentIcon = () => (
  <Icon>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8M16 7l2 2M14 9l2 2" />
  </Icon>
);

export const BorrowIcon = () => (
  <Icon>
    <path d="M7 4 3 8l4 4M3 8h13a4 4 0 0 1 0 8h-2M17 20l4-4-4-4" />
  </Icon>
);

export const HireIcon = () => (
  <Icon>
    <path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />
  </Icon>
);

export const SourceIcon = () => (
  <Icon>
    <path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />
  </Icon>
);
