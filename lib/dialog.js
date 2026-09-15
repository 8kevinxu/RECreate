// Confirm / notice dialogs that work on every platform. Native uses Alert.alert;
// lib/dialog.web.js uses the browser's own dialogs, because react-native-web's
// Alert.alert is an empty function — a dialog built on it never appears on web,
// and whatever its buttons would have done never runs (see TODO.md).
import { Alert } from 'react-native';

export function notify(title, message) {
  Alert.alert(title, message || undefined);
}

// Resolves true on confirm, false on cancel or dismiss.
export function confirm({ title, message, confirmText, cancelText, destructive = false }) {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message || undefined,
      [
        { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
