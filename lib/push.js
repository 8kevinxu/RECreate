// Push notifications (Expo). Registers a device's Expo push token against the
// signed-in user in the `device_tokens` table; Postgres triggers (see
// supabase/schema/07_push.sql) send pushes to those tokens when runs/signals/friend
// events happen. Remote push needs a development build + an EAS projectId — it
// no-ops cleanly in Expo Go, on web, on simulators, or without a projectId.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';

// Show an alert + play a sound when a push lands while the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const projectId =
  Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId ?? null;

let registeredToken = null;

// Ask permission, get this device's Expo push token, and upsert it for `userId`.
// Returns the token, or null if push isn't available here (web / simulator /
// permission denied / no projectId). Safe to call on every sign-in.
export async function registerForPush(userId) {
  if (!supabase || !userId) return null;
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  if (!projectId) {
    console.warn('[push] No EAS projectId (run `eas init`); skipping registration.');
    return null;
  }

  // Android needs a channel before notifications can post.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  let token;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (e) {
    console.warn('[push] Could not get push token:', e?.message || e);
    return null;
  }

  const { error } = await supabase
    .from('device_tokens')
    .upsert(
      { token, user_id: userId, platform: Platform.OS },
      { onConflict: 'token' }
    );
  if (error) {
    console.warn('[push] Could not save token:', error.message);
    return null;
  }
  registeredToken = token;
  return token;
}

// Drop this device's token on sign-out so a logged-out phone stops receiving
// the previous user's pushes.
export async function unregisterPush() {
  if (!supabase || !registeredToken) return;
  await supabase.from('device_tokens').delete().eq('token', registeredToken);
  registeredToken = null;
}

// Subscribe to notification taps. `handler` receives the push's `data` payload
// (e.g. { type, courtId, signalId }). Returns an unsubscribe function.
export function onNotificationTap(handler) {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handler(response?.notification?.request?.content?.data || {});
  });
  return () => sub.remove();
}
