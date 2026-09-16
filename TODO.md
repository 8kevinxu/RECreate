# TODO

## Popups that do nothing on web

`Alert.alert` from `react-native` is an **empty function on web** —
react-native-web ships `class Alert { static alert() {} }` — so every dialog built
on it silently never appears in the web build. Anything behind a button in that
dialog never runs either, and there is no error to notice. iOS is unaffected.

`lib/dialog.js` + `lib/dialog.web.js` now exist (`confirm()` → Promise<boolean>,
`notify()`; native `Alert.alert`, web `window.confirm` / `window.alert`).
`confirmReportData` (class card), the closure-report dialogs, review reporting and
`resolveNotify` are on it. `App.js`'s location-denied message still branches on
`Platform.OS` itself.

Still broken, worst first:

- [x] **`lib/activityShare.js` → `resolveNotify`** — moved onto `lib/dialog.js`.
- [x] **`components/FeedModal.js` → `moderate` / `doReport` / `confirmBlock`** —
  moved onto `components/ActionSheet.js` + `lib/dialog.js`; `onToggleRun`'s
  join error now uses `notify`.
- [ ] **`components/ChatThread.js`** — same Report / Block menu on chat messages,
  plus its outcome messages. `ActionSheet` now exists, so this is the same wiring
  FeedModal just got (report key `mod.reportMessage`, and the direct-thread close
  after a block).
- [x] **`App.js` → `reportReview`** — moved onto `lib/dialog.js`.
- [ ] **`components/AuthModal.js` → `cancelEdit`** — cancelling a profile edit with
  unsaved changes: the "Discard changes?" prompt never shows, so Cancel does
  nothing and the only way out is Save.
- [x] **Closure reports** — moved onto `lib/dialog.js`.

**Remaining fix:** move the unchecked items onto `lib/dialog.js`. The multi-choice
problem is settled — `window.confirm` is OK/Cancel only, so the Report · Block ·
Cancel menu became `components/ActionSheet.js`, an in-app sheet on both platforms
(the CardReportSheet idiom); the two-way confirms underneath it still go through
`confirm()`. Note that web drops the custom button labels, so any prompt moved
over has to read as a yes/no question in its title and body.
