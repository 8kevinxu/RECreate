// Social tab shell: a segmented toggle between the Activity feed and Chats.
// Keeps both mounted-on-demand; each manages its own data/subscriptions.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import FeedModal from './FeedModal';
import ChatsScreen from './ChatsScreen';
import RecommendPane from './RecommendPane';

export default function SocialScreen({
  courtsById = {},
  courts = [],
  sport = 'basketball',
  userLocation = null,
  // Effective interests resolved in App.js (profile if signed-in, else on-device
  // onboarding picks); fall back to the profile directly if not supplied.
  interestSports,
  interestCategories,
  onPickCourt,
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { profile } = useAuth();
  const [seg, setSeg] = useState('activity'); // 'activity' | 'chats'

  return (
    <View style={[styles.page, { paddingTop: insets.top + 12 }]}>
      <RecommendPane
        courts={courts}
        userLocation={userLocation}
        sports={interestSports ?? profile?.favorite_sports ?? []}
        categories={interestCategories ?? profile?.favorite_categories ?? []}
        age={profile?.age ?? null}
        onPickCourt={onPickCourt}
      />

      <View style={styles.segment}>
        {[
          { id: 'activity', label: t('social.activity') },
          { id: 'chats', label: t('social.chats') },
        ].map((s) => {
          const on = seg === s.id;
          return (
            <Pressable
              key={s.id}
              style={[styles.segBtn, on && styles.segBtnOn]}
              onPress={() => setSeg(s.id)}
            >
              <Text style={[styles.segText, on && styles.segTextOn]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.body}>
        {seg === 'activity' ? (
          <FeedModal
            asPage
            embedded
            visible
            onClose={() => {}}
            courtsById={courtsById}
            courts={courts}
            sport={sport}
            userLocation={userLocation}
          />
        ) : (
          <View style={styles.chatsWrap}>
            <ChatsScreen courtsById={courtsById} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  segment: {
    flexDirection: 'row',
    backgroundColor: '#eef1f5',
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 18,
    marginBottom: 6,
  },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segBtnOn: { backgroundColor: '#fff' },
  segText: { fontSize: 14, fontWeight: '700', color: '#6b7a8a' },
  segTextOn: { color: '#0d1b2a' },
  body: { flex: 1 },
  chatsWrap: { flex: 1, paddingHorizontal: 18 },
});
