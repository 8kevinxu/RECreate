// Per-court reviews (free-text comments).
//
// Same dual-driver pattern as lib/crowd.js: Supabase when configured (shared
// across users), on-device AsyncStorage otherwise. Reviews are loaded per court
// (lazily, when a court's card opens) rather than all at once.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const STORE_KEY = 'recreate.reviews.v1';

export const isShared = !!supabase;
export const MAX_BODY = 1000;
export const MAX_NAME = 50;

function rowToReview(r) {
  return {
    id: r.id,
    courtId: r.court_id,
    author: r.author || null,
    body: r.body,
    ts: Date.parse(r.created_at),
  };
}

async function localAll() {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Most-recent-first list of reviews for a court.
export async function loadReviews(courtId) {
  if (isShared) {
    try {
      const { data, error } = await supabase
        .from('reviews')
        .select('id, court_id, author, body, created_at')
        .eq('court_id', courtId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error || !data) return [];
      return data.map(rowToReview);
    } catch {
      return [];
    }
  }
  const all = await localAll();
  return Array.isArray(all[courtId]) ? all[courtId] : [];
}

// Add a review; returns the created record, or null on failure / empty body.
export async function addReview(courtId, { author, body } = {}) {
  const text = (body || '').trim().slice(0, MAX_BODY);
  if (!text) return null;
  const name = (author || '').trim().slice(0, MAX_NAME) || null;

  if (isShared) {
    try {
      const { data, error } = await supabase
        .from('reviews')
        .insert({ court_id: courtId, author: name, body: text })
        .select('id, court_id, author, body, created_at')
        .single();
      if (error || !data) return null;
      return rowToReview(data);
    } catch {
      return null;
    }
  }

  const all = await localAll();
  const rec = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    courtId,
    author: name,
    body: text,
    ts: Date.now(),
  };
  all[courtId] = [rec, ...(Array.isArray(all[courtId]) ? all[courtId] : [])].slice(0, 100);
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // best-effort
  }
  return rec;
}
