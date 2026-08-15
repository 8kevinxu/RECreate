// The in-app App Store rating prompt (expo-store-review → SKStoreReviewController).
//
// iOS caps this at 3 prompts per user per YEAR, app-wide, and tells you nothing:
// no callback, no way to know whether the sheet appeared or whether they rated.
// So the only lever that exists is *when* we ask, and a wasted request is gone
// for months. Everything here is about not wasting one.
//
// The ask rides on a crowd check-in, which is the app's clearest success moment:
// the user is standing at a court, just told everyone how busy it is, and got
// the small satisfaction of contributing. It is gated on their MIN_REPORTS'th
// report, so we only ever ask people who came back and used the app repeatedly —
// asking a first-timer spends one of three shots on someone with no opinion yet.
//
// Apple forbids gating or incentivizing the prompt, and specifically forbids a
// custom "do you like the app?" pre-dialog that routes unhappy users elsewhere.
// So there is no pre-dialog here: we ask, or we don't.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';

import { loadMyReportCount } from './crowd';

const ASKED_KEY = 'recreate.review.askedAt.v1';
const MIN_REPORTS = 3; // only users who have come back and reported repeatedly
const COOLDOWN_MS = 120 * 24 * 60 * 60 * 1000; // ~4 months between asks

// Apple's own cap is invisible to us, so we keep a stricter one of our own
// rather than firing at the OS and hoping it throttles.
let askedThisSession = false;

export async function maybeAskForReview() {
  try {
    if (askedThisSession) return false;
    // False on web, and on TestFlight builds — where a prompt would be both
    // useless and confusing.
    if (!(await StoreReview.isAvailableAsync())) return false;

    const reports = await loadMyReportCount();
    if (reports < MIN_REPORTS) return false;

    const last = Number(await AsyncStorage.getItem(ASKED_KEY)) || 0;
    if (last && Date.now() - last < COOLDOWN_MS) return false;

    // Recorded before the request, not after: we can't observe the outcome, and
    // a crash or a dismissed sheet must still burn the cooldown. Asking twice
    // because we failed to write is worse than skipping one cycle.
    askedThisSession = true;
    await AsyncStorage.setItem(ASKED_KEY, String(Date.now()));
    await StoreReview.requestReview();
    return true;
  } catch {
    // A rating prompt must never be able to break the action it rides on.
    return false;
  }
}
