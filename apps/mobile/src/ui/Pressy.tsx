import { useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

let reduced = false;
void AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduced = v));
AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => (reduced = v));
export const reduceMotion = () => reduced;

/** A pressable that squashes on touch, on every design; collapses under reduced motion. */
export function Pressy({
  style,
  scale = 0.97,
  children,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>;
  scale?: number;
  children?: React.ReactNode;
}) {
  const v = useRef(new Animated.Value(1)).current;
  const to = (value: number) => {
    if (reduced) return;
    Animated.spring(v, { toValue: value, useNativeDriver: true, speed: 40, bounciness: 8 }).start();
  };
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      onPressIn={(e) => {
        to(scale);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        rest.onPressOut?.(e);
      }}
    >
      <Animated.View style={[style, { transform: [{ scale: v }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
