// Content reports (see supabase/schema/10_moderation.sql). Lets a user flag an
// objectionable message / review / signal / profile; rows are reviewed out-of-band
// (service role / dashboard). Write-only from the client.
import { supabase } from './supabase';
import { tg } from './i18n';

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// kind: 'message' | 'review' | 'signal' | 'profile' | 'run' | 'schedule'.
// reportedUser/refId optional; a 'schedule' report has no reported user and
// carries refId '<courtId>:<sportId>' (flags scraped hours for re-verification).
export async function reportContent({ kind, reportedUser = null, refId = null, reason = null }) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInFirst')) };
  const { error } = await supabase.from('content_reports').insert({
    reporter_id: me,
    reported_user_id: reportedUser || null,
    kind,
    ref_id: refId != null ? String(refId) : null,
    reason: reason || null,
  });
  return { error };
}
