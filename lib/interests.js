// On-device interest picks (favorite sports + class-activity categories), chosen
// during first-launch onboarding before the user has an account. Mirrors the
// lib/favorites.js pattern: works fully signed-out via AsyncStorage. When signed
// in, the account's profile.favorite_sports/categories take precedence; these
// locals are the fallback that lets recommendations personalize on day one.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'recreate.interests.v1';

const EMPTY = { sports: [], categories: [] };

export async function loadLocalInterests() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw);
    return {
      sports: Array.isArray(p?.sports) ? p.sports : [],
      categories: Array.isArray(p?.categories) ? p.categories : [],
    };
  } catch {
    return EMPTY;
  }
}

export async function saveLocalInterests({ sports = [], categories = [] } = {}) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ sports, categories }));
  } catch {
    // best-effort
  }
}
