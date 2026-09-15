# TODO

## Popups that do nothing on web

`Alert.alert` from `react-native` is an **empty function on web** —
react-native-web ships `class Alert { static alert() {} }` — so every dialog built
on it silently never appears in the web build. Anything behind a button in that
dialog never runs either, and there is no error to notice. iOS is unaffected.

`confirmReportData` (`lib/reports.js`, the "looks wrong? report it" button on the
court/class/pool cards) was the first one fixed: on web it uses `window.confirm` /
`window.alert`. `App.js`'s location-denied message already did the same.

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
- [ ] **`App.js` → `reportReview`** — reporting a review: no confirm, so the report
  is never filed.
- [ ] **`components/AuthModal.js` → `cancelEdit`** — cancelling a profile edit with
  unsaved changes: the "Discard changes?" prompt never shows, so Cancel does
  nothing and the only way out is Save.
- [ ] **Closure reports** (`App.js`, in-progress work) — "Remove your report?" and
  the vote-failure message use `Alert.alert` too.

**Suggested fix:** one small platform-split helper rather than a `Platform.OS`
branch at every call site — e.g. `lib/dialog.js` (native: `Alert.alert`) +
`lib/dialog.web.js` (`window.confirm` / `window.alert`), the same `.web.js` split
as `lib/crash.js` and `lib/getApp.js`. Two things to handle: `window.confirm` only
has OK/Cancel, so multi-choice menus (FeedModal/ChatThread's Report · Block ·
Cancel) need either sequential confirms or a small in-app Modal; and "cancel" must
still resolve `resolveNotify`'s Promise (`false`). `confirmReportData` should move
onto the helper once it exists.
