// MUST be the first import in the app. `@noble/ed25519` generates keys via
// `crypto.getRandomValues`, which Hermes does not provide — without this
// polyfill, key generation throws at first use rather than at startup, which
// makes it look like a pairing failure instead of a missing dependency.
import 'react-native-get-random-values'

import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColors, useIsDark, useThemeStore } from '../lib/theme'

export default function RootLayout() {
  // The header is part of the theme, not chrome around it. Hardcoding it left a
  // dark bar sitting above a light body whenever the system scheme was light.
  const colors = useColors()
  const isDark = useIsDark()
  const hydrate = useThemeStore((s) => s.hydrate)

  // Restore the saved mode and theme once, before anything renders in the
  // wrong palette for a frame.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.containerBgCollapsed },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { color: colors.textPrimary },
          contentStyle: { backgroundColor: colors.containerBg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'OpenClaw' }} />
        <Stack.Screen name="session/[key]" options={{ title: 'Session' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  )
}
