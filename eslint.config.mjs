import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'tmp/**',
      'server/**',
      'scripts/**',
      'main.js',
      'server.js',
      'src/core/gateway-bundle.ts',
      'src/core/style-bundle.ts',
    ],
  },
  {
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      obsidianmd,
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'obsidianmd/rule-custom-message': 'warn',
      'prefer-spread': 'warn',
    },
  },
]);
