// A short menu of actions on one thing — "report this post, or block whoever
// wrote it". Shared by the activity feed and chat threads, which is why it lives
// out here rather than inside either one.
//
// It is a real in-app sheet on BOTH platforms rather than Alert.alert's native
// action sheet, because Alert.alert is an empty function on web (see TODO.md):
// the menu simply never opened there, and a three-way choice doesn't fit
// window.confirm's OK/Cancel either. Same idiom as CardReportSheet, which asks
// the court card's "what's wrong here?" exactly this way — a transparent Modal
// over a backdrop Pressable, so one presentation serves iOS and web.
//
// The rows carry an optional `desc` because that's the thing a native action
// sheet has no room for: "Block Alex" says what the button is called, not what
// it does to the next screen.
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';

// options: [{ key, label, desc?, icon, iconBg?, destructive? }]
export default function ActionSheet({ visible, title, options = [], onSelect, onClose, busy = false }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Backdrop is a sibling BEHIND the sheet, never a wrapper (see
          CardReportSheet / ClassDetail). */}
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.close')}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          {!!title && (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          )}
          {options.map((o) => (
            <Pressable
              key={o.key}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => !busy && onSelect(o.key)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={o.label}
            >
              <View style={[styles.ico, { backgroundColor: o.iconBg || '#eef1f4' }]}>
                <Ionicons name={o.icon} size={17} color={o.destructive ? '#e23b3b' : '#2f74d6'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, o.destructive && styles.labelDanger]}>{o.label}</Text>
                {!!o.desc && <Text style={styles.desc}>{o.desc}</Text>}
              </View>
            </Pressable>
          ))}
          <Pressable style={styles.cancel} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelText}>{t('cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d3dbe3',
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a', marginBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e3e8ec',
    backgroundColor: '#fff',
    marginBottom: 8,
  },
  rowPressed: { backgroundColor: '#f3f8fe', borderColor: '#2f74d6' },
  ico: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 14, fontWeight: '700', color: '#0d1b2a' },
  labelDanger: { color: '#e23b3b' },
  desc: { fontSize: 12, color: '#6b7a8a', marginTop: 1 },
  cancel: {
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#eef1f4',
    alignItems: 'center',
    marginTop: 2,
  },
  cancelText: { fontSize: 14, fontWeight: '800', color: '#46586a' },
});
