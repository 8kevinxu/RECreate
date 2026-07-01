// Sign in / create account sheet, plus a signed-in account panel that doubles as
// the player's profile. The profile shows read-only (name, age, neighborhood,
// bio, favorite sports) with an "Edit profile" button that flips into a form
// (Save / Cancel, with a discard prompt if you back out with unsaved changes).
// Below it: check-in stats — per-sport counters, most-played court+sport, and
// most-visited "favorite" park.
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';

// Account creation requires agreeing to a EULA (App Store rule for UGC apps). The
// Terms link points at Apple's standard EULA; swap PRIVACY_URL for your hosted page.
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const PRIVACY_URL = 'https://recreate-sf.vercel.app/privacy.html';
import { SPORTS } from '../lib/sports';
import { CLASS_CATEGORIES } from '../data/classes';
import { loadMyStats } from '../lib/playerCheckins';
import { loadMyReportCount } from '../lib/crowd';
import { useI18n, sportLabel } from '../lib/i18n';
import SettingsScreen from './SettingsScreen';

export default function AuthModal({
  visible,
  onClose,
  asPage = false, // render inline as the Profile tab page instead of a modal
  onFriends, // open the Friends sheet (shown in the signed-in panel)
  courtsById = {},
}) {
  const { user, displayName, profile, signIn, signUp, signOut, updateProfile } = useAuth();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false); // EULA/privacy acceptance (signup)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  // Profile is read-only by default; "Edit profile" flips into the form.
  const [editing, setEditing] = useState(false);
  // Profile editor state (signed-in panel), seeded from the loaded profile.
  const [pName, setPName] = useState('');
  const [pAge, setPAge] = useState('');
  const [pBio, setPBio] = useState('');
  const [pNeighborhood, setPNeighborhood] = useState('');
  const [pSports, setPSports] = useState([]);
  const [pCategories, setPCategories] = useState([]); // class-category interests
  const [savedNote, setSavedNote] = useState(null); // { err, text }
  const [stats, setStats] = useState(null);
  const [crowdReports, setCrowdReports] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const seedFromProfile = () => {
    setPName(profile?.display_name || '');
    setPAge(profile?.age != null ? String(profile.age) : '');
    setPBio(profile?.bio || '');
    setPNeighborhood(profile?.neighborhood || '');
    setPSports(profile?.favorite_sports || []);
    setPCategories(profile?.favorite_categories || []);
  };

  // Seed the editor whenever the panel opens or the profile changes.
  useEffect(() => {
    if (!visible || !user) return;
    seedFromProfile();
    setSavedNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, user, profile]);

  // Load check-in stats when the panel opens.
  useEffect(() => {
    if (!visible || !user) {
      setStats(null);
      return;
    }
    let alive = true;
    loadMyStats(user.id).then((s) => {
      if (alive) setStats(s);
    });
    loadMyReportCount().then((n) => {
      if (alive) setCrowdReports(n);
    });
    return () => {
      alive = false;
    };
  }, [visible, user]);

  const reset = () => {
    setError(null);
    setInfo(null);
  };
  const close = () => {
    reset();
    setPassword('');
    onClose();
  };

  const submit = async () => {
    reset();
    const e = email.trim();
    if (!e || !password) {
      setError(t('auth.errCreds'));
      return;
    }
    if (mode === 'signup' && password.length < 6) {
      setError(t('auth.errPwLen'));
      return;
    }
    if (mode === 'signup' && !agreed) {
      setError(t('terms.required'));
      return;
    }
    setBusy(true);
    const res =
      mode === 'signin'
        ? await signIn(e, password)
        : await signUp(e, password, name);
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    // If email confirmation is on, sign-up returns no session yet.
    if (mode === 'signup' && !res.data?.session) {
      setInfo(t('auth.infoConfirm'));
      setMode('signin');
      setPassword('');
      return;
    }
    close();
  };

  const doSignOut = async () => {
    setBusy(true);
    await signOut();
    setBusy(false);
    close();
  };

  const toggleSport = (id) =>
    setPSports((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));
  const toggleCategory = (id) =>
    setPCategories((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));

  // Has the editor diverged from the saved profile? Drives the discard prompt.
  const norm = (v) => (v ?? '').toString().trim();
  const isDirty = () =>
    norm(pName) !== norm(profile?.display_name) ||
    norm(pAge) !== (profile?.age != null ? String(profile.age) : '') ||
    norm(pNeighborhood) !== norm(profile?.neighborhood) ||
    norm(pBio) !== norm(profile?.bio) ||
    JSON.stringify([...pSports].sort()) !==
      JSON.stringify([...(profile?.favorite_sports || [])].sort()) ||
    JSON.stringify([...pCategories].sort()) !==
      JSON.stringify([...(profile?.favorite_categories || [])].sort());

  const startEdit = () => {
    seedFromProfile();
    setSavedNote(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (isDirty()) {
      Alert.alert(t('auth.discardTitle'), t('auth.discardBody'), [
        { text: t('auth.keepEditing'), style: 'cancel' },
        {
          text: t('auth.discard'),
          style: 'destructive',
          onPress: () => {
            seedFromProfile();
            setEditing(false);
          },
        },
      ]);
    } else {
      setEditing(false);
    }
  };

  const saveProfile = async () => {
    setSavedNote(null);
    const ageNum = pAge.trim() ? parseInt(pAge, 10) : null;
    if (ageNum != null && (Number.isNaN(ageNum) || ageNum < 13 || ageNum > 120)) {
      setSavedNote({ err: true, text: t('auth.errAge') });
      return;
    }
    setBusy(true);
    const { error: err } = await updateProfile({
      display_name: pName,
      age: ageNum,
      bio: pBio,
      neighborhood: pNeighborhood,
      favorite_sports: pSports,
      favorite_categories: pCategories,
    });
    setBusy(false);
    if (err) {
      setSavedNote({ err: true, text: err.message });
      return;
    }
    setSavedNote({ err: false, text: t('auth.saved') });
    setEditing(false);
  };

  const favCourt = stats?.favoriteCourtId ? courtsById[stats.favoriteCourtId] : null;
  // "basketball, pickleball" — sports logged at the favorite park, most-played first.
  const favSportsLabel = (stats?.favoriteSports || [])
    .map((id) => sportLabel(t, id))
    .join(t('listSep'));
  const favSportsList = SPORTS.filter((s) => (profile?.favorite_sports || []).includes(s.id));
  const favCategoriesList = CLASS_CATEGORIES.filter((c) =>
    (profile?.favorite_categories || []).includes(c.id)
  );
  // "Most check-ins at X for Y sport"
  const tcs = stats?.topCourtSport;
  const tcsCourt = tcs ? courtsById[tcs.courtId]?.name : null;
  const tcsSport = tcs ? SPORTS.find((s) => s.id === tcs.sport) : null;

  const wrap = (inner) =>
    asPage ? (
      <View
        style={[styles.page, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 84 }]}
      >
        {inner}
      </View>
    ) : (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            {inner}
          </Pressable>
        </Pressable>
      </Modal>
    );

  return wrap(
    <>
          <SettingsScreen
            visible={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onEditProfile={() => {
              setSettingsOpen(false);
              startEdit();
            }}
          />
          <View style={styles.header}>
            <Text style={styles.title}>
              {user
                ? t('auth.account')
                : mode === 'signin'
                ? t('auth.signIn')
                : t('auth.createAccount')}
            </Text>
            {asPage ? (
              <Pressable hitSlop={10} onPress={() => setSettingsOpen(true)}>
                <Text style={styles.gear}>⚙️</Text>
              </Pressable>
            ) : (
              <Pressable hitSlop={10} onPress={close}>
                <Text style={styles.close}>✕</Text>
              </Pressable>
            )}
          </View>

          {user ? (
            <ScrollView
              style={[styles.accountScroll, asPage && styles.pageScroll]}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.signedInAs}>
                {t('auth.signedInAs')}{' '}
                <Text style={styles.signedInName}>{displayName || user.email}</Text>
              </Text>
              <Text style={styles.signedInEmail}>{user.email}</Text>

              {editing ? (
                <>
                  <Text style={styles.sectionLabel}>{t('auth.editProfile')}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={t('auth.displayName')}
                    placeholderTextColor="#9aa7b4"
                    value={pName}
                    onChangeText={setPName}
                    maxLength={50}
                    autoCapitalize="words"
                  />
                  <TextInput
                    style={styles.input}
                    placeholder={t('auth.age')}
                    placeholderTextColor="#9aa7b4"
                    value={pAge}
                    onChangeText={(v) => setPAge(v.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    maxLength={3}
                  />
                  <TextInput
                    style={styles.input}
                    placeholder={t('auth.neighborhoodPh')}
                    placeholderTextColor="#9aa7b4"
                    value={pNeighborhood}
                    onChangeText={setPNeighborhood}
                    maxLength={60}
                    autoCapitalize="words"
                  />
                  <TextInput
                    style={[styles.input, styles.inputMultiline]}
                    placeholder={t('auth.bioPh')}
                    placeholderTextColor="#9aa7b4"
                    value={pBio}
                    onChangeText={setPBio}
                    maxLength={280}
                    multiline
                  />

                  <Text style={styles.fieldLabel}>{t('auth.favoriteSports')}</Text>
                  <View style={styles.sportWrap}>
                    {SPORTS.map((s) => {
                      const active = pSports.includes(s.id);
                      return (
                        <Pressable
                          key={s.id}
                          onPress={() => toggleSport(s.id)}
                          style={[styles.sportChip, active && styles.sportChipActive]}
                        >
                          <Text style={[styles.sportChipText, active && styles.sportChipTextActive]}>
                            {s.emoji} {sportLabel(t, s.id)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>{t('auth.interests')}</Text>
                  <Text style={styles.fieldHint}>{t('auth.interestsHint')}</Text>
                  <View style={styles.sportWrap}>
                    {CLASS_CATEGORIES.map((c) => {
                      const active = pCategories.includes(c.id);
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => toggleCategory(c.id)}
                          style={[styles.sportChip, active && styles.sportChipActive]}
                        >
                          <Text style={[styles.sportChipText, active && styles.sportChipTextActive]}>
                            {c.emoji} {t('cat.' + c.id)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {!!savedNote && savedNote.err && <Text style={styles.error}>{savedNote.text}</Text>}
                  <View style={styles.editBtnRow}>
                    <Pressable style={[styles.submit, styles.cancelBtn]} onPress={cancelEdit}>
                      <Text style={styles.cancelText}>{t('cancel')}</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.submit, styles.saveBtn, busy && styles.submitDisabled]}
                      disabled={busy}
                      onPress={saveProfile}
                    >
                      {busy ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.submitText}>{t('auth.save')}</Text>
                      )}
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.profileCard}>
                    <Text style={styles.profileName}>
                      {profile?.display_name || displayName || t('auth.yourName')}
                    </Text>
                    {!!profile?.neighborhood && (
                      <Text style={styles.profileMeta}>{profile.neighborhood}</Text>
                    )}
                    {!!profile?.bio && <Text style={styles.profileBio}>{profile.bio}</Text>}
                    {(favSportsList.length > 0 || favCategoriesList.length > 0) && (
                      <View style={styles.viewSportWrap}>
                        {favSportsList.map((s) => (
                          <View key={s.id} style={styles.viewSportChip}>
                            <Text style={styles.viewSportText}>
                              {s.emoji} {sportLabel(t, s.id)}
                            </Text>
                          </View>
                        ))}
                        {favCategoriesList.map((c) => (
                          <View key={c.id} style={styles.viewCatChip}>
                            <Text style={styles.viewCatText}>
                              {c.emoji} {t('cat.' + c.id)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                  {!!savedNote && !savedNote.err && <Text style={styles.info}>{savedNote.text}</Text>}

                  <Text style={styles.sectionLabel}>{t('auth.yourCheckins')}</Text>
                  {stats && stats.total > 0 ? (
                    <>
                      <View style={styles.statWrap}>
                        {SPORTS.filter((s) => stats.perSport[s.id]).map((s) => (
                          <View key={s.id} style={styles.statChip}>
                            <Text style={styles.statChipText}>
                              {s.emoji} {stats.perSport[s.id]}
                            </Text>
                          </View>
                        ))}
                      </View>
                      {!!(tcs && tcsCourt && tcsSport) && (
                        <Text style={styles.favLine}>
                          {t('auth.mostPlayedPre')}{' '}
                          <Text style={styles.favName}>{sportLabel(t, tcsSport.id)}</Text>{' '}
                          {t('auth.at')} <Text style={styles.favName}>{tcsCourt}</Text> ({tcs.count}{' '}
                          {t(tcs.count === 1 ? 'auth.checkin' : 'auth.checkins')})
                        </Text>
                      )}
                      {!!favCourt && (
                        <Text style={styles.favLine}>
                          {t('auth.favoritePark')}{' '}
                          <Text style={styles.favName}>{favCourt.name}</Text>{' '}
                          {favSportsLabel
                            ? t('auth.favParkStat', {
                                count: stats.favoriteCount,
                                sports: favSportsLabel,
                              })
                            : t('auth.favParkVisits', { count: stats.favoriteCount })}
                        </Text>
                      )}
                      <Text style={styles.totalLine}>
                        {t('auth.totalCheckins', { count: stats.total })}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.muted}>{t('auth.noCheckins')}</Text>
                  )}
                  <Text style={styles.totalLine}>
                    {t('auth.crowdReports', { count: crowdReports })}
                  </Text>
                </>
              )}

              {!editing && onFriends && (
                <Pressable
                  style={[styles.submit, styles.friendsBtn]}
                  onPress={onFriends}
                >
                  <Text style={styles.submitText}>{t('auth.friends')}</Text>
                </Pressable>
              )}

              {!editing && (
                <Pressable
                  style={[styles.submit, styles.signOutBtn, busy && styles.submitDisabled]}
                  disabled={busy}
                  onPress={doSignOut}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.submitText}>{t('auth.signOut')}</Text>
                  )}
                </Pressable>
              )}
            </ScrollView>
          ) : (
            <>
              {mode === 'signup' && (
                <TextInput
                  style={styles.input}
                  placeholder={t('auth.displayName')}
                  placeholderTextColor="#9aa7b4"
                  value={name}
                  onChangeText={setName}
                  maxLength={50}
                  autoCapitalize="words"
                />
              )}
              <TextInput
                style={styles.input}
                placeholder={t('auth.email')}
                placeholderTextColor="#9aa7b4"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
              />
              <TextInput
                style={styles.input}
                placeholder={t('auth.password')}
                placeholderTextColor="#9aa7b4"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
              />

              {mode === 'signup' && (
                <>
                  <Pressable style={styles.termsRow} onPress={() => setAgreed((v) => !v)}>
                    <View style={[styles.checkbox, agreed && styles.checkboxOn]}>
                      {agreed && <Text style={styles.checkboxTick}>✓</Text>}
                    </View>
                    <Text style={styles.termsText}>{t('terms.agree')}</Text>
                  </Pressable>
                  <View style={styles.termsLinks}>
                    <Pressable onPress={() => Linking.openURL(TERMS_URL)}>
                      <Text style={styles.termsLink}>{t('terms.viewTerms')}</Text>
                    </Pressable>
                    <Text style={styles.termsDot}>·</Text>
                    <Pressable onPress={() => Linking.openURL(PRIVACY_URL)}>
                      <Text style={styles.termsLink}>{t('terms.viewPrivacy')}</Text>
                    </Pressable>
                  </View>
                </>
              )}

              {!!error && <Text style={styles.error}>{error}</Text>}
              {!!info && <Text style={styles.info}>{info}</Text>}

              <Pressable
                style={[
                  styles.submit,
                  (busy || (mode === 'signup' && !agreed)) && styles.submitDisabled,
                ]}
                disabled={busy || (mode === 'signup' && !agreed)}
                onPress={submit}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>
                    {mode === 'signin' ? t('auth.signIn') : t('auth.createAccount')}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={() => {
                  reset();
                  setAgreed(false);
                  setMode(mode === 'signin' ? 'signup' : 'signin');
                }}
              >
                <Text style={styles.switch}>
                  {mode === 'signin' ? t('auth.noAccount') : t('auth.haveAccount')}
                </Text>
              </Pressable>
            </>
          )}
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 18, paddingTop: 14 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(13,27,42,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  sheet: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    maxHeight: '85%',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  accountScroll: { flexGrow: 0 },
  pageScroll: { flexGrow: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },
  gear: { fontSize: 20 },

  input: {
    fontSize: 15,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 10,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top' },
  error: { color: '#c0392b', fontSize: 13, marginBottom: 8, fontWeight: '600' },
  info: { color: '#1f6f43', fontSize: 13, marginBottom: 8, fontWeight: '600' },

  submit: {
    backgroundColor: '#2f74d6',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 2,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  friendsBtn: { backgroundColor: '#2f74d6', marginTop: 16 },
  signOutBtn: { backgroundColor: '#c0392b', marginTop: 10 },

  editBtnRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  saveBtn: { flex: 1 },
  cancelBtn: { flex: 1, backgroundColor: '#eef1f4' },
  cancelText: { color: '#46586a', fontWeight: '800', fontSize: 15 },

  profileCard: { backgroundColor: '#f4f6f8', borderRadius: 14, padding: 16, marginTop: 8 },
  profileName: { fontSize: 20, fontWeight: '800', color: '#0d1b2a' },
  profileMeta: { fontSize: 14, color: '#5b6b7b', marginTop: 3, fontWeight: '600' },
  profileBio: { fontSize: 14, color: '#2a3a4a', marginTop: 8, lineHeight: 20 },
  viewSportWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  viewSportChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fdece1',
  },
  viewSportText: { color: '#c2571a', fontWeight: '700', fontSize: 13 },
  viewCatChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#e7f0fc',
  },
  viewCatText: { color: '#2f74d6', fontWeight: '700', fontSize: 13 },

  switch: {
    textAlign: 'center',
    color: '#2f74d6',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 14,
  },

  termsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#c2cdd8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  checkboxTick: { color: '#fff', fontSize: 14, fontWeight: '900' },
  termsText: { flex: 1, fontSize: 13, color: '#46586a', lineHeight: 18 },
  termsLinks: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginLeft: 32 },
  termsLink: { fontSize: 13, color: '#2f74d6', fontWeight: '700' },
  termsDot: { color: '#9aa7b4' },

  signedInAs: { fontSize: 15, color: '#2a3a4a' },
  signedInName: { fontWeight: '800', color: '#0d1b2a' },
  signedInEmail: { fontSize: 13, color: '#7a8a9a', marginBottom: 6 },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0d1b2a',
    marginTop: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  fieldLabel: { fontSize: 13, color: '#5b6b7b', fontWeight: '700', marginBottom: 6 },
  fieldHint: { fontSize: 12, color: '#9aa7b4', marginTop: -2, marginBottom: 8 },

  sportWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  sportChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#eef1f4',
    borderWidth: 1,
    borderColor: '#e0e5ea',
  },
  sportChipActive: { backgroundColor: '#e8732c', borderColor: '#e8732c' },
  sportChipText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  sportChipTextActive: { color: '#fff' },

  statWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  statChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#eaf3ee',
  },
  statChipText: { color: '#1f6f43', fontWeight: '800', fontSize: 14 },
  favLine: { fontSize: 14, color: '#2a3a4a', marginBottom: 4 },
  favName: { fontWeight: '800', color: '#0d1b2a' },
  totalLine: { fontSize: 13, color: '#7a8a9a', fontWeight: '600' },
  muted: { fontSize: 13, color: '#9aa7b4', fontStyle: 'italic' },
});
