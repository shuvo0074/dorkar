/** Need modes and their catalog letters (the "hall key"). Borrow is L — a loan, not a rental. */
export const Modes = ['BUY', 'RENT', 'BORROW', 'HIRE', 'SOURCE'] as const;
export type Mode = (typeof Modes)[number];

export const modeLetter: Record<Mode, string> = {
  BUY: 'B',
  RENT: 'R',
  BORROW: 'L',
  HIRE: 'H',
  SOURCE: 'S',
};
