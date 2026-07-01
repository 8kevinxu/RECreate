// Decides whether one social action (crowd vote, check-in, "down to play" signal,
// planned run) should notify the user's friends.
//
// The persistent setting is profile.share_activity (Settings → "Share activity
// with friends", default on). When it's on, actions notify friends silently. When
// it's off, we ask once per action ("Notify your friends about this?") so a mostly-
// private user can still share a specific thing. The boolean result is passed to
// the lib call as its `notify` flag, which the DB trigger gates on (07_push.sql).
import { Alert } from 'react-native';
import { tg } from './i18n';

// `share` is profile.share_activity (treat undefined/null as on — the column
// defaults to true, and signed-out users don't reach a notify path anyway).
// Returns a Promise<boolean>. Only prompts when sharing is explicitly off.
export function resolveNotify(share) {
  if (share !== false) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      tg('notify.promptTitle'),
      tg('notify.promptBody'),
      [
        { text: tg('notify.dontNotify'), style: 'cancel', onPress: () => resolve(false) },
        { text: tg('notify.notify'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
