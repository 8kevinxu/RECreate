// Shared "back to top" arrow: appears when the user swipes UP while scrolled down
// past `threshold`, hides when scrolling down or near the top. Tapping scrolls the
// list to the top. Used by ClassesScreen, PoolsScreen, and the activity feed.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Scroll wiring: attach `scrollRef` + `onScroll` (scrollEventThrottle={16}) to a
// ScrollView/FlatList, render <ScrollTopFab show={showTop} onPress={scrollToTop} />.
export function useScrollTop(threshold = 60) {
  const scrollRef = useRef(null);
  const lastY = useRef(0);
  const [showTop, setShowTop] = useState(false);
  const onScroll = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastY.current;
    lastY.current = y;
    if (y < 12) setShowTop(false);
    else if (dy < -4 && y > threshold) setShowTop(true); // swiping up while scrolled
    else if (dy > 4) setShowTop(false); // scrolling down
  };
  const scrollToTop = () => scrollRef.current?.scrollTo({ y: 0, animated: true });
  return { scrollRef, onScroll, showTop, scrollToTop };
}

export default function ScrollTopFab({ show, onPress, bottom = 92 }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: show ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [show]);
  return (
    <Animated.View
      pointerEvents={show ? 'auto' : 'none'}
      style={[
        styles.wrap,
        { bottom },
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
        },
      ]}
    >
      <Pressable style={styles.btn} onPress={onPress} hitSlop={8}>
        <Ionicons name="arrow-up" size={22} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', right: 16, zIndex: 30 },
  btn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#2f74d6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
});
