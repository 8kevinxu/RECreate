// A horizontal time slider that snaps to the provided 30-min slots. Drag (or tap)
// the track to scrub; a floating bubble shows the time and `onChange` fires once
// per slot crossed — so the map's occupancy markers sweep as you move. The slot
// list is already filtered by the caller (past times hidden for today), so the
// slider just maps the gesture onto times[0..n-1].
import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { fmtClock } from '../lib/datetime';

const THUMB = 22;
const fmt = (m) => fmtClock(Math.floor(m / 60), m % 60);

export default function TimeSlider({ times, value, onChange }) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const timesRef = useRef(times);
  timesRef.current = times;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const startIdxRef = useRef(0);

  const geom = () => {
    const n = timesRef.current.length;
    return { n, usable: Math.max(1, widthRef.current - THUMB) };
  };
  const xForIdx = (i) => {
    const { n, usable } = geom();
    return n <= 1 ? 0 : (i / (n - 1)) * usable;
  };
  const idxForX = (x) => {
    const { n, usable } = geom();
    if (n <= 1) return 0;
    const r = Math.min(1, Math.max(0, x / usable));
    return Math.round(r * (n - 1));
  };
  const emit = (i) => {
    const t = timesRef.current;
    const m = t[Math.min(t.length - 1, Math.max(0, i))];
    if (m != null && m !== valueRef.current) onChangeRef.current(m);
  };

  // One stable responder; reads live geometry/value via refs so a mid-drag
  // re-render (each slot change) doesn't tear down the gesture.
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const ni = idxForX(e.nativeEvent.locationX - THUMB / 2);
        startIdxRef.current = ni;
        emit(ni);
      },
      onPanResponderMove: (e, g) => {
        // g.dx is the cumulative delta from grant, so the anchor (startIdxRef) must
        // stay fixed at the grab point — updating it here would compound the motion.
        emit(idxForX(xForIdx(startIdxRef.current) + g.dx));
      },
    })
  ).current;

  const n = times.length;
  const idx = Math.max(0, times.indexOf(value));
  const thumbX = xForIdx(idx);
  const bubbleLeft = Math.min(Math.max(thumbX + THUMB / 2 - 30, 0), Math.max(0, width - 60));
  const ready = width > 0 && value != null;

  return (
    <View style={styles.wrap}>
      <View style={styles.bubbleRow}>
        {ready && (
          <View style={[styles.bubble, { left: bubbleLeft }]}>
            <Text style={styles.bubbleText}>{fmt(value)}</Text>
          </View>
        )}
      </View>
      <View
        style={styles.slider}
        onLayout={(e) => {
          widthRef.current = e.nativeEvent.layout.width;
          setWidth(e.nativeEvent.layout.width);
        }}
        {...responder.panHandlers}
      >
        <View style={styles.line} />
        <View style={[styles.fill, { width: thumbX + THUMB / 2 }]} />
        {ready && <View style={[styles.thumb, { left: thumbX }]} />}
      </View>
      <View style={styles.endRow}>
        <Text style={styles.endLabel}>{n ? fmt(times[0]) : ''}</Text>
        <Text style={styles.endLabel}>{n ? fmt(times[n - 1]) : ''}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 2 },
  bubbleRow: { height: 24, position: 'relative' },
  bubble: {
    position: 'absolute',
    bottom: 0,
    minWidth: 60,
    backgroundColor: '#2f74d6',
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  bubbleText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  slider: { height: 32, justifyContent: 'center', position: 'relative' },
  line: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 14,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#26384d',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 14,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2f74d6',
  },
  thumb: {
    position: 'absolute',
    top: 5,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#2f74d6',
  },
  endRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 1 },
  endLabel: { color: '#9db4cc', fontSize: 11, fontWeight: '600' },
});
