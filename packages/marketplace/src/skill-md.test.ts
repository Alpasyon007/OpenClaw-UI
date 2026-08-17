import { describe, expect, it } from 'vitest'
import {
  isValidSkillName,
  renderSkillMd,
  toSkillName,
  validateSkill,
  type SkillDraft,
} from './skill-md'

const draft = (patch: Partial<SkillDraft> = {}): SkillDraft => ({
  name: 'pdf-review',
  description: 'Use when the user asks to review a PDF for tone and structure.',
  instructions: '## Steps\n\n1. Read it.',
  ...patch,
})

describe('toSkillName', () => {
  it('coerces a title into a directory-safe name', () => {
    // The name is the directory the skill installs to, so a title with spaces
    // produces a path that some runtimes silently never load.
    expect(toSkillName('My Great Skill')).toBe('my-great-skill')
    expect(toSkillName('  Leading & trailing!  ')).toBe('leading-trailing')
    expect(toSkillName('PDF/Review')).toBe('pdf-review')
  })

  it('never produces a name that starts or ends with a hyphen', () => {
    expect(toSkillName('---x---')).toBe('x')
  })

  it('bounds the length', () => {
    expect(toSkillName('a'.repeat(200)).length).toBe(64)
  })
})

describe('isValidSkillName', () => {
  it('accepts lowercase, digits and inner hyphens', () => {
    expect(isValidSkillName('pdf-review-2')).toBe(true)
  })

  it('rejects anything that would not be a safe directory name', () => {
    expect(isValidSkillName('My Skill')).toBe(false)
    expect(isValidSkillName('-leading')).toBe(false)
    expect(isValidSkillName('UPPER')).toBe(false)
    expect(isValidSkillName('')).toBe(false)
  })
})

describe('validateSkill', () => {
  it('passes a complete draft', () => {
    expect(validateSkill(draft())).toMatchObject({ ok: true, errors: [] })
  })

  it('blocks on the fields a skill cannot load without', () => {
    expect(validateSkill(draft({ name: '' })).ok).toBe(false)
    expect(validateSkill(draft({ description: '' })).ok).toBe(false)
    expect(validateSkill(draft({ instructions: '  ' })).ok).toBe(false)
  })

  it('warns rather than blocks on a description too short to trigger', () => {
    // Legal, and it will load — it just will not fire, which is far worse to
    // debug later than to mention now.
    const result = validateSkill(draft({ description: 'reviews PDFs' }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toHaveLength(1)
  })
})

describe('renderSkillMd', () => {
  it('produces frontmatter followed by the body', () => {
    const out = renderSkillMd(draft())
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('name: "pdf-review"')
    expect(out).toContain('## Steps')
  })

  it('quotes values so a colon in the description stays valid YAML', () => {
    // Unquoted, this is a YAML parse failure that surfaces as "skill not
    // found" rather than as a syntax error.
    const out = renderSkillMd(draft({ description: 'Use when: reviewing a PDF' }))
    expect(out).toContain('description: "Use when: reviewing a PDF"')
  })

  it('escapes quotes and backslashes without doubling the escapes', () => {
    const out = renderSkillMd(draft({ description: 'say "hi" via C:\\tmp' }))
    expect(out).toContain('description: "say \\"hi\\" via C:\\\\tmp"')
  })

  it('flattens a newline in a frontmatter value', () => {
    const out = renderSkillMd(draft({ description: 'line one\nline two' }))
    expect(out).toContain('description: "line one line two"')
  })

  it('omits optional fields that were left empty', () => {
    const out = renderSkillMd(draft({ emoji: '', license: undefined }))
    expect(out).not.toContain('emoji:')
    expect(out).not.toContain('license:')
  })
})
