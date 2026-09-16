// Decides whether one social action (crowd vote, check-in, "down to play" signal,
// planned run) should notify the user's friends.
//
// The persistent setting is profile.share_activity (Settings → "Share activity
// with friends", default on). When it's on, actions notify friends silently. When
// it's off, we ask once per action ("Notify your friends about this?") so a mostly-
// private user can still share a specific thing. The boolean result is passed to
// the lib call as its `notify` flag, which the DB trigger gates on (07_push.sql).
import { confirm } from './dialog';
import { tg } from './i18n';

// `share` is profile.share_activity (treat undefined/null as on — the column
// defaults to true, and signed-out users don't reach a notify path anyway).
// Returns a Promise<boolean>. Only prompts when sharing is explicitly off.
//
// Goes through lib/dialog.js rather than Alert.alert: every caller awaits this as
// the first step of its action, so a dialog that never appears doesn't merely skip
// the prompt — it leaves the Promise pending and the check-in/signal/run never
// happens, with no spinner and no error (see TODO.md). Cancel and dismiss both
// resolve false, which is the right default for someone who turned sharing off.
export function resolveNotify(share) {
  if (share !== false) return Promise.resolve(true);
  return confirm({
    title: tg('notify.promptTitle'),
    message: tg('notify.promptBody'),
    confirmText: tg('notify.notify'),
    cancelText: tg('notify.dontNotify'),
  });
}
