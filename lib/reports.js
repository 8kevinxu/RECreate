// Content reports (see supabase/schema/10_moderation.sql). Lets a user flag an
// objectionable message / review / signal / profile; rows are reviewed out-of-band
// (service role / dashboard). Write-only from the client.
import { supabase } from './supabase';
import { tg } from './i18n';
import { confirm, notify } from './dialog';

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// kind: 'message' | 'review' | 'signal' | 'profile' | 'run' | 'data' | 'issue' | 'closure'.
// reportedUser/refId optional. The last two have no reported user: 'data' is a
// one-tap "this looks wrong" flag on scraped info (refId names the entity —
// 'court:<id>:<sport>' | 'class:<id>' | 'pool:<id>'); 'issue' is the free-text
// "Report a problem" in Settings (reason carries the text).
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

// Shared "this data looks wrong" flow for the class card: confirm -> 'data'
// content report -> outcome notice. Surfaces the error message (e.g. "sign in
// first") since the fix is actionable, unlike the generic fail. Court and pool
// cards file through components/CardReportSheet.js instead, which takes detail.
export async function confirmReportData(refId) {
  const ok = await confirm({
    title: tg('report.dataTitle'),
    message: tg('report.dataBody'),
    confirmText: tg('mod.report'),
    cancelText: tg('cancel'),
  });
  if (!ok) return;
  const { error } = await reportContent({ kind: 'data', refId });
  notify(error ? error.message || tg('mod.fail') : tg('report.thanks'));
}
