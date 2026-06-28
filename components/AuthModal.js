// Sign in / create account sheet, plus a signed-in account panel that doubles as
// the player's profile: editable name / age / bio / favorite sports, plus their
// check-in stats (per-sport counters + most-visited "favorite" park).
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth';
import { SPORTS } from '../lib/sports';
import { loadMyStats } from '../lib/playerCheckins';

export default function AuthModal({ visible, onClose, courtsById = {} }) {
  const { user, displayName, profile, signIn, signUp, signOut, updateProfile } = useAuth();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  // Profile editor state (signed-in panel), seeded from the loaded profile.
  const [pName, setPName] = useState('');
  const [pAge, setPAge] = useState('');
  const [pBio, setPBio] = useState('');
  const [pSports, setPSports] = useState([]);
  const [savedNote, setSavedNote] = useState(null); // { err, text }
  const [stats, setStats] = useState(null);

  // Seed the editor whenever the panel opens or the profile changes.
  useEffect(() => {
    if (!visible || !user) return;
    setPName(profile?.display_name || '');
    setPAge(profile?.age != null ? String(profile.age) : '');
    setPBio(profile?.bio || '');
    setPSports(profile?.favorite_sports || []);
    setSavedNote(null);
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
      setError('Email and password are required.');
      return;
    }
    if (mode === 'signup' && password.length < 6) {
      setError('Password must be at least 6 characters.');
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
      setInfo('Check your email to confirm your account, then sign in.');
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

  const saveProfile = async () => {
    setSavedNote(null);
    const ageNum = pAge.trim() ? parseInt(pAge, 10) : null;
    if (ageNum != null && (Number.isNaN(ageNum) || ageNum < 13 || ageNum > 120)) {
      setSavedNote({ err: true, text: 'Age must be a number between 13 and 120.' });
      return;
    }
    setBusy(true);
    const { error: err } = await updateProfile({
      display_name: pName,
      age: ageNum,
      bio: pBio,
      favorite_sports: pSports,
    });
    setBusy(false);
    setSavedNote(err ? { err: true, text: err.message } : { err: false, text: '✓ Profile saved.' });
  };

  const favCourt = stats?.favoriteCourtId ? courtsById[stats.favoriteCourtId] : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {user ? 'Account' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Text>
            <Pressable hitSlop={10} onPress={close}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {user ? (
            <ScrollView style={styles.accountScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.signedInAs}>
                Signed in as{' '}
                <Text style={styles.signedInName}>{displayName || user.email}</Text>
              </Text>
              <Text style={styles.signedInEmail}>{user.email}</Text>

              <Text style={styles.sectionLabel}>Profile</Text>
              <TextInput
                style={styles.input}
                placeholder="Display name"
                placeholderTextColor="#9aa7b4"
                value={pName}
                onChangeText={setPName}
                maxLength={50}
                autoCapitalize="words"
              />
              <TextInput
                style={styles.input}
                placeholder="Age"
                placeholderTextColor="#9aa7b4"
                value={pAge}
                onChangeText={(t) => setPAge(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                maxLength={3}
              />
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                placeholder="Bio — your game, when you play, who to look for…"
                placeholderTextColor="#9aa7b4"
                value={pBio}
                onChangeText={setPBio}
                maxLength={280}
                multiline
              />

              <Text style={styles.fieldLabel}>Favorite sports</Text>
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
                        {s.emoji} {s.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Pressable
                style={[styles.submit, busy && styles.submitDisabled]}
                disabled={busy}
                onPress={saveProfile}
              >
                <Text style={styles.submitText}>Save profile</Text>
              </Pressable>
              {!!savedNote && (
                <Text style={savedNote.err ? styles.error : styles.info}>{savedNote.text}</Text>
              )}

              <Text style={styles.sectionLabel}>Your check-ins</Text>
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
                  {!!favCourt && (
                    <Text style={styles.favLine}>
                      ⭐ Favorite park: <Text style={styles.favName}>{favCourt.name}</Text> (
                      {stats.favoriteCount} {stats.favoriteCount === 1 ? 'visit' : 'visits'})
                    </Text>
                  )}
                  <Text style={styles.totalLine}>{stats.total} total check-ins</Text>
                </>
              ) : (
                <Text style={styles.muted}>
                  No check-ins yet — open a court and tap “I played here.”
                </Text>
              )}

              <Pressable
                style={[styles.submit, styles.signOutBtn, busy && styles.submitDisabled]}
                disabled={busy}
                onPress={doSignOut}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>Sign out</Text>
                )}
              </Pressable>
            </ScrollView>
          ) : (
            <>
              {mode === 'signup' && (
                <TextInput
                  style={styles.input}
                  placeholder="Display name"
                  placeholderTextColor="#9aa7b4"
                  value={name}
                  onChangeText={setName}
                  maxLength={50}
                  autoCapitalize="words"
                />
              )}
              <TextInput
                style={styles.input}
                placeholder="Email"
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
                placeholder="Password"
                placeholderTextColor="#9aa7b4"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
              />

              {!!error && <Text style={styles.error}>{error}</Text>}
              {!!info && <Text style={styles.info}>{info}</Text>}

              <Pressable
                style={[styles.submit, busy && styles.submitDisabled]}
                disabled={busy}
                onPress={submit}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>
                    {mode === 'signin' ? 'Sign in' : 'Create account'}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={() => {
                  reset();
                  setMode(mode === 'signin' ? 'signup' : 'signin');
                }}
              >
                <Text style={styles.switch}>
                  {mode === 'signin'
                    ? "No account? Create one"
                    : 'Have an account? Sign in'}
                </Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },

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
  signOutBtn: { backgroundColor: '#c0392b', marginTop: 16 },

  switch: {
    textAlign: 'center',
    color: '#2f74d6',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 14,
  },

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
