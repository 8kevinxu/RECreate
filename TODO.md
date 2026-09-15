# TODO

## Popups that do nothing on web

`Alert.alert` from `react-native` is an **empty function on web** —
react-native-web ships `class Alert { static alert() {} }` — so every dialog built
on it silently never appears in the web build. Anything behind a button in that
dialog never runs either, and there is no error to notice. iOS is unaffected.

`lib/dialog.js` + `lib/dialog.web.js` now exist (`confirm()` → Promise<boolean>,
`notify()`; native `Alert.alert`, web `window.confirm` / `window.alert`).
`confirmReportData` (class card), the closure-report dialogs and review reporting
are on it. `App.js`'s location-denied message still branches on `Platform.OS` itself.

Still broken, worst first:

- [ ] **`lib/activityShare.js` → `resolveNotify`** — with Settings → "Share
  activity with friends" **off**, it returns a Promise that only the dialog's
  buttons resolve. On web that Promise never settles, so a check-in, crowd vote,
  "down to play" signal or planned run **hangs forever** rather than just skipping
  the prompt.
- [ ] **`components/FeedModal.js` → `moderate` / `doReport` / `confirmBlock`** —
  long-press on someone's post: the Report / Block menu never opens, so web users
  can't report or block from the feed. Also `onToggleRun`'s join-error message
  ("sign in first") is silent.
- [ ] **`components/ChatThread.js`** — same Report / Block menu on chat messages,
  plus its outcome messages.
- [x] **`App.js` → `reportReview`** — moved onto `lib/dialog.js`.
- [ ] **`components/AuthModal.js` → `cancelEdit`** — cancelling a profile edit with
  unsaved changes: the "Discard changes?" prompt never shows, so Cancel does
  nothing and the only way out is Save.
- [x] **Closure reports** — moved onto `lib/dialog.js`.

**Remaining fix:** move the unchecked items onto `lib/dialog.js`. Two things to
handle: `window.confirm` only has OK/Cancel, so multi-choice menus (FeedModal/
ChatThread's Report · Block · Cancel) need either sequential confirms or a small
in-app Modal; and "cancel" must still resolve `resolveNotify`'s Promise (`false`).
