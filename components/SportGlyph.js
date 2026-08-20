// Sport glyph. Most sports have a Unicode emoji, but pickleball has none — a
// softball / green circle doesn't read right — so we use a bundled PNG of the
// same shaded lime ball the map markers draw (assets/pickleball.png, rasterized
// from scratch/gen-ball.js). Everything else falls back to its emoji as text, so
// this is a drop-in wherever a sport's emoji was rendered.
import React from 'react';
import { Image, Text, View, StyleSheet } from 'react-native';
import { sportMeta } from '../lib/sports';

const PICKLEBALL = require('../assets/pickleball.png');

export default function SportGlyph({ id, size = 20, style }) {
  if (id === 'pickleball') {
    return <Image source={PICKLEBALL} style={{ width: size, height: size }} resizeMode="contain" />;
  }
  return <Text style={[{ fontSize: size }, style]}>{sportMeta(id).emoji}</Text>;
}

// Glyph + label as one chip/badge/button row. Use this instead of interpolating
// `meta.emoji` into a string: pickleball's glyph is an <Image>, which can't live
// inside a <Text>, so a sport label built by concatenation silently degrades to
// the 🟢 placeholder for that one sport. `style` lands on the row (pass the
// chip's background/padding), `textStyle` on the label.
export function SportTag({ id, size = 13, style, textStyle, children }) {
  return (
    <View style={[styles.row, style]}>
      <SportGlyph id={id} size={size} />
      <Text style={[textStyle, styles.label]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { flexShrink: 1 },
});
