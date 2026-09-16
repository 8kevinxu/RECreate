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

function rowToReview(r, mine = false) {
  return {
    id: r.id,
    courtId: r.court_id,
    author: r.author || null,
    body: r.body,
    ts: Date.parse(r.created_at),
    mine,
  };
}

// Which of this court's shared reviews are the caller's own. The owner column
// isn't selectable — a readable user_id would deanonymize a review signed
// "Anonymous", since profiles are readable by every signed-in user — so the
// server answers with ids via a SECURITY DEFINER RPC that only ever returns the
// caller's (supabase/schema/02_reviews.sql). Anonymous callers get nothing, and
// a database that hasn't run 029 just yields no Delete buttons.
async function myIds(courtId) {
  try {
    // Local read, no round trip — and it keeps signed-out card opens from
    // firing an RPC that's revoked from anon anyway.
    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) return new Set();
    const { data, error } = await supabase.rpc('my_review_ids', { p_court_id: courtId });
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((r) => (r && typeof r === 'object' ? r.my_review_ids : r)));
  } catch {
    return new Set();
  }
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
      const mine = await myIds(courtId);
      return data.map((r) => rowToReview(r, mine.has(r.id)));
    } catch {
      return [];
    }
  }
  // Local-only reviews were all written on this device, so they're all yours.
  const all = await localAll();
  const list = Array.isArray(all[courtId]) ? all[courtId] : [];
  return list.map((r) => ({ ...r, mine: true }));
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
      return rowToReview(data, true);
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
    mine: true,
  };
  all[courtId] = [rec, ...(Array.isArray(all[courtId]) ? all[courtId] : [])].slice(0, 100);
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // best-effort
  }
  return rec;
}

// Delete one of your own reviews. Returns true when it's gone. The shared path
// leans on RLS rather than checking here: the delete policy is scoped to
// auth.uid(), so someone else's review can't be removed even by id.
export async function deleteReview(id) {
  if (isShared) {
    try {
      // Ask for the deleted row back: RLS turns "not yours" into zero rows
      // deleted and no error, which would otherwise read as success.
      const { data, error } = await supabase.from('reviews').delete().eq('id', id).select('id');
      return !error && Array.isArray(data) && data.length > 0;
    } catch {
      return false;
    }
  }

  const all = await localAll();
  let found = false;
  for (const courtId of Object.keys(all)) {
    const list = Array.isArray(all[courtId]) ? all[courtId] : [];
    const next = list.filter((r) => r.id !== id);
    if (next.length !== list.length) {
      found = true;
      all[courtId] = next;
    }
  }
  if (!found) return false;
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  return true;
}
