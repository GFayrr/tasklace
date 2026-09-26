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
        projectService: { allowDefaultProject: ['eslint.config.js'] },
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
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
