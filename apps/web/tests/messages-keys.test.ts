import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Area tables are merged with spread: a key in two areas would silently shadow the other. */
describe('message tables', () => {
  it('never define the same key in two areas', async () => {
    const dir = join(__dirname, '../src/lib/messages');
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
      const mod = (await import(join(dir, file))) as Record<string, object>;
      for (const table of Object.values(mod)) {
        for (const key of Object.keys(table)) {
          const prev = owner.get(key);
          if (prev && prev !== file) clashes.push(`${key} (${prev}, ${file})`);
          owner.set(key, file);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
