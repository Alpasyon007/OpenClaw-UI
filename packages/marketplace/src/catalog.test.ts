import { describe, expect, it, vi } from 'vitest'
import { fetchCatalog, fetchSkillContent } from './catalog'
import type { FetchText } from './types'

const marketplaceJson = JSON.stringify({
  name: 'Agent Skills',
  plugins: [{ name: 'bundle', source: './bundle', description: 'A bundle', skills: ['./skills/xlsx'] }],
})

/** A fetcher that answers from a fixture map and 404s everything else. */
function fixtureFetch(files: Record<string, string>): FetchText {
  return async (url) => {
    const key = Object.keys(files).find((k) => url.endsWith(k))
    return key
      ? { ok: true, status: 200, body: files[key] }
      : { ok: false, status: 404, body: '' }
  }
}

describe('fetchCatalog', () => {
  it('expands a skills[] entry into one row per skill', async () => {
    const result = await fetchCatalog({
      fetchText: fixtureFetch({
        'anthropics/skills/main/.claude-plugin/marketplace.json': marketplaceJson,
        'skills/xlsx/SKILL.md': 'name: xlsx\ndescription: Spreadsheets',
      }),
    })

    const xlsx = result.entries.find((e) => e.installName === 'xlsx')
    expect(xlsx).toMatchObject({ name: 'xlsx', description: 'Spreadsheets', isSkillMd: true })
  })

  it('still emits a row when a SKILL.md cannot be fetched', async () => {
    // A row carrying the directory name and the marketplace's own description
    // is far more useful than no row at all.
    const result = await fetchCatalog({
      fetchText: fixtureFetch({
        'anthropics/skills/main/.claude-plugin/marketplace.json': marketplaceJson,
      }),
    })

    const xlsx = result.entries.find((e) => e.installName === 'xlsx')
    expect(xlsx).toMatchObject({ name: 'xlsx', description: 'A bundle' })
  })

  it('hands back SKILL.md bodies so an install need not refetch', async () => {
    const onSkillContent = vi.fn()
    await fetchCatalog({
      fetchText: fixtureFetch({
        'anthropics/skills/main/.claude-plugin/marketplace.json': marketplaceJson,
        'skills/xlsx/SKILL.md': 'name: xlsx\ndescription: Spreadsheets',
      }),
      onSkillContent,
    })
    expect(onSkillContent).toHaveBeenCalledWith('xlsx', 'name: xlsx\ndescription: Spreadsheets')
  })

  it('never rejects, and records a failing source as a warning', async () => {
    const result = await fetchCatalog({ fetchText: async () => ({ ok: false, status: 500, body: '' }) })
    expect(result.entries).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns a partial catalogue rather than nothing when one source fails', async () => {
    const result = await fetchCatalog({
      fetchText: fixtureFetch({
        'anthropics/skills/main/.claude-plugin/marketplace.json': marketplaceJson,
        'skills/xlsx/SKILL.md': 'name: xlsx\ndescription: Spreadsheets',
      }),
    })
    expect(result.entries.length).toBeGreaterThan(0)
    // The other two sources and the community list all 404'd in this fixture.
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('honours the deadline and says the result may be incomplete', async () => {
    let clock = 0
    const result = await fetchCatalog({
      fetchText: fixtureFetch({
        'anthropics/skills/main/.claude-plugin/marketplace.json': marketplaceJson,
      }),
      deadlineMs: 10,
      // Advances past the deadline on the second read, after the index is in
      // hand but before the per-skill fetches.
      now: () => (clock += 20),
    })
    expect(result.errors.some((e) => /time limit/i.test(e))).toBe(true)
  })

  it('bounds concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const fetchText: FetchText = async (url) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return url.endsWith('marketplace.json')
        ? { ok: true, status: 200, body: marketplaceJson }
        : { ok: false, status: 404, body: '' }
    }

    await fetchCatalog({ fetchText, concurrency: 2 })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('parses the community list into ClawHub rows', async () => {
    const result = await fetchCatalog({
      fetchText: fixtureFetch({
        'awesome-openclaw-skills/main/README.md': '[dev](categories/dev.md)',
        'categories/dev.md': '# Dev\n- [Thing](https://clawskills.sh/skills/acme) - Does a thing',
      }),
    })
    expect(result.entries.find((e) => e.installName === 'acme')).toMatchObject({
      installMode: 'clawhub',
      installCommand: 'clawhub install acme',
    })
  })
})

describe('fetchSkillContent', () => {
  it('fetches the SKILL.md for a repository entry', async () => {
    const body = await fetchSkillContent(
      {
        id: 'x',
        name: 'x',
        description: '',
        version: '',
        author: '',
        marketplace: '',
        repo: 'owner/repo',
        sourcePath: 'skills/x',
        installName: 'x',
        category: '',
        tags: [],
        isSkillMd: true,
      },
      fixtureFetch({ 'owner/repo/main/skills/x/SKILL.md': 'name: x' }),
    )
    expect(body).toBe('name: x')
  })

  it('refuses an entry with no repository rather than fetching a bad URL', async () => {
    await expect(
      fetchSkillContent(
        {
          id: 'gateway/x',
          name: 'x',
          description: '',
          version: '',
          author: '',
          marketplace: '',
          repo: '',
          sourcePath: '',
          installName: 'x',
          category: '',
          tags: [],
          isSkillMd: false,
        },
        fixtureFetch({}),
      ),
    ).rejects.toThrow(/repository/)
  })
})
