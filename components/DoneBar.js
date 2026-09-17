// A "Done" bar above the keyboard, for the one kind of field that has no other
// way out: a `multiline` TextInput, whose return key types a newline rather than
// dismissing. Single-line fields don't need this — their return key already
// blurs — and chat composers use a drag-to-dismiss list instead, the iMessage
// idiom, so this is only for the form fields.
//
// iOS only, twice over. InputAccessoryView is an iOS component, and on web
// react-native-web maps it to UnimplementedView, which in development renders a
// View with a red debug border — so an unguarded render would draw a stray
// red-outlined box into the page.
import React from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';

// Each host needs its own id: two accessory views sharing a nativeID can both be
// mounted at once (SettingsScreen's dialogs live inside AuthModal, and a sheet
// can sit over the Profile page), and which one a field binds to is then a
// coin toss.
export const doneId = (name) => `recreate.done.${name}`;

// Spread onto the TextInput: <TextInput {...doneProps('runNote')} multiline … />
export const doneProps = (name) => ({
  inputAccessoryViewID: Platform.OS === 'ios' ? doneId(name) : undefined,
});

export default function DoneBar({ id }) {
  const { t } = useI18n();
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={doneId(id)}>
      <View style={styles.bar}>
        <Pressable
          onPress={Keyboard.dismiss}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('done')}
        >
          <Text style={styles.done}>{t('done')}</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#e8eaee',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#c3c8cf',
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: 'flex-end',
  },
  done: { fontSize: 16, fontWeight: '700', color: '#2f74d6' },
});
