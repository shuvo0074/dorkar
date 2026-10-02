import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Clean-architecture import boundaries, enforced per layer inside every service. */
const layer = (name, forbidden) => ({
  files: [`services/*/src/${name}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: forbidden.map((f) => ({
          group: [`**/${f}/**`, `../${f}/*`, `../../${f}/*`],
          message: `${name}/ must not import from ${f}/ (see docs/architecture/01-architecture.md §3).`,
        })),
      },
    ],
  },
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  layer('domain', ['application', 'infrastructure', 'interfaces']),
  layer('application', ['infrastructure', 'interfaces']),
  {
    // CLIs print to stdout by design.
    files: ['**/src/cli/**/*.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/tests/**/*.ts', '**/testing.ts', '**/*.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['infra/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly' } },
  },
);
