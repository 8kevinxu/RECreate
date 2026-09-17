// The court card's review form, lifted off the card into its own sheet.
//
// It could not stay where it was. The card is `position: absolute` with a fixed
// `bottom`, so no KeyboardAvoidingView ancestor can lift it, and the form sat
// *outside* cardScroll, so there was nothing to scroll either — the review field
// and the Post button were both under the keyboard with no way back, the body
// being `multiline` so its return key types a newline rather than dismissing.
// Reporting reached the same conclusion first; this is CardReportSheet's shape.
import React from 'react';
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import { MAX_BODY, MAX_NAME } from '../lib/reviews';

export default function ReviewSheet({
  visible,
  court,
  sportName,
  name,
  onChangeName,
  body,
  onChangeBody,
  posting,
  onSubmit,
  onClose,
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const canPost = !!body.trim() && !posting;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* The backdrop is a sibling BEHIND the sheet, never a wrapper — a Pressable
          ancestor swallows the ScrollView's pan gesture on device (see ClassDetail).
          The KeyboardAvoidingView doubles as the backdrop so the sheet rides up on
          the keyboard instead of leaving the field and Post button under it. */}
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.close')}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{t('court.writeReview')}</Text>
              <Text style={styles.sub}>
                {[court?.name, sportName].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <Pressable
              hitSlop={10}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('a11y.close')}
            >
              <Ionicons name="close" size={22} color="#90a0b0" />
            </Pressable>
          </View>

          {/* Short enough not to need scrolling, but a ScrollView is what makes a tap
              on blank space put the keyboard away (keyboardShouldPersistTaps). */}
          <ScrollView
            style={styles.scroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <TextInput
              style={styles.nameInput}
              placeholder={t('court.namePh')}
              placeholderTextColor="#9aa7b4"
              value={name}
              onChangeText={onChangeName}
              maxLength={MAX_NAME}
              returnKeyType="next"
            />
            <TextInput
              style={styles.bodyInput}
              placeholder={t('court.reviewPh')}
              placeholderTextColor="#9aa7b4"
              value={body}
              onChangeText={onChangeBody}
              maxLength={MAX_BODY}
              multiline
              autoFocus
            />
          </ScrollView>

          <Pressable
            style={[styles.post, !canPost && styles.postDisabled]}
            disabled={!canPost}
            onPress={onSubmit}
            accessibilityRole="button"
          >
            {posting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.postText}>{t('court.post')}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
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
    // Static numeric cap in StyleSheet.create — the only form native Yoga honours
    // for letting the ScrollView below shrink and scroll (see ClassDetail).
    maxHeight: Dimensions.get('window').height * 0.9,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d3dbe3',
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  sub: { fontSize: 13, color: '#5b6b7b', marginTop: 2 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  nameInput: {
    fontSize: 14,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 8,
  },
  bodyInput: {
    fontSize: 14,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 96,
    maxHeight: 200,
    textAlignVertical: 'top',
  },
  post: {
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  postDisabled: { backgroundColor: '#b7c3ce' },
  postText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
