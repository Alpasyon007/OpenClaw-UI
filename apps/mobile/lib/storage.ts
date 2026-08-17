/**
 * Persistence, split by what the data actually is.
 *
 * The app has two kinds of stored state and they do not belong in the same
 * place:
 *
 *  - **Credentials** — the gateway token, the device private key. These go in
 *    `expo-secure-store`, which is the Android Keystore. Nothing else.
 *  - **Documents** — preferences, custom themes, per-session settings. These go
 *    in a JSON file under the app's document directory.
 *
 * An earlier revision put a display preference in SecureStore because it was
 * already in the build and adding a store meant a native rebuild. That was the
 * right call at the time and is the wrong one now: `expo-file-system` is in the
 * build for attachments regardless, and SecureStore on Android is documented as
 * unreliable above roughly 2 KB per value — which a saved theme, let alone a
 * set of them, comfortably exceeds. Writing one there fails at the size where a
 * user has done the most work.
 *
 * Every read is total: a missing, unreadable or malformed file yields the
 * fallback rather than throwing. Persistence failing must never stop the app
 * rendering.
 */
import { Directory, File, Paths } from 'expo-file-system'

const DIR_NAME = 'openclaw'

function storeDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  return dir
}

function docFile(name: string): File {
  return new File(storeDir(), `${name}.json`)
}

/**
 * Read a JSON document.
 *
 * `validate` is not optional garnish — these files survive app upgrades, and a
 * shape written by an older build is the normal case rather than the corrupt
 * one. A document that no longer validates is replaced by the fallback rather
 * than half-adopted, which is what stops a stale field crashing a screen three
 * navigations later.
 */
export async function readDoc<T>(
  name: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): Promise<T> {
  try {
    const file = docFile(name)
    if (!file.exists) return fallback
    const raw = await file.text()
    if (!raw.trim()) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (validate && !validate(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}

/**
 * Write a JSON document.
 *
 * Returns whether it landed. Callers generally ignore it — losing a preference
 * is not worth interrupting anyone over — but the marketplace and theme editor
 * do surface a failure, because there the user made something they expect to
 * still be there tomorrow.
 */
export async function writeDoc(name: string, value: unknown): Promise<boolean> {
  try {
    const file = docFile(name)
    if (!file.exists) file.create({ overwrite: true, intermediates: true })
    file.write(JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export async function deleteDoc(name: string): Promise<void> {
  try {
    const file = docFile(name)
    if (file.exists) file.delete()
  } catch {
    // Nothing useful to do, and nothing depends on it having happened.
  }
}

/**
 * A scratch file inside the cache directory.
 *
 * Used for exports handed to the share sheet. Cache rather than documents on
 * purpose: the system may reclaim it, which is exactly right for a file whose
 * only job is to exist long enough for another app to read it.
 */
export function cacheFile(name: string): File {
  const dir = new Directory(Paths.cache, DIR_NAME)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  return new File(dir, name)
}
