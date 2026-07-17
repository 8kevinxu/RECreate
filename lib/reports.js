// Content reports (see supabase/schema/10_moderation.sql). Lets a user flag an
// objectionable message / review / signal / profile; rows are reviewed out-of-band
// (service role / dashboard). Write-only from the client.
import { Alert } from 'react-native';
import { supabase } from './supabase';
import { tg } from './i18n';

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// kind: 'message' | 'review' | 'signal' | 'profile' | 'run' | 'data' | 'issue'.
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

// Shared "this data looks wrong" flow for the court/class/pool cards: confirm
// dialog -> 'data' content report -> outcome alert. Surfaces the error message
// (e.g. "sign in first") since the fix is actionable, unlike the generic fail.
export function confirmReportData(refId) {
  Alert.alert(tg('report.dataTitle'), tg('report.dataBody'), [
    { text: tg('cancel'), style: 'cancel' },
    {
      text: tg('mod.report'),
      onPress: async () => {
        const { error } = await reportContent({ kind: 'data', refId });
        Alert.alert(error ? error.message || tg('mod.fail') : tg('report.thanks'));
      },
    },
  ]);
}
