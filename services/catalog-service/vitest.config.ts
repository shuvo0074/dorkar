import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'catalog', include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
