// Friends sheet: share your code, add friends by code, and accept/decline
// incoming requests. Opened from the header when signed in. (The activity feed —
// "down to play" signals and planned runs — lives in the Activity sheet now.)
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getMyCode,
  addFriendByCode,
  listFriends,
  listIncomingRequests,
  acceptRequest,
  removeFriendship,
} from '../lib/friends';
import { useI18n } from '../lib/i18n';

export default function FriendsModal({ visible, onClose }) {
  const { t } = useI18n();
  const [code, setCode] = useState(null);
  const [friends, setFriends] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addInput, setAddInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'ok' | 'err', text }

  const refresh = async () => {
    const [c, f, i] = await Promise.all([
      getMyCode(),
      listFriends(),
      listIncomingRequests(),
    ]);
    setCode(c);
    setFriends(f);
    setIncoming(i);
  };

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setMsg(null);
    setAddInput('');
    refresh().finally(() => setLoading(false));
  }, [visible]);

  const onAdd = async () => {
    setBusy(true);
    setMsg(null);
    const res = await addFriendByCode(addInput);
    setBusy(false);
    if (res.error) {
      setMsg({ kind: 'err', text: res.error.message });
      return;
    }
    setAddInput('');
    const name = res.name || t('friends.them');
    setMsg({
      kind: 'ok',
      text: res.accepted
        ? t('friends.nowFriends', { name })
        : t('friends.requestSent', { name }),
    });
    await refresh();
  };

  const onAccept = async (id) => {
    setBusy(true);
    await acceptRequest(id);
    await refresh();
    setBusy(false);
  };
  const onRemove = async (id) => {
    setBusy(true);
    await removeFriendship(id);
    await refresh();
    setBusy(false);
  };

  const shareCode = async () => {
    if (!code) return;
    try {
      await Share.share({
        message: t('friends.shareMsg', { code }),
      });
    } catch (e) {
      // Sharing unavailable (e.g. web) — the code is shown to copy manually.
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('friends.title')}</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Ionicons name="close" size={20} color="#90a0b0" />
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color="#2f74d6" />
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              {/* Your code */}
              <Text style={styles.label}>{t('friends.yourCode')}</Text>
              <View style={styles.codeRow}>
                <Text selectable style={styles.code}>
                  {code || '—'}
                </Text>
                <Pressable style={styles.shareBtn} onPress={shareCode}>
                  <Text style={styles.shareBtnText}>{t('friends.share')}</Text>
                </Pressable>
              </View>
              <Text style={styles.codeHint}>{t('friends.codeHint')}</Text>

              {/* Add by code */}
              <Text style={[styles.label, styles.sectionGap]}>{t('friends.addFriend')}</Text>
              <View style={styles.addRow}>
                <TextInput
                  style={styles.addInput}
                  placeholder={t('friends.enterCode')}
                  placeholderTextColor="#9aa7b4"
                  value={addInput}
                  onChangeText={setAddInput}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={6}
                />
                <Pressable
                  style={[styles.addBtn, (busy || !addInput.trim()) && styles.btnDisabled]}
                  disabled={busy || !addInput.trim()}
                  onPress={onAdd}
                >
                  <Text style={styles.addBtnText}>{t('friends.add')}</Text>
                </Pressable>
              </View>
              {!!msg && (
                <Text style={msg.kind === 'ok' ? styles.ok : styles.err}>{msg.text}</Text>
              )}

              {/* Incoming requests */}
              {incoming.length > 0 && (
                <>
                  <Text style={[styles.label, styles.sectionGap]}>
                    {t('friends.requests', { n: incoming.length })}
                  </Text>
                  {incoming.map((r) => (
                    <View key={r.friendshipId} style={styles.row}>
                      <Text style={styles.rowName}>{r.name}</Text>
                      <View style={styles.rowActions}>
                        <Pressable
                          style={[styles.smallBtn, styles.acceptBtn]}
                          disabled={busy}
                          onPress={() => onAccept(r.friendshipId)}
                        >
                          <Text style={styles.acceptText}>{t('friends.accept')}</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.smallBtn, styles.declineBtn]}
                          disabled={busy}
                          onPress={() => onRemove(r.friendshipId)}
                        >
                          <Text style={styles.declineText}>{t('friends.decline')}</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* Friends */}
              <Text style={[styles.label, styles.sectionGap]}>
                {t('friends.yourFriends', { n: friends.length })}
              </Text>
              {friends.length === 0 ? (
                <Text style={styles.muted}>{t('friends.noFriends')}</Text>
              ) : (
                friends.map((f) => (
                  <View key={f.friendshipId} style={styles.row}>
                    <Text style={styles.rowName}>👤 {f.name}</Text>
                    <Pressable
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => onRemove(f.friendshipId)}
                    >
                      <Text style={styles.removeText}>{t('friends.remove')}</Text>
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 28,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  loading: { paddingVertical: 30, alignItems: 'center' },

  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  sectionGap: { marginTop: 18 },

  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  code: {
    flex: 1,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 3,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  shareBtn: {
    backgroundColor: '#2f74d6',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  shareBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  codeHint: { fontSize: 12, color: '#7a8a9a', marginTop: 6 },

  addRow: { flexDirection: 'row', gap: 10 },
  addInput: {
    flex: 1,
    fontSize: 15,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    letterSpacing: 2,
  },
  addBtn: {
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  ok: { color: '#1f6f43', fontSize: 13, marginTop: 8, fontWeight: '600' },
  err: { color: '#c0392b', fontSize: 13, marginTop: 8, fontWeight: '600' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  rowName: { fontSize: 15, color: '#1a2a3a', fontWeight: '600', flex: 1 },
  rowActions: { flexDirection: 'row', gap: 8 },
  smallBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  acceptBtn: { backgroundColor: '#1f9d55' },
  acceptText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  declineBtn: { backgroundColor: '#eef1f4' },
  declineText: { color: '#5b6b7b', fontWeight: '700', fontSize: 13 },
  removeText: { color: '#c0392b', fontWeight: '700', fontSize: 13 },
  muted: { fontSize: 13, color: '#9aa7b4', fontStyle: 'italic', paddingVertical: 6 },
});
