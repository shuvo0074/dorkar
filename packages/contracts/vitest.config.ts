import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'contracts:unit', include: ['tests/**/*.test.ts'] },
});
