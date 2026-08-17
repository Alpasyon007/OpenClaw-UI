/**
 * Catalogue entry shape.
 *
 * Structurally identical to `CatalogPlugin` in `src/shared/types.ts`, which the
 * desktop renderer still imports. The desktop's copy is the one that predates
 * this package; folding it into this type means editing a file the shim
 * generator parses and rebuilding the committed sidecar bundle, so it is left
 * for a follow-up rather than bundled into a feature change. **If the two ever
 * disagree, this comment is where the bug came from.**
 */
export interface CatalogEntry {
  /** Unique: `${repo}/${sourcePath}`. */
  id: string
  name: string
  description: string
  version: string
  author: string
  /** Marketplace display name, from its `marketplace.json`. */
  marketplace: string
  /** `owner/repo`, empty for entries that did not come from GitHub. */
  repo: string
  /** Path within the repo, e.g. `skills/xlsx`. */
  sourcePath: string
  /** The directory name a skill installs to. */
  installName: string
  category: string
  /** Derived use-case tags, capped at two. */
  tags: string[]
  /** True for a single `SKILL.md`; false for a CLI plugin bundle. */
  isSkillMd: boolean
  /**
   * How the entry is installed — and `gateway` means it already is.
   *
   * `native` writes a `SKILL.md`, `clawhub` needs the ClawHub CLI, `gateway`
   * came from the runtime's own inventory and is not installable at all.
   */
  installMode?: 'native' | 'clawhub' | 'gateway'
  installCommand?: string
  externalUrl?: string
  /** Gateway entries only: which runtime the skill came from. */
  gatewaySource?: string
  /** Gateway entries only: false when present but not currently usable. */
  gatewayReady?: boolean
  /** Gateway entries only: why not, e.g. `macOS only · needs memo`. */
  gatewayBlockReason?: string
}

/**
 * The subset of `fetch` this package needs.
 *
 * Injected rather than taken from the global so the module stays runtime-free:
 * the same code has to work under Node in the sidecar and under Hermes on the
 * phone, and a test needs to run it against neither.
 */
export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; body: string }>

export interface CatalogResult {
  entries: CatalogEntry[]
  /** Non-fatal problems. A partial catalogue is still worth showing. */
  errors: string[]
}
