import { builtinModules } from 'node:module';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const MAX_NESTING_DEPTH = 2;
const ONLY_DIRECT_PDF_IMPORTS_PDFKIT = {
  regex: String.raw`^pdfkit(/.*)?$`,
  message:
    'Only src/main/pdf/direct-pdf.ts may use PDFKit, so that it can be replaced in one place.',
};

export default defineConfig(
  { ignores: ['coverage/', 'dist/', 'out/', 'node_modules/'] },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  svelte.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'electron.vite.config.ts',
            'playwright.config.ts',
            'playwright.pdf-compare.config.ts',
            'svelte.config.js',
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
            ONLY_DIRECT_PDF_IMPORTS_PDFKIT,
          ],
        },
      ],
    },
  },
  {
    files: ['relay/src/**/*.ts'],
    ignores: ['relay/src/**/*.test.ts', 'relay/src/testing/**'],
    rules: {
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreNumericLiteralTypes: true,
          ignoreTypeIndexes: true,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(?!node:|ws$|\./[\w-]+\.ts$|\.\./\.\./src/core/collaboration/relay/relay-wire\.ts$)`,
              message:
                'The relay runs on Node alone: it imports only Node, ws, its own files and relay-wire.ts, each with its .ts extension.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, svelteConfig },
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.svelte'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(node:.*|electron|${builtinModules.join('|')})(/.*)?$`,
              message: 'The page talks to the main process only through the preload bridge.',
            },
            ONLY_DIRECT_PDF_IMPORTS_PDFKIT,
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
            ONLY_DIRECT_PDF_IMPORTS_PDFKIT,
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'tests/**/*.ts'],
    ignores: ['src/main/pdf/direct-pdf.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [ONLY_DIRECT_PDF_IMPORTS_PDFKIT] }],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
