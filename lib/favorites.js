// Personal "favorite courts", stored on-device (works fully signed-out, like crowd
// check-ins). Favorites are court ids; the home map's ⭐ "Favorites" view shows just
// these locations with their open/closed status aggregated across every sport they
// run, so a user who just wants to get active can see where to go right now.
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'hoopmap.favorites';

export function useFavorites() {
  const [favorites, setFavorites] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) setFavorites(new Set(ids));
        } catch {}
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback((id) => {
    if (!id) return;
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      AsyncStorage.setItem(KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  const isFavorite = useCallback((id) => favorites.has(id), [favorites]);

  return { favorites, isFavorite, toggle };
}
