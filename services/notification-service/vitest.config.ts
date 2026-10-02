import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'notification', include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
