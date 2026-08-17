// MUST be the first import in the app. `@noble/ed25519` generates keys via
// `crypto.getRandomValues`, which Hermes does not provide — without this
// polyfill, key generation throws at first use rather than at startup, which
// makes it look like a pairing failure instead of a missing dependency.
import 'react-native-get-random-values'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#12121a' },
          headerTintColor: '#e6e6f0',
          contentStyle: { backgroundColor: '#0b0b10' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'OpenClaw Companion' }} />
      </Stack>
    </>
  )
}
