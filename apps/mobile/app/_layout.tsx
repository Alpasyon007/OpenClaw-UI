// MUST be the first import in the app. `@noble/ed25519` generates keys via
// `crypto.getRandomValues`, which Hermes does not provide — without this
// polyfill, key generation throws at first use rather than at startup, which
// makes it look like a pairing failure instead of a missing dependency.
import 'react-native-get-random-values'

import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useBranding, useColors, useIsDark, useThemeStore } from '../lib/theme'

export default function RootLayout() {
  // The header is part of the theme, not chrome around it. Hardcoding it left a
  // dark bar sitting above a light body whenever the system scheme was light.
  const colors = useColors()
  const isDark = useIsDark()
  const hydrate = useThemeStore((s) => s.hydrate)
  // The product name comes from the active theme too. A theme carries branding
  // as well as colour, and an app that repaints but keeps saying "OpenClaw"
  // has applied half of what was selected.
  const branding = useBranding()

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
        <Stack.Screen name="index" options={{ title: branding.appName }} />
        <Stack.Screen name="session/[key]" options={{ title: 'Session' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
        <Stack.Screen name="theme-editor" options={{ title: 'Theme' }} />
        <Stack.Screen name="marketplace" options={{ title: 'Skills' }} />
        <Stack.Screen name="skill-builder" options={{ title: 'New skill' }} />
        <Stack.Screen name="control-center" options={{ title: 'Control Center' }} />
        {/* Presented as a sheet, and with the back gesture disabled: the flow
            has its own Skip, and swiping out of first-run onto an unconfigured
            session list is not a state worth landing in. */}
        <Stack.Screen
          name="onboarding"
          options={{ title: 'Set up', presentation: 'modal', gestureEnabled: false }}
        />
      </Stack>
    </>
  )
}
