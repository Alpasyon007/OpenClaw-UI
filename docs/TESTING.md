# Testing and verification

`npm run verify` is the gate. It runs, in order:

```bash
npm run verify
```

| Step | Command | What it protects |
|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit` over `src/`, `sidecar/` and `tests/` |
| Lint | `npm run lint` | defect-class rules; must stay at **0 errors** |
| Build | `npm run build` | the renderer bundle actually compiles |
| Generated | `npm run check:generated` | the committed shim and sidecar bundle match their sources |
| Test | `npm run test` | 145 tests across two environments |

Individually: `npm run test:watch`, `npm run coverage`, `npm run lint:fix`.

## Why the harness is shaped this way

This app spans three runtimes — a C++ saucer shell, a Node sidecar, and a React
renderer in a WebView — connected by a bridge that no compiler checks end to
end. The interesting bugs live in the seams, not inside any one module, so most
of the value here is in tests that read the seams rather than exercise them.

### Two Vitest projects

`vitest.config.ts` defines `node` and `renderer`. The split is deliberate:
`src/main/` and `sidecar/` run in a real Node environment with no DOM, so a
module that accidentally reaches for `window` fails immediately instead of
being propped up by jsdom. `src/renderer/` gets jsdom plus a `window.clui` stub.

### The `window.clui` stub is generated from the contract

`tests/helpers/clui-stub.ts` builds the bridge double by parsing
`src/shared/clui-contract.ts`. Every declared method exists; **anything else
throws**. A component calling a bridge method the contract does not declare is a
silent no-op in production — a button that does nothing — and this turns it into
a test failure.

### `tests/contract/` is the highest-value suite

The bridge has four independent representations of one API:

```
src/shared/clui-contract.ts   the declaration the renderer types against
shell/web/clui-shim.js        the generated code the renderer actually calls
sidecar/index.ts              the handlers that answer
src/shared/types.ts           the wire strings all three agree on
```

Nothing in the type system connects them. `tests/helpers/contract.ts` is a
*second, independent* parser of those files — deliberately not sharing code with
`sidecar/gen-shim.mjs`, because a shared parser that stops matching a method
would go blind in both places at once. Two implementations disagreeing is the
signal.

The suite asserts, among other things:

- every declared method is implemented, generated into the shim, and answered
  by a sidecar handler (or is a documented shell override, read out of the shim
  rather than hardcoded);
- every handler destructures only keys the contract actually sends — this is
  what caught `openclawRun` receiving `{ args }` while the contract sent
  `{ action }`, and `tabHealth` destructuring a `tabId` it is never given;
- every primitive payload is registered in the sidecar's `BARE_ARG` adapter,
  because destructuring a string yields `undefined` and the call silently
  no-ops;
- no `send()` forwards more than one payload expression, since the shim's
  `fire()` drops all but the first.

### Palette and bundle guards

`tests/renderer/theme-tokens.test.ts` cross-references every `colors.X` read in
the renderer against every palette the app can produce, including all eight
built-in themes in both modes. A missing token is invisible at runtime —
`style={{ background: undefined }}` simply paints nothing.

`tests/contract/bundle.test.ts` fails on any Node-only global reaching the
renderer, at both source and built-bundle level. The renderer has no `process`,
no `require`, no `Buffer`; Vite bundles a reference to one without complaint and
the `ReferenceError` surfaces only when that branch is first taken.

It also holds a size budget (currently ~847 kB raw / ~245 kB gzip). The entry is
a single chunk with no code splitting — the budget exists so that stays a known
number rather than a drift.

### Regenerated-artefact check

`shell/web/clui-shim.js` and `shell/sidecar/main.cjs` are generated but
committed, because the C++ shell loads them directly and has no build step.
`scripts/check-generated.mjs` regenerates both into a scratch directory and
diffs. Without it, editing the contract and forgetting `npm run shim` ships a
shim that predates the change.

## Lint policy

Rules are chosen to catch **defects**, not to enforce a house style. The repo
has a consistent voice already, and a formatting argument encoded as CI failures
is noise.

Errors (must stay at zero): floating promises, misused promises, `require-atomic-updates`,
`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, `react-hooks/refs`,
unused variables, and `no-restricted-globals` — which enforces the layering:
the renderer may not touch `process`, and the sidecar may not touch `window`.

Warnings (a tracked backlog, deliberately not blocking):

- `react-hooks/set-state-in-effect` — new in eslint-plugin-react-hooks 7. Most
  hits are legitimate sync-on-mount effects; real cascading-render bugs are
  mixed in and each needs its own judgement call.
- `no-useless-escape` — cosmetic redundant escapes.

`@typescript-eslint`'s `no-unsafe-*` family is off: this codebase talks to a CLI
over JSON and to a C++ shell over a stringly-typed bridge, and `any` at those
boundaries is a considered choice.

## Coverage

Thresholds sit just below the measured baseline and ratchet upward. The absolute
numbers are low (~9.5% lines) and should be read honestly: much of the ~19k
lines is React components and process plumbing that a unit test cannot reach
without a real window and a real CLI. Branch coverage is far higher (~72%)
because what *is* covered is the pure logic where the bugs actually were — the
PTY parsers, the event normalizer, and the store reducer.

Raise the floors as coverage lands. Never lower them to make a red run green.

## Adding tests

- Pure logic in `src/main/` or `sidecar/` → `tests/unit/`
- A cross-boundary invariant → `tests/contract/`
- Store or component behaviour → `tests/renderer/`

Two habits worth keeping, both visible throughout the existing suites:

**Guard the guards.** A test that derives its own input set can silently start
checking nothing. `tests/contract/bridge.test.ts` asserts
`needsAdapter.length > 4` before checking that set; `theme-tokens.test.ts`
asserts it found more than 20 tokens. Without those, a parser regression turns
the suite green rather than red.

**Test what must *not* happen.** The chrome filter in `pty-run-manager.ts` had
seven separate rules that deleted ordinary assistant sentences containing words
like "processing" or "/doctor". No test of what the filter *catches* would ever
have found that. `tests/unit/pty-parsing.test.ts` is split into "must be
filtered" and "must survive" for exactly this reason.
