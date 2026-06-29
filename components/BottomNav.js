// Bottom tab bar: Home (map) / Social (activity + plan) / Profile (account).
// Badges surface unread activity (social) and incoming friend requests (profile).
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const TABS = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'social', label: 'Social', icon: '👥' },
  { id: 'profile', label: 'Profile', icon: '👤' },
];

export default function BottomNav({ tab, onChange, socialBadge = 0, profileBadge = 0 }) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const active = t.id === tab;
        const badge = t.id === 'social' ? socialBadge : t.id === 'profile' ? profileBadge : 0;
        return (
          <Pressable key={t.id} style={styles.item} onPress={() => onChange(t.id)}>
            <View>
              <Text style={[styles.icon, !active && styles.iconInactive]}>{t.icon}</Text>
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, active && styles.labelActive]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#0d1b2a',
    borderTopWidth: 1,
    borderTopColor: '#1b2b3d',
    paddingTop: 8,
    paddingBottom: 10,
  },
  item: { flex: 1, alignItems: 'center', gap: 2 },
  icon: { fontSize: 22 },
  iconInactive: { opacity: 0.5 },
  label: { fontSize: 11, fontWeight: '700', color: '#6f8298' },
  labelActive: { color: '#fff' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#e8730c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});
