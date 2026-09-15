// Player-reported closures ("closed for maintenance until Sep 30") on the court
// card. See supabase/schema/11_closure_reports.sql for the rules the server
// enforces; this module mirrors the display half of them.
//
// Deliberately soft: a report never touches a court's schedule, open-now status
// or map marker — it's a banner that says who says so. And it is shared-only:
// a closure nobody else can see helps nobody, so without Supabase the whole
// feature hides (`closuresEnabled`) rather than falling back to on-device.
import { supabase } from './supabase';
import { tg } from './i18n';

export const closuresEnabled = !!supabase;

export const CLOSURE_KINDS = ['maintenance', 'closed', 'partial'];
export const NOTE_MAX = 140;
// An undated report asks "still closed?" once it's gone this long without a
// confirmation. The server drops it 7 days after that (10 in all).
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;
// How far ahead a reporter may date a closure (the server allows 180).
export const MAX_DAYS_AHEAD = 180;

// Local 'YYYY-MM-DD' — `until` is a calendar day on the viewer's clock, never an
// instant, so no toISOString (which would shift it across midnight UTC).
export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shape(r) {
  return {
    id: r.id,
    sport: r.sport, // null = whole facility
    kind: r.kind,
    until: r.until, // 'YYYY-MM-DD' | null
    note: r.note,
    createdAt: Date.parse(r.created_at),
    confirmedAt: Date.parse(r.confirmed_at),
    supporters: r.supporters,
    refuters: r.refuters,
    myVote: r.my_vote || 0,
    mine: !!r.mine,
  };
}

// The one report the card shows for this court+sport at `at` (the picked time,
// or now), with its display state — or null. The server already dropped expired
// and cleared reports; a dated one is re-checked here on the viewer's own
// calendar (and against a picked future day, so planning past the end date
// doesn't show a closure that will be over).
export function pickClosure(rows, at = new Date(), now = Date.now()) {
  const day = ymd(at);
  const live = (rows || []).filter((r) => !r.until || r.until >= day);
  if (!live.length) return null;
  const disputed = (r) => r.refuters >= r.supporters;
  live.sort(
    (a, b) =>
      disputed(a) - disputed(b) ||
      // A report about this sport says more than a whole-facility one.
      (a.sport == null) - (b.sport == null) ||
      b.supporters - a.supporters ||
      b.confirmedAt - a.confirmedAt
  );
  const r = live[0];
  return {
    ...r,
    disputed: disputed(r),
    // Undated and unconfirmed for a while: ask rather than keep asserting.
    stale: !r.until && now - r.confirmedAt > STALE_MS,
  };
}

export async function loadClosures(courtId, sport) {
  if (!supabase || !courtId) return [];
  try {
    const { data, error } = await supabase.rpc('court_closures', {
      p_court_id: courtId,
      p_sport: sport || null,
    });
    if (error || !Array.isArray(data)) return [];
    return data.map(shape);
  } catch {
    return [];
  }
}

// sport null = the whole facility. until: 'YYYY-MM-DD' | null.
export async function fileClosure({ courtId, sport, kind, until, note }) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { data, error } = await supabase.rpc('file_closure_report', {
    p_court_id: courtId,
    p_sport: sport || null,
    p_kind: kind,
    p_until: until || null,
    p_note: (note || '').trim() || null,
  });
  return { id: data, error };
}

// vote: 1 support · -1 incorrect · 0 take it back.
export async function voteClosure(reportId, vote) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase.rpc('vote_closure_report', {
    p_report_id: reportId,
    p_vote: vote,
  });
  return { error };
}

export async function removeClosure(reportId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase.rpc('remove_closure_report', { p_report_id: reportId });
  return { error };
}
