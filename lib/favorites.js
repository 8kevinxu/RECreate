// Personal "favorite courts", stored on-device (works fully signed-out, like crowd
// check-ins). A court is favorited *for a specific sport* — the one you were viewing
// when you starred it (e.g. Parkside for pickleball, Palega for basketball) — so the
// home map's ⭐ Favorites view shows each spot under that sport, open or not.
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'recreate.favorites';

export function useFavorites() {
  // Map<courtId, sportId>.
  const [favorites, setFavorites] = useState(() => new Map());

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            // Legacy format: bare ids with no sport → default to basketball.
            setFavorites(new Map(parsed.map((id) => [id, 'basketball'])));
          } else if (parsed && typeof parsed === 'object') {
            setFavorites(new Map(Object.entries(parsed)));
          }
        } catch {}
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Toggle a court's favorite for `sport`: star it for that sport, re-point it if it
  // was favorited for another sport, or un-star it if it already matches.
  const toggle = useCallback((id, sport) => {
    if (!id || !sport) return;
    setFavorites((prev) => {
      const next = new Map(prev);
      if (next.get(id) === sport) next.delete(id);
      else next.set(id, sport);
      AsyncStorage.setItem(KEY, JSON.stringify(Object.fromEntries(next))).catch(() => {});
      return next;
    });
  }, []);

  const favoriteSport = useCallback((id) => favorites.get(id), [favorites]);
  const isFavorite = useCallback((id) => favorites.has(id), [favorites]);

  return { favorites, isFavorite, favoriteSport, toggle };
}
