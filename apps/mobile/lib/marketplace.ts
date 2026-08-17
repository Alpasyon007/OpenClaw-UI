/**
 * The skill marketplace, as the phone sees it.
 *
 * Two independent sources, and keeping them separate matters:
 *
 *  - **The catalogue** is public GitHub content, fetched straight from the
 *    phone. It works with no gateway at all, which is the right behaviour —
 *    browsing what exists should not require a connection to your own runtime.
 *  - **The inventory** is what your gateway actually has, via `skills.list`.
 *    Only this can answer "do I have it?", and it is the only part that needs a
 *    connection.
 *
 * Installing needs `operator.admin`, which a companion device does not hold by
 * default. That is not treated as an error: the entry stays browsable and the
 * UI offers the CLI command instead, because a phone that cannot install is
 * still a perfectly good way to find something and run one line on the desktop.
 */
import { create } from 'zustand'
import {
  fetchCatalog,
  fetchSkillContent,
  gatewaySkillsToEntries,
  mergeGatewayEntries,
  sortEntries,
  type CatalogEntry,
  type FetchText,
} from '@openclaw/marketplace'
import { M, SkillsListResultSchema, explainCapability } from '@openclaw/protocol'
import { currentCapabilities, tracked, useApp } from './store'
import { readDoc, writeDoc } from './storage'

const CACHE_DOC = 'marketplace-cache'
/** Long enough that reopening the screen is instant, short enough to stay true. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export type InstallState = 'idle' | 'installing' | 'installed' | 'failed'

interface CacheDoc {
  fetchedAt: number
  entries: CatalogEntry[]
}

interface MarketplaceState {
  entries: CatalogEntry[]
  /** Skill names the gateway reports as present. */
  installed: string[]
  loading: boolean
  /** Non-fatal problems from the last fetch. */
  warnings: string[]
  /** Why installing is unavailable, if it is. */
  installBlocked: string | null
  install: Record<string, InstallState>
  installError: Record<string, string>
  /** Epoch of the catalogue currently in `entries`, or 0. */
  fetchedAt: number

  load: (options?: { force?: boolean }) => Promise<void>
  refreshInventory: () => Promise<void>
  installSkill: (entry: CatalogEntry) => Promise<void>
  uninstallSkill: (name: string) => Promise<void>
  /** Used by the skill builder to push a hand-written SKILL.md. */
  installRaw: (name: string, content: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * `fetch` adapted to the shape the catalogue package wants.
 *
 * Every request carries its own timeout. Without one a single stalled
 * connection holds a worker in the pool until the platform's default socket
 * timeout — minutes — while the rest of the catalogue sits ready to render.
 */
const fetchText: FetchText = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { ok: response.ok, status: response.status, body: await response.text() }
  } catch {
    return { ok: false, status: 0, body: '' }
  } finally {
    clearTimeout(timer)
  }
}

/** Raw `SKILL.md` bodies seen during the catalogue pass, so installs need no refetch. */
const skillContent = new Map<string, string>()

export const useMarketplace = create<MarketplaceState>((set, get) => ({
  entries: [],
  installed: [],
  loading: false,
  warnings: [],
  installBlocked: null,
  install: {},
  installError: {},
  fetchedAt: 0,

  async load(options) {
    if (get().loading) return
    set({ loading: true })

    try {
      if (!options?.force) {
        const cached = await readDoc<CacheDoc | null>(CACHE_DOC, null)
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.entries.length > 0) {
          set({ entries: cached.entries, fetchedAt: cached.fetchedAt, warnings: [] })
          // Still refresh the inventory: what the gateway has changes far more
          // often than what GitHub publishes, and it is one cheap request.
          void get().refreshInventory()
          return
        }
      }

      const result = await fetchCatalog({
        fetchText,
        onSkillContent: (name, content) => skillContent.set(name, content),
      })

      set({
        entries: result.entries,
        warnings: result.errors,
        fetchedAt: Date.now(),
      })
      if (result.entries.length > 0) {
        void writeDoc(CACHE_DOC, { fetchedAt: Date.now(), entries: result.entries } satisfies CacheDoc)
      }
    } finally {
      set({ loading: false })
    }

    await get().refreshInventory()
  },

  /**
   * Fold the gateway's own inventory into the catalogue.
   *
   * A gateway that does not implement `skills.list` leaves the catalogue
   * untouched rather than emptying it — the browsable list is the part that
   * works without a runtime, and losing it because the runtime is old would be
   * a strict downgrade.
   */
  async refreshInventory() {
    if (useApp.getState().conn !== 'ready') {
      // Still worth stating. Without this the install buttons render enabled on
      // a disconnected phone and fail one tap later with a connection error,
      // which reads as the marketplace being broken rather than offline.
      set({ installBlocked: 'Not connected to a gateway, so nothing can be installed.' })
      return
    }
    try {
      const raw = await tracked<unknown>(M.SKILLS_LIST, { includeDisabled: true })
      const parsed = SkillsListResultSchema.safeParse(raw)
      if (!parsed.success) return

      const gatewayEntries = gatewaySkillsToEntries(parsed.data.skills)
      set((s) => ({
        entries: sortEntries(mergeGatewayEntries(stripGateway(s.entries), gatewayEntries)),
        installed: gatewayEntries.map((e) => e.installName),
      }))
    } catch {
      // Left as-is: the catalogue is still browsable and saying "could not
      // reach your gateway" on a screen the user opened to browse is noise.
    } finally {
      set({ installBlocked: describeInstallBlock() })
    }
  },

  async installSkill(entry) {
    const name = entry.installName
    if (entry.installMode !== 'native') {
      set((s) => ({
        install: { ...s.install, [name]: 'failed' },
        installError: {
          ...s.installError,
          [name]:
            entry.installMode === 'clawhub'
              ? `Install with: ${entry.installCommand ?? `clawhub install ${name}`}`
              : 'This entry is already on your gateway.',
        },
      }))
      return
    }

    set((s) => ({
      install: { ...s.install, [name]: 'installing' },
      installError: { ...s.installError, [name]: '' },
    }))

    try {
      const content = skillContent.get(name) ?? (await fetchSkillContent(entry, fetchText))
      const outcome = await get().installRaw(name, content)
      if (!outcome.ok) throw new Error(outcome.error ?? 'install failed')

      set((s) => ({
        install: { ...s.install, [name]: 'installed' },
        installed: s.installed.includes(name) ? s.installed : [...s.installed, name],
      }))
      void get().refreshInventory()
    } catch (err) {
      set((s) => ({
        install: { ...s.install, [name]: 'failed' },
        installError: { ...s.installError, [name]: describe(err) },
      }))
    }
  },

  async uninstallSkill(name) {
    try {
      await tracked(M.SKILLS_UNINSTALL, { name })
      set((s) => ({
        installed: s.installed.filter((n) => n !== name),
        install: { ...s.install, [name]: 'idle' },
      }))
      void get().refreshInventory()
    } catch (err) {
      set((s) => ({
        install: { ...s.install, [name]: 'failed' },
        installError: { ...s.installError, [name]: describe(err) },
      }))
    }
  },

  async installRaw(name, content) {
    try {
      await tracked(M.SKILLS_INSTALL, { name, content, source: 'openclaw-companion', overwrite: true })
      return { ok: true }
    } catch (err) {
      // Whether this gateway lacks the method or this device lacks the scope
      // decides which of two different fixes to suggest, so it is worth
      // separating rather than reporting one error for both.
      const capability = currentCapabilities().get(M.SKILLS_INSTALL)
      const explained = explainCapability(capability, 'installing skills')
      set({ installBlocked: explained })
      return { ok: false, error: explained ?? describe(err) }
    }
  },
}))

/** Drop previous gateway rows before folding a fresh inventory in. */
function stripGateway(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.filter((e) => e.installMode !== 'gateway')
}

/**
 * Why installing is unavailable, checked before anything is attempted.
 *
 * The scope check is local and exact — `skills.install` needs `operator.admin`,
 * and a device paired as a companion does not have it. Saying so up front beats
 * letting the user pick a skill, wait, and then read a scope error.
 */
function describeInstallBlock(): string | null {
  const scopes = useApp.getState().scopes
  if (!scopes.includes('operator.admin')) {
    return 'Installing needs the operator.admin scope. Turn it on in Settings and re-approve this device on the gateway.'
  }
  return explainCapability(currentCapabilities().get(M.SKILLS_INSTALL), 'installing skills')
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Categories present in a set of entries, most populous first.
 *
 * Derived rather than hardcoded: the catalogue's categories come from other
 * people's repositories and a fixed list goes stale silently, showing an empty
 * filter chip for a category that no longer exists.
 */
export function categoriesOf(entries: readonly CatalogEntry[]): string[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}
