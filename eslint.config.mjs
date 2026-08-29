import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * WARLORDS — ESLint configuration.
 *
 * Beyond generic quality rules, this file enforces the module/dependency
 * boundaries documented in docs/ARCHITECTURE.md ("Module & Dependency
 * Boundaries — hard rules"). Violations are review-blocking by design.
 */

// UI layer may never reach into server-side modules: UI talks to /api only.
const UI_BOUNDARY = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            '@/lib/db',
            '@/lib/bot',
            '@/lib/bot/**',
            '@/lib/game/engine',
            '@/lib/game/engine/**',
            '@/lib/game/services',
            '@/lib/game/services/**',
            '@/lib/health',
            '@/config/env',
          ],
          message:
            'UI layer must not import server modules — call the REST API instead (docs/ARCHITECTURE.md boundaries).',
        },
      ],
    },
  ],
}

// Engines stay PURE: no db, no adapters, no services (purity contract).
const ENGINE_PURITY = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            '@/lib/db',
            '@/lib/bot',
            '@/lib/bot/**',
            '@/lib/api',
            '@/lib/api/**',
            '@/lib/auth',
            '@/lib/auth/**',
            '@/lib/health',
            'next/server',
            '@prisma/client',
          ],
          message:
            'Engines are pure functions: allowed imports are game/types and game/config only.',
        },
      ],
    },
  ],
}

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // TypeScript rules
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-unused-disable-directive': 'off',

      // React rules
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/purity': 'off',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'react-compiler/react-compiler': 'off',

      // Next.js rules
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': 'off',

      // General JavaScript rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
      'no-debugger': 'off',
      'no-empty': 'off',
      'no-irregular-whitespace': 'off',
      'no-case-declarations': 'off',
      'no-fallthrough': 'off',
      'no-mixed-spaces-and-tabs': 'off',
      'no-redeclare': 'off',
      'no-undef': 'off',
      'no-unreachable': 'error',
      'no-useless-escape': 'off',
    },
  },
  {
    files: [
      'src/app/**/page.tsx',
      'src/app/**/layout.tsx',
      'src/app/**/providers.tsx',
      'src/components/**',
      'src/features/**',
      'src/stores/**',
      'src/hooks/**',
    ],
    rules: UI_BOUNDARY,
  },
  {
    files: ['src/lib/game/engine/**'],
    rules: ENGINE_PURITY,
  },
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'examples/**',
      'skills/**',
      'download/**',
      'mini-services/**',
    ],
  },
]

export default eslintConfig
