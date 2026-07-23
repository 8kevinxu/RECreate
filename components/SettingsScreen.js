// Settings page, opened from the gear in the Profile header. Sections:
//   • Account — Edit profile (signed-in only; flips the Profile page into its form).
//   • Language — switch between English / 中文 / Español (persisted via i18n).
//   • Danger zone — delete the account, gated behind typing a confirmation code.
// Language works signed-out; the account + delete sections only show when signed in.
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { listBlockedUsers, unblockUser } from '../lib/blocks';
import { reportContent } from '../lib/reports';
import { useI18n, LANGUAGES } from '../lib/i18n';
import { CITIES } from '../lib/cities';

// The literal a user must type to confirm deletion (kept across languages).
const CONFIRM_CODE = 'DELETE';

// Legal + support destinations. Terms is Apple's standard EULA (same as the
// signup screen's terms link); privacy + support are the hosted static pages.
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const PRIVACY_URL = 'https://recreate-sf.vercel.app/privacy.html';
const SUPPORT_URL = 'https://recreate-sf.vercel.app/support.html';

export default function SettingsScreen({ visible, onClose, onEditProfile, cityId, onSelectCity }) {
  const insets = useSafeAreaInsets();
  const { t, lang, setLang } = useI18n();
  const { user, deleteAccount, profile, updateProfile } = useAuth();

  // "Share activity with friends" — controls whether check-ins / crowd votes /
  // signals / runs notify friends (default on). When off, each action prompts.
  const shareOn = profile?.share_activity !== false;
  const toggleShare = (v) => updateProfile({ share_activity: v });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Blocked-users sub-screen (App Store UGC: a manageable, reversible block list).
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [blocked, setBlocked] = useState(null); // null = loading
  const openBlocked = () => {
    setBlockedOpen(true);
    setBlocked(null);
    listBlockedUsers().then(setBlocked);
  };
  const doUnblock = async (id) => {
    await unblockUser(id);
    setBlocked((prev) => (prev || []).filter((b) => b.id !== id));
  };

  // General "Report a problem" (free text) — the catch-all for anything without
  // a contextual "looks wrong" flag: bugs, wrong addresses, missing courts.
  // Files a content report (kind 'issue'); requires sign-in like all reports.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [reportErr, setReportErr] = useState(null);
  const [reportSent, setReportSent] = useState(false);
  const openReport = () => {
    setReportText('');
    setReportErr(null);
    setReportSent(false);
    setReportOpen(true);
  };
  const closeReport = () => {
    if (!reportBusy) setReportOpen(false);
  };
  const sendReport = async () => {
    const text = reportText.trim();
    if (!text || reportBusy) return;
    setReportErr(null);
    setReportBusy(true);
    const { error } = await reportContent({ kind: 'issue', reason: text });
    setReportBusy(false);
    if (error) setReportErr(error.message || t('mod.fail'));
    else setReportSent(true);
  };

  const canDelete = confirm.trim().toUpperCase() === CONFIRM_CODE && !busy;

  const close = () => {
    setConfirmOpen(false);
    setConfirm('');
    setError(null);
    onClose();
  };

  const openConfirm = () => {
    setConfirm('');
    setError(null);
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    if (busy) return; // don't bail out mid-delete
    setConfirmOpen(false);
    setConfirm('');
    setError(null);
  };

  const runDelete = async () => {
    setError(null);
    setBusy(true);
    const { error: err } = await deleteAccount();
    setBusy(false);
    if (err) {
      setError(t('deleteError'));
      return;
    }
    // Session is now gone; the Profile page falls back to the sign-in view.
    close();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.page, { paddingTop: insets.top + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('settings')}</Text>
          <Pressable
            hitSlop={10}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.close')}
          >
            <Ionicons name="close" size={20} color="#90a0b0" />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          keyboardShouldPersistTaps="handled"
        >
          {user && (
            <>
              <Text style={styles.sectionLabel}>{t('account')}</Text>
              <View style={styles.rowGroup}>
                {onEditProfile && (
                  <Pressable style={styles.row} onPress={onEditProfile}>
                    <Text style={styles.rowText}>{t('auth.editProfile')}</Text>
                    <Text style={styles.rowChevron}>›</Text>
                  </Pressable>
                )}
                <Pressable style={styles.row} onPress={openBlocked}>
                  <Text style={styles.rowText}>{t('mod.blockedUsers')}</Text>
                  <Text style={styles.rowChevron}>›</Text>
                </Pressable>
              </View>

              <Text style={styles.sectionLabel}>{t('settings.sharing')}</Text>
              <Text style={styles.hint}>{t('settings.shareActivityHint')}</Text>
              <View style={styles.rowGroup}>
                <View style={styles.row}>
                  <Text style={styles.rowText}>{t('settings.shareActivity')}</Text>
                  <View style={{ marginLeft: 'auto' }}>
                    <Switch
                      value={shareOn}
                      onValueChange={toggleShare}
                      trackColor={{ true: '#2f74d6' }}
                    />
                  </View>
                </View>
              </View>
            </>
          )}

          {!!onSelectCity && (
            <>
              <Text style={styles.sectionLabel}>{t('settings.city')}</Text>
              <Text style={styles.hint}>{t('settings.cityHint')}</Text>
              <View style={styles.langWrap}>
                {CITIES.map((c) => {
                  const active = c.id === cityId;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => onSelectCity(c.id)}
                      style={[styles.langRow, active && styles.langRowActive]}
                    >
                      <Text style={[styles.langNative, active && styles.langTextActive]}>
                        {t('city.' + c.id)}
                      </Text>
                      {active && <Text style={styles.check}>✓</Text>}
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.sectionLabel}>{t('language')}</Text>
          <Text style={styles.hint}>{t('languageHint')}</Text>
          <View style={styles.langWrap}>
            {LANGUAGES.map((l) => {
              const active = l.id === lang;
              return (
                <Pressable
                  key={l.id}
                  onPress={() => setLang(l.id)}
                  style={[styles.langRow, active && styles.langRowActive]}
                >
                  <Text style={[styles.langNative, active && styles.langTextActive]}>
                    {l.native}
                  </Text>
                  <Text style={[styles.langLabel, active && styles.langTextActive]}>
                    {l.label}
                  </Text>
                  {active && <Text style={styles.check}>✓</Text>}
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>{t('settings.legal')}</Text>
          <View style={styles.rowGroup}>
            <Pressable
              style={styles.row}
              onPress={() => Linking.openURL(PRIVACY_URL)}
              accessibilityRole="link"
            >
              <Text style={styles.rowText}>{t('terms.viewPrivacy')}</Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
            <Pressable
              style={styles.row}
              onPress={() => Linking.openURL(TERMS_URL)}
              accessibilityRole="link"
            >
              <Text style={styles.rowText}>{t('terms.viewTerms')}</Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
            <Pressable
              style={styles.row}
              onPress={() => Linking.openURL(SUPPORT_URL)}
              accessibilityRole="link"
            >
              <Text style={styles.rowText}>{t('settings.support')}</Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
            <Pressable style={styles.row} onPress={openReport} accessibilityRole="button">
              <Text style={styles.rowText}>{t('report.problem')}</Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
          </View>

          {/* Danger zone pinned to the bottom of the content. */}
          {user ? (
            <View style={styles.danger}>
              <Pressable style={styles.deleteBtn} onPress={openConfirm}>
                <Text style={styles.deleteText}>{t('deleteButton')}</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.signedOut}>{t('deleteSignedOut')}</Text>
          )}
        </ScrollView>
      </View>

      {/* Confirmation dialog: warning + type-to-confirm. */}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={closeConfirm}>
        <Pressable style={styles.backdrop} onPress={closeConfirm}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            <Text style={styles.dialogTitle}>{t('deleteAccount')}</Text>
            <Text style={styles.warning}>{t('deleteWarning')}</Text>
            <Text style={styles.confirmPrompt}>{t('deleteConfirm', { code: CONFIRM_CODE })}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('deletePlaceholder', { code: CONFIRM_CODE })}
              placeholderTextColor="#c98b86"
              value={confirm}
              onChangeText={setConfirm}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
            />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <View style={styles.dialogBtns}>
              <Pressable style={[styles.dialogBtn, styles.cancelBtn]} onPress={closeConfirm}>
                <Text style={styles.cancelText}>{t('cancel')}</Text>
              </Pressable>
              <Pressable
                style={[styles.dialogBtn, styles.deleteBtn, !canDelete && styles.deleteBtnDisabled]}
                disabled={!canDelete}
                onPress={runDelete}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.deleteText}>{t('deleteButton')}</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Report a problem: free text -> content report (kind 'issue'). */}
      <Modal visible={reportOpen} transparent animationType="fade" onRequestClose={closeReport}>
        <Pressable style={styles.backdrop} onPress={closeReport}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            <Text style={styles.reportTitle}>{t('report.problem')}</Text>
            {reportSent ? (
              <>
                <Text style={styles.warning}>{t('report.sent')}</Text>
                <Pressable
                  style={[styles.dialogBtn, styles.cancelBtn]}
                  onPress={() => setReportOpen(false)}
                >
                  <Text style={styles.cancelText}>{t('report.done')}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.warning}>{t('report.problemHint')}</Text>
                <TextInput
                  style={styles.reportInput}
                  placeholder={t('report.placeholder')}
                  placeholderTextColor="#9aa7b4"
                  value={reportText}
                  onChangeText={setReportText}
                  multiline
                  maxLength={500}
                  autoFocus
                />
                {!!reportErr && <Text style={styles.error}>{reportErr}</Text>}
                <View style={styles.dialogBtns}>
                  <Pressable style={[styles.dialogBtn, styles.cancelBtn]} onPress={closeReport}>
                    <Text style={styles.cancelText}>{t('cancel')}</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.dialogBtn,
                      styles.sendBtn,
                      (!reportText.trim() || reportBusy) && styles.sendBtnDisabled,
                    ]}
                    disabled={!reportText.trim() || reportBusy}
                    onPress={sendReport}
                  >
                    {reportBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.sendText}>{t('report.send')}</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Blocked users: review + unblock. */}
      <Modal visible={blockedOpen} animationType="slide" onRequestClose={() => setBlockedOpen(false)}>
        <View style={[styles.page, { paddingTop: insets.top + 12 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('mod.blockedUsers')}</Text>
            <Pressable
              hitSlop={10}
              onPress={() => setBlockedOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={t('a11y.close')}
            >
              <Ionicons name="close" size={20} color="#90a0b0" />
            </Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: insets.bottom + 32, paddingTop: 8 }}
          >
            {blocked == null ? (
              <ActivityIndicator color="#2f74d6" style={{ marginTop: 24 }} />
            ) : blocked.length === 0 ? (
              <Text style={styles.signedOut}>{t('mod.noBlocked')}</Text>
            ) : (
              <View style={styles.rowGroup}>
                {blocked.map((b) => (
                  <View key={b.id} style={styles.row}>
                    <Text style={styles.rowText}>{b.name}</Text>
                    <Pressable style={styles.unblockBtn} onPress={() => doUnblock(b.id)}>
                      <Text style={styles.unblockText}>{t('mod.unblock')}</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 18 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '800', color: '#0d1b2a' },
  scroll: { flex: 1 },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0d1b2a',
    marginTop: 18,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  hint: { fontSize: 13, color: '#7a8a9a', marginBottom: 10 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f4f6f8',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#eef1f4',
  },
  rowText: { fontSize: 15, fontWeight: '700', color: '#0d1b2a' },
  rowChevron: { marginLeft: 'auto', fontSize: 20, color: '#9aa7b4', fontWeight: '700' },
  rowGroup: { gap: 8 },
  unblockBtn: {
    marginLeft: 'auto',
    backgroundColor: '#eaf1fb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  unblockText: { color: '#2f74d6', fontWeight: '800', fontSize: 13 },

  langWrap: { gap: 8 },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f4f6f8',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: '#eef1f4',
  },
  langRowActive: { backgroundColor: '#eaf1fb', borderColor: '#2f74d6' },
  langNative: { fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  langLabel: { fontSize: 13, color: '#7a8a9a', marginLeft: 10 },
  langTextActive: { color: '#2f74d6' },
  check: { marginLeft: 'auto', fontSize: 16, fontWeight: '800', color: '#2f74d6' },

  danger: { marginTop: 36 },
  warning: { fontSize: 13, color: '#5b6b7b', lineHeight: 19, marginBottom: 12 },
  confirmPrompt: { fontSize: 13, color: '#0d1b2a', fontWeight: '700', marginBottom: 8 },
  input: {
    fontSize: 15,
    color: '#0d1b2a',
    backgroundColor: '#fdf0ef',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#f3d6d3',
    marginBottom: 10,
  },
  error: { color: '#c0392b', fontSize: 13, marginBottom: 8, fontWeight: '600' },
  deleteBtn: {
    backgroundColor: '#c0392b',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  deleteBtnDisabled: { opacity: 0.4 },
  deleteText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  signedOut: { fontSize: 13, color: '#9aa7b4', fontStyle: 'italic', marginTop: 36 },

  reportTitle: { fontSize: 18, fontWeight: '800', color: '#0d1b2a', marginBottom: 10 },
  reportInput: {
    fontSize: 15,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#e3e8ee',
    marginBottom: 10,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  sendBtn: { backgroundColor: '#2f74d6' },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(13,27,42,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  dialog: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  dialogTitle: { fontSize: 18, fontWeight: '800', color: '#c0392b', marginBottom: 10 },
  dialogBtns: { flexDirection: 'row', gap: 10, marginTop: 2 },
  dialogBtn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  cancelBtn: { backgroundColor: '#eef1f4' },
  cancelText: { color: '#46586a', fontWeight: '800', fontSize: 15 },
});
