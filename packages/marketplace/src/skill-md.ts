/**
 * Authoring a `SKILL.md`.
 *
 * The format is a YAML frontmatter block followed by markdown instructions.
 * Two details decide whether a written skill actually loads, and both are easy
 * to get wrong from a form:
 *
 *  - **The directory name is the identity.** A skill installs to
 *    `<skills>/<name>/SKILL.md`, so `name` has to be a safe directory name —
 *    not a title. A skill called "My Great Skill" installs to a path with
 *    spaces in it, and on some runtimes silently never loads.
 *  - **`description` is what the model reads to decide whether to use it.** It
 *    is not a summary for humans. A vague one produces a skill that is
 *    installed and never triggers, which is indistinguishable from a broken
 *    install.
 */

export interface SkillDraft {
  name: string
  description: string
  /** The markdown body: what the model should actually do. */
  instructions: string
  /** Optional metadata some runtimes surface in listings. */
  emoji?: string
  license?: string
}

/** Directory-safe skill names: lowercase, digits, hyphens. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidSkillName(name: string): boolean {
  return SAFE_NAME.test(name)
}

/**
 * Coerce a title into a valid skill name.
 *
 * Applied as the user types the name field, so the value in the box is always
 * the value that will be installed — a form that accepts "My Skill" and quietly
 * installs `my-skill` leaves the user unable to find it afterwards.
 */
export function toSkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
}

export interface SkillValidation {
  ok: boolean
  /** Blocking problems, in the order they should be fixed. */
  errors: string[]
  /** Non-blocking, but worth saying. */
  warnings: string[]
}

export function validateSkill(draft: SkillDraft): SkillValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!draft.name.trim()) errors.push('A name is required.')
  else if (!isValidSkillName(draft.name)) {
    errors.push('The name must be lowercase letters, digits and hyphens — it becomes a directory name.')
  }

  if (!draft.description.trim()) errors.push('A description is required.')
  else if (draft.description.trim().length < 20) {
    // Not an error: a short description is legal and will load. It just will
    // not reliably trigger, and saying so at authoring time is far cheaper than
    // debugging a skill that never fires.
    warnings.push('Short descriptions rarely trigger. Say when the skill should be used, not just what it is.')
  }

  if (!draft.instructions.trim()) errors.push('Instructions are required — the body is what the skill does.')

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Render the draft as a `SKILL.md`.
 *
 * Frontmatter values are quoted and escaped, because a description containing a
 * colon — which most useful descriptions do — produces invalid YAML unquoted,
 * and the runtime's parse failure surfaces as "skill not found" rather than as
 * a syntax error.
 */
export function renderSkillMd(draft: SkillDraft): string {
  const lines = ['---', `name: ${yamlString(draft.name.trim())}`]
  lines.push(`description: ${yamlString(draft.description.trim())}`)
  if (draft.emoji?.trim()) lines.push(`emoji: ${yamlString(draft.emoji.trim())}`)
  if (draft.license?.trim()) lines.push(`license: ${yamlString(draft.license.trim())}`)
  lines.push('---', '')
  lines.push(draft.instructions.trim(), '')
  return lines.join('\n')
}

/**
 * A double-quoted YAML scalar.
 *
 * Backslashes first, then quotes — reversing that order escapes the backslashes
 * this function just inserted, doubling them.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
  return `"${escaped}"`
}

/** A starting body, so an empty editor is not the first thing a user meets. */
export const SKILL_TEMPLATE = `## When to use this

Describe the situations where this skill applies.

## Steps

1. First thing to do.
2. Second thing to do.

## Notes

Anything the model should keep in mind.
`
