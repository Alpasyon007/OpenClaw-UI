/**
 * Dictation into the composer.
 *
 * On-device recognition is requested first and is the reason this is worth
 * having at all: the alternative sends every word spoken near the phone to a
 * cloud recogniser, and the sentences dictated into this app are prompts about
 * someone's private codebase. `requiresOnDeviceRecognition` is best-effort —
 * the platform silently ignores it where no local model is installed — so
 * {@link voiceCapabilities} reports what the device can actually do and the UI
 * says which of the two is in use rather than implying the private one.
 *
 * The module is loaded lazily. A missing native module must degrade to "voice
 * is unavailable on this build" rather than crashing the screen at import time,
 * which is what happens if a JS bundle that references it is run against an APK
 * built before it was added.
 */
import { create } from 'zustand'
import { brandingNow } from './theme'

type SpeechModule = typeof import('expo-speech-recognition')

let cached: SpeechModule | null | undefined

/**
 * The native module, or `null` when this build does not carry it.
 *
 * `require` rather than a dynamic `import()` because Metro resolves the former
 * synchronously and can be told to tolerate the failure; a failed dynamic
 * import here would reject on a microtask, long after the component decided
 * voice was available.
 */
function speechModule(): SpeechModule | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-speech-recognition') as SpeechModule
  } catch {
    cached = null
  }
  return cached
}

export interface VoiceCapabilities {
  /** The native module is present in this build. */
  installed: boolean
  /** A recogniser exists and `start()` has a chance of succeeding. */
  available: boolean
  /** A local model is present, so audio need not leave the device. */
  onDevice: boolean
}

export function voiceCapabilities(): VoiceCapabilities {
  const module = speechModule()
  if (!module) return { installed: false, available: false, onDevice: false }
  try {
    return {
      installed: true,
      available: module.ExpoSpeechRecognitionModule.isRecognitionAvailable(),
      onDevice: module.ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
    }
  } catch {
    // A module that throws on a capability query is not one to call `start()`
    // on.
    return { installed: true, available: false, onDevice: false }
  }
}

export type VoiceStatus = 'idle' | 'starting' | 'listening' | 'error'

interface VoiceState {
  status: VoiceStatus
  /** Best transcript so far, interim results included. */
  transcript: string
  /** Human-readable failure. Empty unless `status` is `error`. */
  error: string
  /** True while the current session is using a local model. */
  onDevice: boolean

  start: (options?: { lang?: string }) => Promise<void>
  /** Ask for a final result. The transcript settles shortly after. */
  stop: () => void
  /** Drop the session and the transcript with it. */
  cancel: () => void
  /** Clear state once the caller has taken the transcript. */
  reset: () => void
}

/** Subscriptions for the active session only. */
let listeners: Array<{ remove: () => void }> = []

function detach(): void {
  for (const listener of listeners) {
    try {
      listener.remove()
    } catch {
      // A listener whose module already went away is already detached.
    }
  }
  listeners = []
}

export const useVoice = create<VoiceState>((set, get) => ({
  status: 'idle',
  transcript: '',
  error: '',
  onDevice: false,

  async start(options) {
    const module = speechModule()
    if (!module) {
      set({
        status: 'error',
        error: 'This build of the app does not include speech recognition.',
      })
      return
    }

    const { ExpoSpeechRecognitionModule } = module

    if (get().status === 'listening' || get().status === 'starting') return
    set({ status: 'starting', transcript: '', error: '' })

    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!permission.granted) {
        set({
          status: 'error',
          error: `Microphone access is off for ${brandingNow().appName}. Turn it on in Android settings to dictate.`,
        })
        return
      }

      const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()

      detach()
      listeners.push(
        ExpoSpeechRecognitionModule.addListener('result', (event) => {
          const best = event.results?.[0]?.transcript ?? ''
          // Interim results arrive continuously and each one is the whole
          // utterance so far, not a delta — appending them repeats every word.
          set({ transcript: best })
          if (event.isFinal) set({ status: 'idle' })
        }),
      )
      listeners.push(
        ExpoSpeechRecognitionModule.addListener('error', (event) => {
          set({ status: 'error', error: describeError(event.error, event.message) })
        }),
      )
      listeners.push(
        ExpoSpeechRecognitionModule.addListener('end', () => {
          // `end` fires after both a normal stop and a failure. Only the former
          // should clear an error the user has not read yet.
          set((s) => (s.status === 'error' ? s : { status: 'idle' }))
          detach()
        }),
      )

      ExpoSpeechRecognitionModule.start({
        lang: options?.lang ?? 'en-US',
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: onDevice,
        addsPunctuation: true,
      })

      set({ status: 'listening', onDevice })
    } catch (err) {
      detach()
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  stop() {
    try {
      speechModule()?.ExpoSpeechRecognitionModule.stop()
    } catch {
      // Stopping a session that already ended is not an error.
    }
    set((s) => (s.status === 'listening' ? { status: 'idle' } : s))
  },

  cancel() {
    try {
      speechModule()?.ExpoSpeechRecognitionModule.abort()
    } catch {
      // As above.
    }
    detach()
    set({ status: 'idle', transcript: '', error: '' })
  },

  reset() {
    set({ status: 'idle', transcript: '', error: '' })
  },
}))

/**
 * Recogniser error codes, in words that say what to do.
 *
 * The raw codes (`no-speech`, `service-not-allowed`) end up in front of users
 * otherwise, and half of them read as an app failure when the actual cause is
 * a missing language pack or a muted microphone.
 */
function describeError(code: string | undefined, message?: string): string {
  switch (code) {
    case 'no-speech':
      return 'Did not catch anything — try again closer to the microphone.'
    case 'audio-capture':
      return 'The microphone is unavailable. Another app may be using it.'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Speech recognition is not permitted on this device.'
    case 'language-not-supported':
      return 'No speech model for this language is installed on the device.'
    case 'network':
      return 'Recognition needed the network and could not reach it.'
    case 'aborted':
      return ''
    default:
      return message?.trim() || 'Speech recognition failed.'
  }
}
