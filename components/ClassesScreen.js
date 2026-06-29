// Classes & Activities tab: SF Rec & Park drop-in programs (fitness, dance, music,
// social games) that aren't court sports. Browse by category; each card shows the
// weekly schedule, location, and whether it's free drop-in or registration.
import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CLASSES, CLASS_CATEGORIES } from '../data/classes';

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};

export default function ClassesScreen() {
  const insets = useSafeAreaInsets();
  const [cat, setCat] = useState('all');

  const list = useMemo(
    () => (cat === 'all' ? CLASSES : CLASSES.filter((c) => c.category === cat)),
    [cat]
  );

  return (
    <View style={[styles.page, { paddingTop: insets.top + 14 }]}>
      <Text style={styles.title}>Classes & Activities</Text>
      <Text style={styles.sub}>Drop-in programs at SF rec centers</Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.catRow}
      >
        {[{ id: 'all', label: 'All', emoji: '✨' }, ...CLASS_CATEGORIES].map((c) => {
          const active = cat === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => setCat(c.id)}
              style={[styles.catChip, active && styles.catChipActive]}
            >
              <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                {c.emoji} {c.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        showsVerticalScrollIndicator={false}
      >
        {list.map((c) => (
          <Pressable key={c.id} style={styles.card} onPress={() => Linking.openURL(c.url)}>
            <View style={styles.cardTop}>
              <Text style={styles.cardName}>
                {catMeta(c.category).emoji} {c.name}
              </Text>
              <View style={[styles.tag, c.dropIn ? styles.tagDropIn : styles.tagReg]}>
                <Text style={[styles.tagText, c.dropIn ? styles.tagDropInText : styles.tagRegText]}>
                  {c.dropIn ? 'Drop-in' : 'Register'}
                </Text>
              </View>
            </View>
            <Text style={styles.when}>🕒 {c.when}</Text>
            <Text style={styles.loc}>📍 {c.location}</Text>
            <Text style={styles.meta}>
              {c.cost} · {c.ages}
            </Text>
          </Pressable>
        ))}

        <Text style={styles.disclaimer}>
          Sample schedules — verify times and registration on sfrecpark.org before heading out.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#eef1f5', paddingHorizontal: 16 },
  title: { fontSize: 24, fontWeight: '800', color: '#0d1b2a' },
  sub: { fontSize: 13, color: '#6b7a8a', marginTop: 2, marginBottom: 12 },

  catRow: { gap: 8, paddingRight: 16, paddingBottom: 12 },
  catChip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  catChipActive: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  catChipText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  catChipTextActive: { color: '#fff' },

  list: { flex: 1 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e6e9ee',
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  cardName: { flex: 1, fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  tag: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  tagDropIn: { backgroundColor: '#d4f3df' },
  tagReg: { backgroundColor: '#e7f0fc' },
  tagText: { fontSize: 11, fontWeight: '800' },
  tagDropInText: { color: '#1f8a4c' },
  tagRegText: { color: '#2f74d6' },
  when: { fontSize: 13, color: '#46586a', fontWeight: '600', marginTop: 8 },
  loc: { fontSize: 13, color: '#46586a', marginTop: 3 },
  meta: { fontSize: 12, color: '#8a99a8', marginTop: 6, fontWeight: '600' },

  disclaimer: { fontSize: 11, color: '#9aa7b4', fontStyle: 'italic', marginTop: 6, lineHeight: 16 },
});
