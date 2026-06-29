// Bottom tab bar: Home (map) / Social (activity + plan) / Profile (account).
// Clean line icons (filled + blue when active), badges for unread activity and
// incoming friend requests.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const ACTIVE = '#2f74d6';
const INACTIVE = '#1f2a37';

const TABS = [
  { id: 'home', label: 'Home', on: 'home', off: 'home-outline' },
  { id: 'social', label: 'Social', on: 'people', off: 'people-outline' },
  { id: 'profile', label: 'Profile', on: 'person', off: 'person-outline' },
];

export default function BottomNav({ tab, onChange, socialBadge = 0, profileBadge = 0 }) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const active = t.id === tab;
        const badge = t.id === 'social' ? socialBadge : t.id === 'profile' ? profileBadge : 0;
        const color = active ? ACTIVE : INACTIVE;
        return (
          <Pressable key={t.id} style={styles.item} onPress={() => onChange(t.id)} hitSlop={6}>
            <View>
              <Ionicons name={active ? t.on : t.off} size={25} color={color} />
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, { color }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    paddingBottom: 12,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderColor: '#eef1f4',
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 12,
  },
  item: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 2 },
  label: { fontSize: 11, fontWeight: '700' },
  badge: {
    position: 'absolute',
    top: -5,
    right: -11,
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
