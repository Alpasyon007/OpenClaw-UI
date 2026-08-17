/**
 * Fetching the browsable skill catalogue.
 *
 * The sources are public GitHub repositories, so this needs nothing but HTTP —
 * which is what lets the phone build the same catalogue the desktop does rather
 * than proxying it through a gateway that may not be reachable.
 *
 * Two properties the earlier desktop implementation did not have, both of which
 * matter far more on a phone than on a laptop:
 *
 *  - **Bounded concurrency.** A naive fan-out issues 40–70 simultaneous
 *    requests. On a mobile connection that is not faster, it is slower, and it
 *    is the reliable way to have a handful of them time out.
 *  - **A deadline for the whole operation.** Without one, a single stalled
 *    connection holds the spinner up for as long as the platform's default
 *    socket timeout — minutes — with a perfectly good partial catalogue already
 *    in hand. Whatever has arrived when the deadline passes is returned.
 */
import {
  deriveSemanticTags,
  parseAwesomeCategory,
  parseAwesomeCategoryPaths,
  parseSkillFrontmatter,
  sortEntries,
} from './parse'
import type { CatalogEntry, CatalogResult, FetchText } from './types'

const SOURCES = [
  { repo: 'anthropics/skills', category: 'Agent Skills' },
  { repo: 'anthropics/knowledge-work-plugins', category: 'Knowledge Work' },
  { repo: 'anthropics/financial-services-plugins', category: 'Financial Services' },
] as const

const AWESOME_REPO = 'VoltAgent/awesome-openclaw-skills'
const AWESOME_MARKETPLACE = 'Awesome OpenClaw Skills'
const AWESOME_RAW_BASE = `https://raw.githubusercontent.com/${AWESOME_REPO}/main`

/** Enough to fill any amount of scrolling; a guard, not a design constraint. */
const AWESOME_LIMIT = 1400

export interface FetchCatalogOptions {
  fetchText: FetchText
  /** Simultaneous requests. Tuned for a mobile radio, not a datacentre. */
  concurrency?: number
  /** Whole-operation deadline. Partial results are returned, never discarded. */
  deadlineMs?: number
  /** Injected for tests. */
  now?: () => number
  /** Raw `SKILL.md` bodies are handed back here so an install need not refetch. */
  onSkillContent?: (installName: string, content: string) => void
}

/**
 * Build the catalogue.
 *
 * Never rejects. A source that fails contributes an entry to `errors` and
 * nothing to `entries`, because a catalogue missing one repository is still
 * worth showing and an exception here would leave the user with an empty
 * screen and a stack trace.
 */
export async function fetchCatalog(options: FetchCatalogOptions): Promise<CatalogResult> {
  const {
    fetchText,
    concurrency = 6,
    deadlineMs = 25_000,
    now = () => Date.now(),
    onSkillContent,
  } = options

  const startedAt = now()
  const expired = (): boolean => now() - startedAt >= deadlineMs
  const errors: string[] = []
  const entries: CatalogEntry[] = []

  const jobs: Array<() => Promise<void>> = []

  for (const source of SOURCES) {
    jobs.push(async () => {
      try {
        const marketplaceEntries = await fetchMarketplace(
          source.repo,
          source.category,
          fetchText,
          concurrency,
          expired,
          onSkillContent,
        )
        entries.push(...marketplaceEntries)
      } catch (err) {
        errors.push(`${source.repo}: ${describe(err)}`)
      }
    })
  }

  jobs.push(async () => {
    try {
      entries.push(...(await fetchAwesome(fetchText, concurrency, expired)))
    } catch (err) {
      errors.push(`${AWESOME_REPO}: ${describe(err)}`)
    }
  })

  await runPool(jobs, Math.max(1, Math.min(concurrency, jobs.length)))

  if (entries.length === 0 && errors.length > 0) return { entries: [], errors }
  if (expired() && entries.length > 0) {
    errors.push('Catalogue fetch hit its time limit — this list may be incomplete.')
  }

  return { entries: sortEntries(entries), errors }
}

// ─── One marketplace repository ───

interface MarketplaceJson {
  name?: string
  plugins?: Array<{
    name: string
    source: string
    description?: string
    author?: { name?: string } | string
    skills?: string[]
  }>
}

async function fetchMarketplace(
  repo: string,
  category: string,
  fetchText: FetchText,
  concurrency: number,
  expired: () => boolean,
  onSkillContent?: (installName: string, content: string) => void,
): Promise<CatalogEntry[]> {
  const url = `https://raw.githubusercontent.com/${repo}/main/.claude-plugin/marketplace.json`
  const res = await fetchText(url)
  if (!res.ok) throw new Error(`marketplace.json returned ${res.status}`)

  const data = JSON.parse(res.body) as MarketplaceJson
  const marketplaceName = (data.name ?? '').trim() || repo

  interface Job {
    installName: string
    sourcePath: string
    description: string
    author: string
    useSkillMd: boolean
  }

  const jobs: Job[] = []
  for (const entry of data.plugins ?? []) {
    const author =
      typeof entry.author === 'string' ? entry.author : (entry.author?.name ?? '')

    if (entry.skills && entry.skills.length > 0) {
      // A skills repo: each listed path is its own installable skill, not one
      // bundle. Expanding them is what makes an individual skill findable.
      for (const ref of entry.skills) {
        const sourcePath = normalisePath(ref)
        jobs.push({
          installName: sourcePath.split('/').pop() || entry.name,
          sourcePath,
          description: entry.description ?? '',
          author,
          useSkillMd: true,
        })
      }
    } else {
      const sourcePath = normalisePath(entry.source)
      jobs.push({
        installName: entry.name,
        sourcePath: sourcePath || entry.name,
        description: entry.description ?? '',
        author,
        useSkillMd: false,
      })
    }
  }

  const out: CatalogEntry[] = []
  await runPool(
    jobs.map((job) => async () => {
      // Past the deadline, still emit the entry from what the marketplace index
      // already told us. A row with a directory name and the marketplace's own
      // description is far more useful than no row.
      let name = ''
      let description = ''
      let version = '0.0.0'
      let author = job.author || 'Anthropic'

      if (!expired()) {
        try {
          if (job.useSkillMd) {
            const skill = await fetchText(
              `https://raw.githubusercontent.com/${repo}/main/${job.sourcePath}/SKILL.md`,
            )
            if (skill.ok) {
              const parsed = parseSkillFrontmatter(skill.body)
              name = parsed.name
              description = parsed.description
              onSkillContent?.(job.installName, skill.body)
            }
          } else {
            const manifest = await fetchText(
              `https://raw.githubusercontent.com/${repo}/main/${job.sourcePath}/.claude-plugin/plugin.json`,
            )
            if (manifest.ok) {
              const parsed = JSON.parse(manifest.body) as Record<string, string | undefined>
              name = (parsed.name ?? '').trim()
              description = parsed.description ?? ''
              version = (parsed.version ?? '').trim() || version
              author = (parsed.author ?? '').trim() || author
            }
          }
        } catch {
          // A single unreadable manifest is not a source failure. Fall through
          // to the index-derived values below.
        }
      }

      const dirName = job.sourcePath.split('/').pop() || job.installName
      out.push({
        id: `${repo}/${job.sourcePath}`,
        name: name || dirName,
        description: description || job.description,
        version,
        author,
        marketplace: marketplaceName,
        repo,
        sourcePath: job.sourcePath,
        installName: job.installName,
        category,
        tags: deriveSemanticTags(name || dirName, description || job.description, job.sourcePath),
        isSkillMd: job.useSkillMd,
        installMode: 'native',
      })
    }),
    concurrency,
  )

  return out
}

function normalisePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\/$/, '')
}

// ─── The community list ───

async function fetchAwesome(
  fetchText: FetchText,
  concurrency: number,
  expired: () => boolean,
): Promise<CatalogEntry[]> {
  const readme = await fetchText(`${AWESOME_RAW_BASE}/README.md`)
  if (!readme.ok) throw new Error(`README returned ${readme.status}`)

  const paths = parseAwesomeCategoryPaths(readme.body)
  const entries: CatalogEntry[] = []

  await runPool(
    paths.map((path) => async () => {
      if (expired() || entries.length >= AWESOME_LIMIT) return
      const doc = await fetchText(`${AWESOME_RAW_BASE}/${path}`)
      if (!doc.ok) return
      entries.push(...parseAwesomeCategory(path, doc.body, AWESOME_REPO, AWESOME_MARKETPLACE))
    }),
    concurrency,
  )

  return entries.slice(0, AWESOME_LIMIT)
}

// ─── Plumbing ───

/**
 * Run thunks with at most `limit` in flight.
 *
 * A rejected thunk is swallowed rather than allowed to abort the pool — every
 * caller here already records its own failures, and one bad URL must not cancel
 * the requests running alongside it.
 */
async function runPool(jobs: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= jobs.length) return
      try {
        await jobs[index]()
      } catch {
        // Recorded by the caller, if it cares.
      }
    }
  })
  await Promise.all(workers)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fetch one skill's `SKILL.md`, for installing an entry the catalogue pass did
 * not cache the body of.
 */
export async function fetchSkillContent(
  entry: CatalogEntry,
  fetchText: FetchText,
): Promise<string> {
  if (!entry.repo) throw new Error('This entry does not come from a repository.')
  const path = entry.sourcePath || `skills/${entry.installName}`
  const res = await fetchText(`https://raw.githubusercontent.com/${entry.repo}/main/${path}/SKILL.md`)
  if (!res.ok) throw new Error(`SKILL.md returned ${res.status}`)
  return res.body
}

export { AWESOME_REPO, AWESOME_MARKETPLACE, SOURCES }
