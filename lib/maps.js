// Open directions to a place in the user's maps app. On iOS we offer the installed
// map apps (Apple / Google) via an action sheet; on Android/web we hand off to
// Google Maps, which opens the user's default maps app or the browser.
import { ActionSheetIOS, Linking, Platform } from 'react-native';

export function openDirections(lat, lng, label) {
  if (lat == null || lng == null) return;
  const dest = `${lat},${lng}`;
  const apple = `https://maps.apple.com/?daddr=${dest}`;
  const google = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  const open = (url) => Linking.openURL(url).catch(() => {});
  if (Platform.OS !== 'ios') {
    open(google);
    return;
  }
  // Offer the installed map apps. canOpenURL('comgooglemaps://') needs the scheme
  // declared in LSApplicationQueriesSchemes (app.json) to work in a standalone
  // build — Expo Go pre-declares it, which is why this worked there but not in a
  // build. If the check ever fails/rejects, fall back to Apple Maps so the button
  // is never dead.
  Linking.canOpenURL('comgooglemaps://')
    .then((hasGoogle) => {
      const apps = [{ name: 'Apple Maps', url: apple }];
      if (hasGoogle) apps.push({ name: 'Google Maps', url: `comgooglemaps://?daddr=${dest}` });
      if (apps.length === 1) {
        open(apple);
        return;
      }
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: label ? `Directions to ${label}` : 'Get directions',
          options: [...apps.map((a) => a.name), 'Cancel'],
          cancelButtonIndex: apps.length,
        },
        (i) => {
          if (i < apps.length) open(apps[i].url);
        }
      );
    })
    .catch(() => open(apple));
}
