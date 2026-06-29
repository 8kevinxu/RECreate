// Full-swipe-to-delete row on core Animated + PanResponder (no gesture-handler
// dependency, so it works on the current build without a native rebuild).
//
// Smoothness keys: we only claim the gesture on a clearly horizontal-left drag,
// and once claimed we refuse to hand it back (onPanResponderTerminationRequest →
// false) so the enclosing ScrollView can't yank it away mid-swipe (the usual
// cause of jank). Drag the row past the threshold and release → it animates off
// and fires onAction; a short drag springs back. Children must be opaque.
import React, { useRef } from 'react';
import { Animated, Dimensions, PanResponder, StyleSheet, Text, View } from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
const THRESHOLD = 0.4; // fraction of row width to cross before it deletes

export default function SwipeRow({ children, actionLabel = 'Delete', actionColor = '#e5484d', onAction }) {
  const tx = useRef(new Animated.Value(0)).current;
  const widthRef = useRef(SCREEN_W);

  const animateTo = (toValue, after) =>
    Animated.timing(tx, {
      toValue,
      duration: 170,
      useNativeDriver: true,
    }).start(({ finished }) => finished && after && after());

  const pan = useRef(
    PanResponder.create({
      // Let taps and vertical scrolls through; only grab a decisive left drag.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      // Once we own the gesture, keep it (don't let the ScrollView reclaim it).
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: (_, g) => {
        tx.setValue(Math.max(-widthRef.current, Math.min(0, g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -widthRef.current * THRESHOLD) {
          animateTo(-widthRef.current, () => onAction && onAction());
        } else {
          animateTo(0);
        }
      },
      onPanResponderTerminate: () => animateTo(0),
    })
  ).current;

  return (
    <View
      style={styles.wrap}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width || SCREEN_W;
      }}
    >
      <View style={[styles.action, { backgroundColor: actionColor }]} pointerEvents="none">
        <Text style={styles.actionText}>{actionLabel}</Text>
      </View>
      <Animated.View style={[styles.content, { transform: [{ translateX: tx }] }]} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  content: { backgroundColor: '#fff' },
  action: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 28,
  },
  actionText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
