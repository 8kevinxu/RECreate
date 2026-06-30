import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
// SafeAreaProvider exposes device insets (notch/home indicator) so the app can run
// edge-to-edge; I18nProvider holds the chosen language; AuthProvider wraps it so
// any component can read account state.
function Root() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
