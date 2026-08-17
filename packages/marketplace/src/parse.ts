/**
 * Parsing the catalogue sources.
 *
 * Pure string work, no I/O. Split out from the fetching so the formats — which
 * are other people's repositories and change without warning — can be tested
 * against fixtures rather than against the network.
 */
import type { CatalogEntry } from './types'

// ─── SKILL.md frontmatter ───

/**
 * Read `name` and `description` out of a `SKILL.md`.
 *
 * The delimiters are optional in practice: the Anthropic skills repo writes
 * bare `key: value` lines at the top of the file with no `---` fence, while
 * community skills usually fence them. Both are accepted, and parsing stops at
 * the first markdown heading so a `description:` mentioned in prose halfway
 * down the document cannot be picked up as the real one.
 */
export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  let name = ''
  let description = ''

  for (const line of content.split('\n')) {
    if (line.trim() === '---') continue
    if (line.startsWith('# ')) break

    if (!name) {
      const match = line.match(/^name:\s*(.+)/)
      if (match) name = unquote(match[1])
    }
    if (!description) {
      const match = line.match(/^description:\s*(.+)/)
      if (match) description = truncate(unquote(match[1]), 200)
    }
    if (name && description) break
  }

  return { name, description }
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim()
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

// ─── Semantic tags ───

/**
 * Use-case tags derived from what an entry *is*, not where it came from.
 *
 * Provenance (repo, author, marketplace) stays in the metadata fields; a tag
 * list that mixes "Finance" with "anthropics/skills" is useless for filtering
 * because half the values match everything.
 */
const TAG_RULES: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: 'Design', pattern: /\b(figma|ui|ux|design|sketch|prototype|wireframe|layout|css|style|visual)\b/i },
  { tag: 'Product', pattern: /\b(prd|roadmap|strategy|product|backlog|prioriti[sz]|feature\s*request|user\s*stor)\b/i },
  { tag: 'Research', pattern: /\b(research|interview|insights?|survey|user\s*study|ethnograph|discover)\b/i },
  { tag: 'Docs', pattern: /\b(doc(ument)?s?|writing|spec(ification)?|readme|markdown|technical\s*writ|content)\b/i },
  { tag: 'Spreadsheet', pattern: /\b(sheet|spreadsheet|xlsx?|csv|tabular|pivot|formula)\b/i },
  { tag: 'Slides', pattern: /\b(slides?|presentation|deck|pptx?|keynote|pitch)\b/i },
  { tag: 'Analysis', pattern: /\b(analy[sz](is|e|ing)|insight|metric|dashboard|report(ing)?|data\s*viz|statistic)\b/i },
  { tag: 'Finance', pattern: /\b(financ|accounting|budget|revenue|forecast|valuation|portfolio|investment)\b/i },
  { tag: 'Compliance', pattern: /\b(risk|audit|policy|compliance|regulat|governance|sox|gdpr|hipaa)\b/i },
  { tag: 'Management', pattern: /\b(manag|planning|meeting|ops|operations|team|workflow|project\s*plan)\b/i },
  { tag: 'Automation', pattern: /\b(automat|workflow|pipeline|ci\s*cd|deploy|integrat|orchestrat|script)\b/i },
  { tag: 'Code', pattern: /\b(code|coding|program|develop|engineer|debug|refactor|test(ing)?|linter?)\b/i },
  { tag: 'Creative', pattern: /\b(creative|brainstorm|ideation|copywriting|storytelling|narrative)\b/i },
  { tag: 'Sales', pattern: /\b(sales|crm|prospect|lead|deal|pipeline|outreach|cold\s*(call|email))\b/i },
  { tag: 'Support', pattern: /\b(support|customer|helpdesk|ticket|troubleshoot|faq|knowledge\s*base)\b/i },
  { tag: 'Security', pattern: /\b(secur|vulnerabilit|pentest|threat|encrypt|auth(enticat|ori[sz]))\b/i },
  { tag: 'Data', pattern: /\b(data|database|sql|etl|warehouse|lake|ingest|transform|schema)\b/i },
  { tag: 'AI/ML', pattern: /\b(ai|ml|machine\s*learn|model|train|inference|llm|prompt|embed)\b/i },
]

/** At most two tags — a chip row that wraps to three lines filters nothing. */
export function deriveSemanticTags(name: string, description: string, path: string): string[] {
  const text = `${name} ${description} ${path}`.toLowerCase()
  const matched: string[] = []
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(text)) matched.push(rule.tag)
    if (matched.length >= 2) break
  }
  return matched
}

// ─── The awesome-openclaw-skills list ───

/** Category document paths linked from the list's README. */
export function parseAwesomeCategoryPaths(readme: string): string[] {
  const paths = new Set<string>()
  for (const match of readme.matchAll(/\(categories\/([a-z0-9-]+\.md)\)/gi)) {
    paths.add(`categories/${match[1]}`)
  }
  return [...paths]
}

/**
 * Entries from one category document.
 *
 * These are ClawHub links, not repositories — there is no `SKILL.md` to fetch
 * and nothing to write locally, which is why they carry `installMode: 'clawhub'`
 * and an explicit command instead of an install action that would fail.
 */
export function parseAwesomeCategory(
  path: string,
  body: string,
  repo: string,
  marketplace: string,
): CatalogEntry[] {
  const lines = body.split('\n')
  const heading = lines.find((l) => l.startsWith('# '))?.replace(/^#\s+/, '').trim() || 'Community'
  const entries: CatalogEntry[] = []

  for (const line of lines) {
    const match = line.match(
      /^- \[([^\]]+)\]\((https:\/\/clawskills\.sh\/skills\/([^)/\s]+))\)\s*-\s*(.+)$/i,
    )
    if (!match) continue

    const name = match[1].trim()
    const externalUrl = match[2].trim()
    const slug = match[3].trim().toLowerCase()
    const description = match[4].trim()

    entries.push({
      id: `${repo}/${slug}`,
      name,
      description,
      version: 'community',
      author: slug.includes('-') ? slug.split('-')[0] : 'community',
      marketplace,
      repo,
      sourcePath: `${path}#${slug}`,
      installName: slug,
      category: heading,
      tags: [...new Set(['Community', ...deriveSemanticTags(name, description, `${path}#${slug}`)])],
      isSkillMd: false,
      installMode: 'clawhub',
      installCommand: `clawhub install ${slug}`,
      externalUrl,
    })
  }

  return entries
}

// ─── Gateway inventory ───

const OS_LABELS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export interface GatewayMissing {
  bins?: string[]
  anyBins?: string[]
  env?: string[]
  config?: string[]
  os?: string[]
}

/**
 * Why a skill is present but not runnable, in words a reader can act on.
 *
 * OS first: it is the one requirement nobody can resolve by installing
 * something, so leading with it stops a user chasing a missing binary on a
 * platform where the skill would never run anyway.
 */
export function describeGatewayBlock(missing?: GatewayMissing): string | undefined {
  if (!missing) return undefined
  const parts: string[] = []

  const os = missing.os ?? []
  if (os.length > 0) parts.push(`${os.map((o) => OS_LABELS[o] ?? o).join('/')} only`)
  const bins = missing.bins ?? []
  if (bins.length > 0) parts.push(`needs ${bins.join(', ')}`)
  const anyBins = missing.anyBins ?? []
  if (anyBins.length > 0) parts.push(`needs one of ${anyBins.join(' or ')}`)
  const env = missing.env ?? []
  if (env.length > 0) parts.push(`needs ${env.join(', ')}`)
  const config = missing.config ?? []
  if (config.length > 0) parts.push(`needs config ${config.join(', ')}`)

  return parts.length > 0 ? parts.join(' · ') : undefined
}

const GATEWAY_CATEGORIES: Record<string, string> = {
  'openclaw-bundled': 'Bundled',
  'openclaw-extra': 'Extra',
  'openclaw-workspace': 'Workspace',
}

export interface RawGatewaySkill {
  name?: string
  description?: string
  emoji?: string
  source?: string
  disabled?: boolean
  eligible?: boolean
  homepage?: string
  missing?: GatewayMissing
}

/**
 * The runtime's own skills as catalogue entries.
 *
 * Skills that are present but blocked are included rather than filtered out,
 * carrying `gatewayReady: false` and a reason — hiding them answers "do I have
 * this?" with a silent no, which is the wrong answer.
 */
export function gatewaySkillsToEntries(skills: readonly RawGatewaySkill[]): CatalogEntry[] {
  const entries: CatalogEntry[] = []

  for (const skill of skills) {
    const name = (skill.name ?? '').trim()
    if (!name) continue

    const description = (skill.description ?? '').trim() || 'No description provided.'
    const source = skill.source || 'openclaw'
    // `disabled` and `eligible` agree in practice, but either one alone being
    // false is enough not to present the skill as ready to run.
    const ready = !skill.disabled && skill.eligible !== false

    entries.push({
      id: `gateway/${name}`,
      name: skill.emoji ? `${skill.emoji} ${name}` : name,
      description,
      version: 'on gateway',
      author: source,
      marketplace: 'Your Gateway',
      repo: '',
      sourcePath: '',
      installName: name,
      category: GATEWAY_CATEGORIES[source] ?? 'On Your Gateway',
      // Not 'Installed': the UI appends its own chip with that text, and a
      // derived tag of the same string collides with it on the React key.
      tags: [...new Set(['Gateway', ...deriveSemanticTags(name, description, source)])],
      isSkillMd: false,
      installMode: 'gateway',
      installCommand: `openclaw skills info ${name}`,
      externalUrl: skill.homepage,
      gatewaySource: source,
      gatewayReady: ready,
      gatewayBlockReason: ready ? undefined : describeGatewayBlock(skill.missing),
    })
  }

  return entries
}

// ─── Ordering ───

/**
 * What you already have first, then what is present but blocked, then the rest.
 *
 * Scattered alphabetically through a thousand-odd installable entries, the
 * gateway's own skills are no more findable than if they were absent. Gateway
 * rows sort on `installName` so a leading emoji does not drive the order.
 */
export function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const rank = (e: CatalogEntry): number =>
    e.installMode !== 'gateway' ? 2 : e.gatewayReady === false ? 1 : 0

  return [...entries].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return ra === 2 ? a.name.localeCompare(b.name) : a.installName.localeCompare(b.installName)
  })
}

/**
 * Drop catalogue entries the gateway already reports as installed.
 *
 * One is a thing you have, the other a thing you could install; showing both
 * invites a user to install what is already there. Single pass rather than a
 * `findIndex` per skill — the catalogue runs to well over a thousand rows and
 * this is on the render path.
 */
export function mergeGatewayEntries(
  catalogue: readonly CatalogEntry[],
  gateway: readonly CatalogEntry[],
): CatalogEntry[] {
  if (gateway.length === 0) return [...catalogue]
  const owned = new Set(gateway.map((e) => e.installName.toLowerCase()))
  return [...catalogue.filter((e) => !owned.has(e.installName.toLowerCase())), ...gateway]
}
