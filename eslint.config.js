import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// reactRefresh.configs.vite enforces the React Fast Refresh rule: a module that
// exports a component must export ONLY components. This is what keeps the app
// HMR-safe inside immediately.run — keep it. Data goes in src/data/, hooks in
// src/hooks/.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // The session engine is a pure library (COLLABORATION_SESSIONS §15.6, R3-969): strings compare
  // by UTF-16 code unit through cmp(), time comes from the injected clock, and nothing imports the
  // platform or React.
  {
    files: ['src/lib/session/**/*.ts'],
    ignores: ['src/lib/session/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='localeCompare']",
          message: 'Compare strings by UTF-16 code unit with cmp() (COLLABORATION_SESSIONS §3.8).',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Use the injected clock.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use the injected clock.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Use the injected random source.',
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: ['@immediately-run/sdk', '@immediately-run/sdk/*', 'react', 'react-dom', 'react/*'] },
      ],
    },
  },
])
