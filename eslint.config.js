import { builtinModules } from 'node:module';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const MAX_NESTING_DEPTH = 2;

export default defineConfig(
  { ignores: ['coverage/', 'dist/', 'out/', 'node_modules/'] },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'electron.vite.config.ts',
            'playwright.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'max-depth': ['error', MAX_NESTING_DEPTH],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/core/testing/**', 'src/core/tags/color-matrices.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1],
          ignoreArrayIndexes: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(node:.*|electron|${builtinModules.join('|')})(/.*)?$`,
              message: 'src/core must stay pure: no Node.js or Electron module.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(node:.*|electron|${builtinModules.join('|')})(/.*)?$`,
              message: 'The page talks to the main process only through the preload bridge.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(node:.*|${builtinModules.join('|')})(/.*)?$`,
              message: 'The sandboxed preload script may only use the electron module.',
            },
          ],
        },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
