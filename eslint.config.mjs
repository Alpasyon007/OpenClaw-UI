import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Lint configuration.
 *
 * Scoped to rules that catch *defects*, not rules that enforce a house style.
 * The repo has a consistent voice already and a formatting argument encoded as
 * CI failures would be noise; every rule enabled below corresponds to a class
 * of bug this codebase can actually ship:
 *
 *   - floating promises and misused promises: the sidecar awaits IPC handlers,
 *     and a dropped rejection there takes the whole bridge down.
 *   - exhaustive-deps: the renderer keeps live subscriptions in effects, where
 *     a stale closure means events routed to a dead tab.
 *   - no-unused-vars: dead parameters are how a refactor half-lands.
 *
 * Type-aware rules run only on the first-party sources listed in tsconfig.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'reports/**',
      // Generated and vendored artefacts — checked by tests, not by lint.
      'shell/web/**',
      'shell/sidecar/**',
      // CMake's build tree, which vendors the whole of saucer and its examples.
      'shell/build/**',
      'coverage/**',
      // The mobile app has its own TypeScript project and its own React Native
      // lint rules. This config is type-aware and bound to the root tsconfig,
      // which does not include `apps/` — pointing it at Metro configs and RN
      // components produces parser errors rather than useful findings. Lint it
      // from `apps/mobile` with eslint-config-expo instead.
      'apps/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ─── Real defects ───
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // onClick={() => void doThing()} is idiomatic React; only the
        // genuinely dangerous conditional/spread cases are worth failing on.
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-template-curly-in-string': 'error',
      'require-atomic-updates': 'error',
      'array-callback-return': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // `try { … } catch {}` on a genuinely best-effort path is a deliberate,
      // documented idiom throughout the sidecar shutdown code.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // ─── Deliberately relaxed ───
      // This codebase talks to a CLI over JSON and to a C++ shell over a
      // stringly-typed bridge. `any` at those boundaries is a considered
      // choice, not an accident, and flagging it drowns the real findings.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // ─── Renderer ───
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      // A missing dependency here is a stale-closure bug, not a nit.
      'react-hooks/exhaustive-deps': 'error',
      // The renderer must not reach for Node APIs; the sidecar owns those.
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The renderer has no Node process — go through window.clui.' },
        { name: 'require', message: 'The renderer bundle is ESM — use import.' },
      ],
    },
  },

  // ─── Sidecar and main-process logic ───
  {
    files: ['src/main/**/*.ts', 'sidecar/**/*.{ts,mjs}', '*.mjs', 'vitest.config.ts', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // A component reaching into main is a layering break; the reverse is a
      // crash, because there is no `window` in the sidecar process.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'There is no window in the sidecar process.' },
        { name: 'document', message: 'There is no document in the sidecar process.' },
      ],
    },
  },

  // The PTY transport reads a real terminal. Matching ESC, BEL and the C0
  // control range is the entire job of its ANSI stripper, so the rule that
  // flags control characters in a regex has nothing useful to say here.
  {
    files: ['src/main/claude/pty-run-manager.ts'],
    rules: { 'no-control-regex': 'off' },
  },

  // ─── Build scripts and tests ───
  //
  // The spread has to come first: it carries a `languageOptions` of its own,
  // and putting it last silently discarded the Node globals below it — which
  // is why every `console` and `process` in scripts/ looked undefined.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/**/*.mjs', 'build-release.mjs', 'sidecar/gen-shim.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // ─── Severity split ───
  //
  // Everything above is an error: it blocks CI and must stay at zero. The two
  // rules below stay visible as warnings because they describe a backlog rather
  // than a defect, and turning a backlog into a merge blocker only teaches
  // people to add disable comments.
  //
  //   set-state-in-effect — new in eslint-plugin-react-hooks 7. Most hits here
  //     are legitimate "sync once on mount" effects. Real cascading-render bugs
  //     do exist among them, but each needs its own judgement call.
  //   no-useless-escape — cosmetic redundant escapes in regexes and strings.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/set-state-in-effect': 'warn' },
  },
  {
    rules: { 'no-useless-escape': 'warn' },
  },
)
