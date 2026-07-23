// Social tab shell: a segmented toggle between the Activity feed and Chats.
// Keeps both mounted-on-demand; each manages its own data/subscriptions.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
  includeClasses = true, // false in courts-only cities (classes are SF-only)
  onPickCourt,
  onOpenFriends, // signed-in only: opens the Friends sheet (App.js owns it)
  requestCount = 0, // incoming friend requests — badge on the Friends button
  onSignIn, // signed-out: route to the Profile tab to create an account
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { enabled: authEnabled, user, profile } = useAuth();
  const [seg, setSeg] = useState('activity'); // 'activity' | 'chats'

  return (
    <View style={[styles.page, { paddingTop: insets.top + 12 }]}>
      <RecommendPane
        courts={courts}
        userLocation={userLocation}
        sports={interestSports ?? profile?.favorite_sports ?? []}
        categories={interestCategories ?? profile?.favorite_categories ?? []}
        age={profile?.age ?? null}
        includeClasses={includeClasses}
        onPickCourt={onPickCourt}
      />

      <View style={styles.segRow}>
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
        {!!onOpenFriends && (
          <Pressable
            style={styles.friendsBtn}
            onPress={onOpenFriends}
            accessibilityRole="button"
            accessibilityLabel={t('friends.title')}
          >
            <Ionicons name="people" size={20} color="#2f74d6" />
            {requestCount > 0 && (
              <View style={styles.friendsBadge}>
                <Text style={styles.friendsBadgeText}>
                  {requestCount > 9 ? '9+' : requestCount}
                </Text>
              </View>
            )}
          </Pressable>
        )}
      </View>

      {/* Signed-out (accounts available but none active): the social features
          below dead-end on submit, so surface the account CTA up front. */}
      {authEnabled && !user && (
        <View style={styles.signInCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.signInTitle}>{t('social.signInTitle')}</Text>
            <Text style={styles.signInBody}>{t('social.signInBody')}</Text>
          </View>
          <Pressable style={styles.signInBtn} onPress={onSignIn}>
            <Text style={styles.signInBtnText}>{t('social.signInCta')}</Text>
          </Pressable>
        </View>
      )}

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
            onPickCourt={onPickCourt}
            onOpenFriends={onOpenFriends}
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
  segRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 18,
    marginBottom: 6,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#eef1f5',
    borderRadius: 10,
    padding: 3,
  },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segBtnOn: { backgroundColor: '#fff' },
  segText: { fontSize: 14, fontWeight: '700', color: '#6b7a8a' },
  segTextOn: { color: '#0d1b2a' },
  friendsBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#eef4fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendsBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: '#e5484d',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  friendsBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  signInCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#eef4fd',
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 18,
    marginBottom: 8,
  },
  signInTitle: { fontSize: 14, fontWeight: '800', color: '#0d1b2a' },
  signInBody: { fontSize: 12.5, color: '#46586a', marginTop: 2 },
  signInBtn: {
    backgroundColor: '#2f74d6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  signInBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  body: { flex: 1 },
  chatsWrap: { flex: 1, paddingHorizontal: 18 },
});
