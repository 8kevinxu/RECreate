import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';
import { AuthProvider } from './lib/auth';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
// SafeAreaProvider exposes device insets (notch/home indicator) so the app can run
// edge-to-edge; AuthProvider wraps it so any component can read account state.
function Root() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
