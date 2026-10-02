import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'dashboard', include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
