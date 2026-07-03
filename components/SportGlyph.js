// Sport glyph. Most sports have a Unicode emoji, but pickleball has none — a
// softball / green circle doesn't read right — so we use a bundled PNG of the
// same shaded lime ball the map markers draw (assets/pickleball.png, rasterized
// from scratch/gen-ball.js). Everything else falls back to its emoji as text, so
// this is a drop-in wherever a sport's emoji was rendered.
import React from 'react';
import { Image, Text } from 'react-native';
import { sportMeta } from '../lib/sports';

const PICKLEBALL = require('../assets/pickleball.png');

export default function SportGlyph({ id, size = 20, style }) {
  if (id === 'pickleball') {
    return <Image source={PICKLEBALL} style={{ width: size, height: size }} resizeMode="contain" />;
  }
  return <Text style={[{ fontSize: size }, style]}>{sportMeta(id).emoji}</Text>;
}
