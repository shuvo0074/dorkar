import { Errors } from './errors';

/**
 * Opaque keyset cursor over (sortKey, id). Lists order by `created_at desc, id desc` (or another
 * monotonic key) and continue with `where (key, id) < (cursor.key, cursor.id)`: stable under
 * inserts and O(log n) at any depth, unlike OFFSET.
 */
export interface Cursor {
  /** Sort key: ISO timestamp, or a number for score-ordered lists. */
  k: string | number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.k, c.id])).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      (typeof v[0] === 'string' || typeof v[0] === 'number') &&
      typeof v[1] === 'string' &&
      v[1].length <= 64
    ) {
      return { k: v[0], id: v[1] };
    }
  } catch {
    // fall through
  }
  throw Errors.validation('Invalid cursor.');
}

/** Takes `limit + 1` rows; returns the page and the cursor for the next one (or null). */
export function paginate<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => Cursor,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null };
}
