import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'lending', include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
