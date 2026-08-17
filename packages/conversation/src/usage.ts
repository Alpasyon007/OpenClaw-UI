/**
 * Token accounting and cost estimation.
 *
 * Pure, and deliberately conservative about what it claims to know. Two things
 * are easy to get wrong here and both mislead a user about money:
 *
 *  - **Cached input is not billed as input.** A cache *read* is roughly a tenth
 *    of the input rate and a cache *write* is a premium on it. Folding all four
 *    counters into one "input tokens" figure overstates the cost of exactly the
 *    workloads caching is meant to make cheap — long agent runs, which is all of
 *    them here.
 *  - **An unknown model has no price.** Returning zero for one reads as "this
 *    run was free". {@link estimateCost} returns `null` instead, and the UI
 *    shows token counts with no currency rather than a confident wrong number.
 */

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Every counter summed — what "tokens used" means to a reader. */
  total: number
}

/**
 * Fold a raw `usage` map into totals.
 *
 * Accepts the provider's snake_case keys as they arrive on the wire. Unknown
 * keys are ignored rather than summed into `total`: providers report bookkeeping
 * counters alongside the billable ones, and adding those inflates the figure.
 */
export function tokenTotals(usage: Record<string, number> | null | undefined): TokenTotals {
  const read = (key: string): number => {
    const value = usage?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  const input = read('input_tokens')
  const output = read('output_tokens')
  const cacheRead = read('cache_read_input_tokens')
  const cacheWrite = read('cache_creation_input_tokens')

  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/** USD per million tokens, per billing category. */
export interface ModelRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Published list prices, in USD per million tokens.
 *
 * Matched by substring against the model id rather than by exact key, because
 * the id that reaches a client is rarely the bare family name — it arrives
 * dated (`claude-haiku-4-5-20251001`) or region-prefixed
 * (`us.anthropic.claude-...`) depending on which provider the runtime is
 * pointed at. Longest match wins so a more specific entry beats a generic one.
 *
 * These are estimates for orientation, not an invoice. Negotiated rates, batch
 * discounts and non-Anthropic providers all diverge from this table, which is
 * why every caller-facing string built from it says "estimated".
 */
export const MODEL_RATES: ReadonlyArray<readonly [pattern: string, rate: ModelRate]> = [
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['sonnet-5', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['fable-5', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['fable', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
]

/** The rate table entry for a model id, or `null` when nothing matches. */
export function rateFor(modelId: string | null | undefined): ModelRate | null {
  const id = (modelId ?? '').toLowerCase()
  if (!id) return null

  let best: { length: number; rate: ModelRate } | null = null
  for (const [pattern, rate] of MODEL_RATES) {
    if (id.includes(pattern) && (!best || pattern.length > best.length)) {
      best = { length: pattern.length, rate }
    }
  }
  return best?.rate ?? null
}

/**
 * Estimated USD for a set of totals.
 *
 * `null` when the model is unknown — see the module note. Callers must render
 * that as an absent figure, never as `$0.00`.
 */
export function estimateCost(
  totals: TokenTotals,
  modelId: string | null | undefined,
): number | null {
  const rate = rateFor(modelId)
  if (!rate) return null

  const perToken = (millions: number): number => millions / 1_000_000
  return (
    totals.input * perToken(rate.input) +
    totals.output * perToken(rate.output) +
    totals.cacheRead * perToken(rate.cacheRead) +
    totals.cacheWrite * perToken(rate.cacheWrite)
  )
}

/**
 * Compact token count for a status bar.
 *
 * Thousands are rounded to one decimal below 10k and to whole units above,
 * because a status bar that reads `12.4k` and then `12.5k` mid-run is drawing
 * the eye to a digit that carries no information.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  const thousands = count / 1000
  if (thousands < 10) return `${thousands.toFixed(1)}k`
  if (thousands < 1000) return `${Math.round(thousands)}k`
  return `${(thousands / 1000).toFixed(1)}M`
}

/**
 * Money, at a precision that does not imply false accuracy.
 *
 * Sub-cent totals get four decimals — most single turns land there, and
 * rounding them to `$0.00` makes the figure useless exactly when a user is
 * checking whether anything is being spent at all.
 */
export function formatCost(usd: number | null): string | null {
  if (usd == null || !Number.isFinite(usd)) return null
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
