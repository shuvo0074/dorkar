/**
 * RFC 4180 CSV with spreadsheet formula neutralisation (OWASP "CSV injection"): a cell that a
 * spreadsheet would evaluate (= + - @, or a leading tab / carriage return) is prefixed with `'`.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export type Cell = string | number | boolean | Date | Record<string, unknown> | null | undefined;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: readonly Cell[]): string => `${cells.map(csvCell).join(',')}\r\n`;
