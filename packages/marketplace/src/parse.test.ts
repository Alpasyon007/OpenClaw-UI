import { describe, expect, it } from 'vitest'
import {
  describeGatewayBlock,
  deriveSemanticTags,
  gatewaySkillsToEntries,
  mergeGatewayEntries,
  parseAwesomeCategory,
  parseAwesomeCategoryPaths,
  parseSkillFrontmatter,
  sortEntries,
} from './parse'
import type { CatalogEntry } from './types'

const entry = (patch: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'repo/path',
  name: 'Name',
  description: 'Description',
  version: '1.0.0',
  author: 'Author',
  marketplace: 'Marketplace',
  repo: 'owner/repo',
  sourcePath: 'skills/thing',
  installName: 'thing',
  category: 'Agent Skills',
  tags: [],
  isSkillMd: true,
  installMode: 'native',
  ...patch,
})

describe('parseSkillFrontmatter', () => {
  it('reads unfenced frontmatter, as the Anthropic skills repo writes it', () => {
    const { name, description } = parseSkillFrontmatter('name: xlsx\ndescription: Spreadsheets\n\n# Body')
    expect(name).toBe('xlsx')
    expect(description).toBe('Spreadsheets')
  })

  it('reads fenced frontmatter too', () => {
    const { name } = parseSkillFrontmatter('---\nname: pdf\ndescription: PDFs\n---\n\n# Body')
    expect(name).toBe('pdf')
  })

  it('stops at the first heading so prose cannot supply the values', () => {
    const { description } = parseSkillFrontmatter('name: x\n\n# Heading\ndescription: wrong')
    expect(description).toBe('')
  })

  it('strips surrounding quotes', () => {
    expect(parseSkillFrontmatter('name: "quoted"').name).toBe('quoted')
    expect(parseSkillFrontmatter("name: 'quoted'").name).toBe('quoted')
  })

  it('truncates a very long description', () => {
    const long = `description: ${'x'.repeat(400)}`
    expect(parseSkillFrontmatter(long).description).toHaveLength(200)
  })
})

describe('deriveSemanticTags', () => {
  it('derives use-case tags from meaning', () => {
    expect(deriveSemanticTags('xlsx', 'Work with spreadsheets and pivot tables', 'skills/xlsx')).toContain(
      'Spreadsheet',
    )
  })

  it('caps at two so a chip row does not wrap', () => {
    const tags = deriveSemanticTags(
      'everything',
      'design product research docs spreadsheet slides analysis finance',
      'x',
    )
    expect(tags.length).toBeLessThanOrEqual(2)
  })
})

describe('parseAwesomeCategoryPaths', () => {
  it('finds and de-duplicates category links', () => {
    const readme = '[a](categories/dev.md) [b](categories/dev.md) [c](categories/ops.md)'
    expect(parseAwesomeCategoryPaths(readme)).toEqual(['categories/dev.md', 'categories/ops.md'])
  })
})

describe('parseAwesomeCategory', () => {
  it('reads ClawHub rows and marks them as not natively installable', () => {
    const body = [
      '# Developer Tools',
      '- [Thing](https://clawskills.sh/skills/acme-thing) - Does a thing',
      '- not a row',
    ].join('\n')

    const [row] = parseAwesomeCategory('categories/dev.md', body, 'VoltAgent/awesome', 'Awesome')
    expect(row).toMatchObject({
      name: 'Thing',
      installName: 'acme-thing',
      category: 'Developer Tools',
      installMode: 'clawhub',
      installCommand: 'clawhub install acme-thing',
    })
  })

  it('returns nothing for a document with no rows', () => {
    expect(parseAwesomeCategory('categories/x.md', '# Empty', 'r', 'm')).toEqual([])
  })
})

describe('describeGatewayBlock', () => {
  it('leads with the requirement nobody can install their way out of', () => {
    expect(describeGatewayBlock({ os: ['darwin'], bins: ['memo'] })).toBe('macOS only · needs memo')
  })

  it('is undefined when nothing is missing', () => {
    expect(describeGatewayBlock(undefined)).toBeUndefined()
    expect(describeGatewayBlock({})).toBeUndefined()
  })
})

describe('gatewaySkillsToEntries', () => {
  it('marks a skill blocked when either flag says so', () => {
    const [disabled, ineligible] = gatewaySkillsToEntries([
      { name: 'a', disabled: true },
      { name: 'b', eligible: false, missing: { os: ['win32'] } },
    ])
    expect(disabled.gatewayReady).toBe(false)
    expect(ineligible.gatewayBlockReason).toBe('Windows only')
  })

  it('drops entries with no name rather than rendering a blank row', () => {
    expect(gatewaySkillsToEntries([{ description: 'orphan' }])).toEqual([])
  })

  it('never tags a row "Installed", which would collide with the UI chip', () => {
    const [row] = gatewaySkillsToEntries([{ name: 'x' }])
    expect(row.tags).not.toContain('Installed')
    expect(row.tags[0]).toBe('Gateway')
  })
})

describe('mergeGatewayEntries', () => {
  it('lets a gateway skill replace a same-named catalogue entry', () => {
    const merged = mergeGatewayEntries(
      [entry({ installName: 'xlsx' }), entry({ installName: 'pdf' })],
      [entry({ installName: 'XLSX', installMode: 'gateway' })],
    )
    expect(merged).toHaveLength(2)
    expect(merged.filter((e) => e.installName.toLowerCase() === 'xlsx')).toHaveLength(1)
  })

  it('returns the catalogue untouched when the gateway reported nothing', () => {
    const catalogue = [entry()]
    expect(mergeGatewayEntries(catalogue, [])).toEqual(catalogue)
  })
})

describe('sortEntries', () => {
  it('puts ready gateway skills first, then blocked ones, then the catalogue', () => {
    const sorted = sortEntries([
      entry({ installName: 'catalogue', name: 'A catalogue skill' }),
      entry({ installName: 'blocked', installMode: 'gateway', gatewayReady: false }),
      entry({ installName: 'ready', installMode: 'gateway', gatewayReady: true }),
    ])
    expect(sorted.map((e) => e.installName)).toEqual(['ready', 'blocked', 'catalogue'])
  })

  it('sorts gateway rows on installName so a leading emoji does not drive order', () => {
    const sorted = sortEntries([
      entry({ installName: 'beta', name: '🅰 beta', installMode: 'gateway', gatewayReady: true }),
      entry({ installName: 'alpha', name: '🅱 alpha', installMode: 'gateway', gatewayReady: true }),
    ])
    expect(sorted.map((e) => e.installName)).toEqual(['alpha', 'beta'])
  })
})
