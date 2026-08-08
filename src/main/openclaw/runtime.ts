import { execFileSync } from 'child_process'
import { accessSync, constants, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, isAbsolute, join } from 'path'

const OPENCLAW_HOME_ENV = 'OPENCLAW_HOME_DIR'
const OPENCLAW_CLI_ENV = 'OPENCLAW_CLI'

const IS_WIN = process.platform === 'win32'

/**
 * Which CLI we resolved. Never re-derive this by string-matching a path —
 * on Windows the command is the Node binary, not something named "openclaw".
 */
export type CliKind = 'openclaw' | 'claude'

export interface CliRuntime {
  /** Executable to spawn. */
  command: string
  /** Args that must precede every subcommand (e.g. the CLI's .mjs entrypoint). */
  prefixArgs: string[]
  /** Drives argument construction. Authoritative — do not sniff `command`. */
  kind: CliKind
  /** Human-readable description for logs and diagnostics. */
  label: string
  /** Directory holding the CLI shim, prepended to PATH for child processes. */
  binDir: string | null
  /** Extra env required by this invocation style. */
  extraEnv: NodeJS.ProcessEnv
  /** False when nothing was positively identified and we fell back to a bare name. */
  resolved: boolean
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, IS_WIN ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathDirs(): string[] {
  const raw = process.env.PATH || process.env.Path || ''
  return raw.split(delimiter).map((d) => d.trim()).filter(Boolean)
}

/** Directories npm commonly installs global shims into. */
function globalBinDirs(): string[] {
  const dirs: string[] = []
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'npm'))
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'npm'))
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin')
    dirs.push(join(homedir(), '.npm-global', 'bin'))
    dirs.push(join(homedir(), '.local', 'bin'))
  }
  return uniq(dirs)
}

/** Candidate shim filenames for a CLI name, most-preferred first. */
function shimNames(name: string): string[] {
  // On Windows the extensionless file is a POSIX sh script npm ships for Git Bash;
  // CreateProcessW cannot run it. .cmd works but routes through cmd.exe, which
  // performs %VAR% expansion inside quoted arguments — so it is a last resort only.
  return IS_WIN ? [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name] : [name]
}

function findShim(name: string): string | null {
  for (const dir of [...pathDirs(), ...globalBinDirs()]) {
    for (const file of shimNames(name)) {
      const full = join(dir, file)
      if (existsSync(full) && isExecutable(full)) return full
    }
  }
  return null
}

/**
 * Given a directory containing npm global shims, resolve the package's real
 * JS entrypoint. Reading `bin` from package.json avoids hardcoding a filename
 * that changes between releases.
 */
function findPackageEntry(binDir: string, pkg: string): string | null {
  const roots = [
    join(binDir, 'node_modules', pkg),
    join(binDir, '..', 'lib', 'node_modules', pkg), // POSIX npm prefix layout
  ]
  for (const root of roots) {
    const manifest = join(root, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as { bin?: string | Record<string, string> }
      const rel =
        typeof parsed.bin === 'string'
          ? parsed.bin
          : parsed.bin?.[pkg] || Object.values(parsed.bin || {})[0]
      if (!rel) continue
      const entry = join(root, rel)
      if (existsSync(entry)) return entry
    } catch {
      // Malformed manifest — keep looking.
    }
  }
  return null
}

/** Locate a real Node binary. Falls back to running Electron in Node mode. */
function findNodeExecutable(): { command: string; extraEnv: NodeJS.ProcessEnv } {
  const candidates: string[] = []
  if (process.env.npm_node_execpath) candidates.push(process.env.npm_node_execpath)

  if (IS_WIN) {
    candidates.push(
      join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    )
  } else {
    candidates.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node')
  }

  for (const dir of pathDirs()) {
    candidates.push(join(dir, IS_WIN ? 'node.exe' : 'node'))
  }

  for (const c of candidates) {
    if (c && existsSync(c) && isExecutable(c)) return { command: c, extraEnv: {} }
  }

  // No standalone Node — Electron runs JS files verbatim in this mode, and it
  // is always present because we are it.
  return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
}

function resolveKind(kind: CliKind): CliRuntime | null {
  const shim = findShim(kind)
  const binDir = shim ? dirname(shim) : null

  // Preferred everywhere: invoke the package entrypoint with Node directly.
  // This bypasses cmd.exe entirely on Windows (no PATHEXT problem, no %VAR%
  // expansion corrupting prompts) and is a plain exec on POSIX.
  const searchDirs = uniq([...(binDir ? [binDir] : []), ...globalBinDirs()])
  for (const dir of searchDirs) {
    const entry = findPackageEntry(dir, kind)
    if (entry) {
      const node = findNodeExecutable()
      return {
        command: node.command,
        prefixArgs: [entry],
        kind,
        label: `${kind} (${entry})`,
        binDir: binDir || dir,
        extraEnv: node.extraEnv,
        resolved: true,
      }
    }
  }

  // Fallback: spawn the shim itself.
  if (shim) {
    return {
      command: shim,
      prefixArgs: [],
      kind,
      label: `${kind} (${shim})`,
      binDir,
      extraEnv: {},
      resolved: true,
    }
  }

  return null
}

/** Honour an explicit override, which may be an entrypoint or an executable. */
function resolveOverride(): CliRuntime | null {
  const raw = process.env[OPENCLAW_CLI_ENV]?.trim()
  if (!raw) return null

  const kind: CliKind = raw.includes('claude') && !raw.includes('openclaw') ? 'claude' : 'openclaw'

  if (isAbsolute(raw) && existsSync(raw)) {
    if (/\.(mjs|cjs|js)$/i.test(raw)) {
      const node = findNodeExecutable()
      return {
        command: node.command,
        prefixArgs: [raw],
        kind,
        label: `${kind} (override entry ${raw})`,
        binDir: dirname(raw),
        extraEnv: node.extraEnv,
        resolved: true,
      }
    }
    return {
      command: raw,
      prefixArgs: [],
      kind,
      label: `${kind} (override ${raw})`,
      binDir: dirname(raw),
      extraEnv: {},
      resolved: true,
    }
  }

  const shim = findShim(raw)
  if (shim) {
    return {
      command: shim,
      prefixArgs: [],
      kind,
      label: `${kind} (override ${shim})`,
      binDir: dirname(shim),
      extraEnv: {},
      resolved: true,
    }
  }

  return {
    command: raw,
    prefixArgs: [],
    kind,
    label: `${kind} (override ${raw}, unverified)`,
    binDir: null,
    extraEnv: {},
    resolved: false,
  }
}

let cached: CliRuntime | null = null

export function getCliRuntime(): CliRuntime {
  if (cached) return cached

  cached =
    resolveOverride() ||
    resolveKind('openclaw') ||
    resolveKind('claude') || {
      // Nothing found. Keep the bare name so error messages stay legible;
      // the spawn will fail with a clear ENOENT rather than silently misbehaving.
      command: 'openclaw',
      prefixArgs: [],
      kind: 'openclaw',
      label: 'openclaw (unresolved)',
      binDir: null,
      extraEnv: {},
      resolved: false,
    }

  return cached
}

/** Test seam — forces the next getCliRuntime() call to re-resolve. */
export function resetCliRuntimeCache(): void {
  cached = null
}

/**
 * Build a spawnable invocation for a set of CLI arguments.
 * Always use this instead of concatenating onto findCliBinary().
 */
export function cliInvocation(args: string[]): { command: string; args: string[] } {
  const rt = getCliRuntime()
  return { command: rt.command, args: [...rt.prefixArgs, ...args] }
}

export function getCliCommandCandidates(): string[] {
  const envOverride = process.env[OPENCLAW_CLI_ENV]?.trim()
  return uniq([envOverride || '', 'openclaw', 'claude'])
}

/**
 * @deprecated Returns only the executable, which on Windows is the Node binary
 * and is not runnable without {@link CliRuntime.prefixArgs}. Use
 * {@link cliInvocation} for spawning and {@link getCliRuntime} for metadata.
 */
export function findCliBinary(): string {
  return getCliRuntime().command
}

export function getAgentDataHomes(): string[] {
  const envOverride = process.env[OPENCLAW_HOME_ENV]?.trim()
  return uniq([
    envOverride || '',
    join(homedir(), '.openclaw'),
    join(homedir(), '.claude'),
  ])
}

export function getPrimaryAgentHome(): string {
  return getAgentDataHomes()[0]
}

/** Best-effort CLI version string, for diagnostics. */
export function probeCliVersion(): string | null {
  try {
    const { command, args } = cliInvocation(['--version'])
    const out = execFileSync(command, args, {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, ...getCliRuntime().extraEnv },
    })
    return out.trim().split('\n')[0] || null
  } catch {
    return null
  }
}
