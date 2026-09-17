// A sheet's backdrop means two things at once while a keyboard is up: "put the
// keyboard away" and "throw this away". Wired straight to onClose it can only
// ever mean the second, so the only gesture available for dismissing a keyboard
// also discarded the draft underneath it — you lost a half-written note to get
// a look at the button you were trying to press.
//
// Split them. First tap dismisses and keeps the draft; second tap closes, which
// is what the backdrop meant before a keyboard was involved and still means once
// it is gone. The ✕ is untouched: it is unambiguous, so it always closes.
//
// Native only in effect. Keyboard.isVisible() is hardcoded false on
// react-native-web, so the browser always takes the close branch — the right
// answer there, since a browser keyboard is not an overlay the page can dismiss.
import { Keyboard } from 'react-native';

export const dismissOrClose = (onClose) => () => {
  if (Keyboard.isVisible()) {
    Keyboard.dismiss();
    return;
  }
  onClose && onClose();
};
