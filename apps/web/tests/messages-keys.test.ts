import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Area tables are merged with spread: a key in two areas would silently shadow the other. */
describe('message tables', () => {
  it('never define the same key in two areas', async () => {
    const dir = join(__dirname, '../src/lib/messages');
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    // The core table in i18n.tsx counts as an area too.
    const core = readFileSync(join(__dirname, '../src/lib/i18n.tsx'), 'utf8');
    const coreEn = core.slice(core.indexOf('const coreEn = {'), core.indexOf('} as const;'));
    for (const m of coreEn.matchAll(/^ {2}'([^']+)':/gm)) owner.set(m[1]!, 'i18n.tsx');
    for (const file of readdirSync(dir).filter((f) => f !== 'define.ts')) {
      const mod = (await import(join(dir, file))) as Record<string, { en: object }>;
      for (const table of Object.values(mod)) {
        for (const key of Object.keys(table.en)) {
          const prev = owner.get(key);
          if (prev && prev !== file) clashes.push(`${key} (${prev}, ${file})`);
          owner.set(key, file);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
