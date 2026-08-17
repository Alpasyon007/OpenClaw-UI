import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Test harness.
 *
 * Two environments, because this repo spans two runtimes that must not be
 * conflated:
 *
 *   node   — sidecar/, src/main/, src/shared/. Real Node globals, no DOM. These
 *            modules run inside the sidecar process and must never accidentally
 *            depend on `window`; giving them jsdom would hide that.
 *   jsdom  — src/renderer/. React 19 + Zustand. `window.clui` is a stub the
 *            setup file installs, so a component reaching for a bridge method
 *            that the contract does not declare fails loudly instead of
 *            silently returning undefined.
 *
 * `tests/contract` deliberately lives in the node project: it reads the
 * contract, the generated shim and the sidecar as *text* and asserts the three
 * agree. It is the cheapest guard in the repo against the bridge drifting.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The renderer imports the notification sound as a URL. Vitest has no
      // asset pipeline, so point it at a stub that returns a data URI.
      '../../../resources/notification.mp3': resolve(__dirname, 'tests/stubs/audio.ts'),
      // Workspace packages resolve to source. Vitest does not read tsconfig
      // `paths`, so these have to be restated here or every package import
      // fails to resolve under test while typechecking cleanly.
      '@openclaw/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@openclaw/gateway-client': resolve(__dirname, 'packages/gateway-client/src/index.ts'),
      '@openclaw/conversation': resolve(__dirname, 'packages/conversation/src/index.ts'),
    },
  },
  test: {
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // A hung PTY/HTTP test must fail the run, not stall CI forever.
    testTimeout: 10_000,
    hookTimeout: 20_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'reports/coverage',
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'sidecar/**/*.{ts,mjs}', 'packages/*/src/**/*.ts'],
      exclude: [
        // Declarative, never executed — it exists to be parsed by gen-shim.
        'src/shared/clui-contract.ts',
        'src/renderer/env.d.ts',
        'src/renderer/main.tsx',
        '**/*.test.ts',
        '**/*.d.ts',
      ],
      // A ratchet pinned just below the measured baseline, not a target.
      //
      // The absolute numbers are low and should be read honestly: this repo had
      // no tests at all, and ~19k lines of it are React components and process
      // plumbing that a unit test cannot reach without a real window and a real
      // CLI. What is covered is the pure logic where the bugs actually were —
      // the parsers, the normalizer and the store reducer, which is why
      // branches sits far higher than lines.
      //
      // Raise these as coverage lands. Never lower them to make a red run green.
      thresholds: {
        lines: 9,
        functions: 30,
        branches: 70,
        statements: 9,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          // Package tests are colocated rather than living under tests/. These
          // packages are meant to be portable — a package that carries its own
          // suite can be lifted out without first untangling which of the
          // repo's central tests belonged to it.
          include: [
            'tests/{unit,contract,sidecar}/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/jsdom.ts'],
        },
      },
    ],
  },
})
