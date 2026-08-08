import { execSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, join } from 'path'

const IS_WIN = process.platform === 'win32'

let cachedPath: string | null = null

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  for (const entry of rawPath.split(delimiter)) {
    const p = entry.trim()
    if (!p) continue
    // Windows paths are case-insensitive; dedupe accordingly so we don't emit
    // the same directory twice with different casing.
    const key = IS_WIN ? p.toLowerCase() : p
    if (seen.has(key)) continue
    seen.add(key)
    target.push(p)
  }
}

/**
 * Build the PATH used for spawned CLI processes.
 *
 * Electron does not source the user's shell profile, so on POSIX we ask a login
 * shell for its PATH to pick up nvm/asdf/homebrew. On Windows the process PATH
 * is already complete (it comes from the registry), so we only add the npm
 * global directory, which is where the CLI shims live.
 */
export function getCliPath(): string {
  if (cachedPath) return cachedPath

  const ordered: string[] = []
  const seen = new Set<string>()

  // Start from the current process PATH.
  appendPathEntries(ordered, seen, process.env.PATH || process.env.Path)

  if (IS_WIN) {
    const winExtras = [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm') : '',
      join(homedir(), 'AppData', 'Roaming', 'npm'),
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs') : '',
    ].filter(Boolean)
    appendPathEntries(ordered, seen, winExtras.join(delimiter))
  } else {
    // Common binary locations used on macOS/Linux (Homebrew + system).
    appendPathEntries(
      ordered,
      seen,
      ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    )

    // Try an interactive login shell first so nvm/asdf PATH hooks are loaded.
    const pathCommands = [
      '/bin/zsh -ilc "echo $PATH"',
      '/bin/zsh -lc "echo $PATH"',
      '/bin/bash -lc "echo $PATH"',
    ]

    for (const cmd of pathCommands) {
      try {
        const discovered = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim()
        appendPathEntries(ordered, seen, discovered)
      } catch {
        // Keep trying fallbacks.
      }
    }
  }

  cachedPath = ordered.join(delimiter)
  return cachedPath
}

export function getCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath(),
  }
  // Windows resolves the variable case-insensitively but Node exposes whichever
  // casing the parent had. Leaving a stale `Path` would shadow our PATH.
  if (IS_WIN && 'Path' in env) delete (env as Record<string, unknown>).Path
  delete env.CLAUDECODE
  return env
}

/** Test seam — forces the next getCliPath() call to re-resolve. */
export function resetCliPathCache(): void {
  cachedPath = null
}
