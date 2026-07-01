// Open directions to a place in the user's maps app. On iOS we offer the installed
// map apps (Apple / Google) via an action sheet; on Android/web we hand off to
// Google Maps, which opens the user's default maps app or the browser.
import { ActionSheetIOS, Linking, Platform } from 'react-native';

export function openDirections(lat, lng, label) {
  if (lat == null || lng == null) return;
  const dest = `${lat},${lng}`;
  const google = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  if (Platform.OS === 'ios') {
    Linking.canOpenURL('comgooglemaps://').then((hasGoogle) => {
      const apps = [{ name: 'Apple Maps', url: `https://maps.apple.com/?daddr=${dest}` }];
      if (hasGoogle) apps.push({ name: 'Google Maps', url: `comgooglemaps://?daddr=${dest}` });
      if (apps.length === 1) {
        Linking.openURL(apps[0].url);
        return;
      }
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: label ? `Directions to ${label}` : 'Get directions',
          options: [...apps.map((a) => a.name), 'Cancel'],
          cancelButtonIndex: apps.length,
        },
        (i) => {
          if (i < apps.length) Linking.openURL(apps[i].url);
        }
      );
    });
  } else {
    Linking.openURL(google);
  }
}
