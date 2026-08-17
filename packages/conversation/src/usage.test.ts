import { describe, expect, it } from 'vitest'
import {
  estimateCost,
  formatCost,
  formatTokens,
  rateFor,
  tokenTotals,
} from './usage'

describe('tokenTotals', () => {
  it('keeps the four billing categories apart', () => {
    // Folding cache reads into input overstates the cost of exactly the
    // workloads caching exists to make cheap.
    const totals = tokenTotals({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 200,
    })
    expect(totals).toEqual({ input: 100, output: 50, cacheRead: 900, cacheWrite: 200, total: 1250 })
  })

  it('ignores non-billable counters the provider adds alongside', () => {
    const totals = tokenTotals({ input_tokens: 10, service_tier_requests: 4 })
    expect(totals.total).toBe(10)
  })

  it('treats missing, negative and non-finite values as zero', () => {
    expect(tokenTotals(null).total).toBe(0)
    expect(tokenTotals({ input_tokens: -5 }).input).toBe(0)
    expect(tokenTotals({ input_tokens: Number.NaN }).input).toBe(0)
  })
})

describe('rateFor', () => {
  it('matches ids that arrive dated or region-prefixed', () => {
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual(rateFor('haiku-4-5'))
    expect(rateFor('us.anthropic.claude-opus-5')).toEqual(rateFor('opus-5'))
  })

  it('prefers the longest match so a specific entry beats a generic one', () => {
    expect(rateFor('claude-opus-5')?.input).toBe(5)
    expect(rateFor('claude-opus-4-1')?.input).toBe(15)
  })

  it('returns null for a model it has no price for', () => {
    expect(rateFor('llama-3-70b')).toBeNull()
    expect(rateFor('')).toBeNull()
    expect(rateFor(null)).toBeNull()
  })
})

describe('estimateCost', () => {
  it('prices each category at its own rate', () => {
    const totals = tokenTotals({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    })
    // sonnet: 3 + 15 + 0.3 + 3.75
    expect(estimateCost(totals, 'claude-sonnet-5')).toBeCloseTo(22.05, 5)
  })

  it('returns null rather than zero for an unknown model', () => {
    // `$0.00` reads as "this run was free", which is the one wrong answer.
    expect(estimateCost(tokenTotals({ input_tokens: 5000 }), 'mystery-model')).toBeNull()
  })
})

describe('formatTokens', () => {
  it('drops precision as magnitude rises', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12_400)).toBe('12k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('never renders a negative or non-finite count', () => {
    expect(formatTokens(-1)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('formatCost', () => {
  it('keeps sub-cent totals visible', () => {
    // Most single turns land here; rounding them to $0.00 makes the figure
    // useless exactly when someone is checking whether anything is spent.
    expect(formatCost(0.0004)).toBe('$0.0004')
    expect(formatCost(0.5)).toBe('$0.500')
    expect(formatCost(12.345)).toBe('$12.35')
  })

  it('passes null through so the caller can omit the figure', () => {
    expect(formatCost(null)).toBeNull()
    expect(formatCost(Number.NaN)).toBeNull()
  })
})
