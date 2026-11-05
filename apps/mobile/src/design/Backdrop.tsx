import { useIsFocused } from '@react-navigation/native';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * The night: three soft lights drifting very slowly, built from radial gradients moved only with
 * transforms. One clock drives them, and only the page in front draws them, so a deep stack costs
 * no more than one page. Under reduced motion the clock stops, including when the setting changes
 * while the app is open. A veil keeps text on glass readable wherever a light drifts.
 */
const clock = new Animated.Value(0.35);
const drift = Animated.loop(
  Animated.sequence([
    Animated.timing(clock, {
      toValue: 1,
      duration: 16_000,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    }),
    Animated.timing(clock, {
      toValue: 0,
      duration: 24_000,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    }),
  ]),
);
const applyMotion = (reduced: boolean) => {
  if (reduced) drift.stop();
  else drift.start();
};
AccessibilityInfo.isReduceMotionEnabled().then(applyMotion, () => applyMotion(false));
AccessibilityInfo.addEventListener('reduceMotionChanged', applyMotion);

function Light({
  id,
  color,
  peak,
  size,
  style,
  dx,
  dy,
  grow,
}: {
  id: string;
  color: string;
  peak: number;
  size: number;
  style: object;
  dx: number;
  dy: number;
  grow: number;
}) {
  return (
    <Animated.View
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={[
        styles.light,
        { width: size, height: size },
        style,
        {
          transform: [
            { translateX: clock.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
            { translateY: clock.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
            { scale: clock.interpolate({ inputRange: [0, 1], outputRange: [1, grow] }) },
          ],
        },
      ]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={peak} />
            <Stop offset="0.62" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={size} height={size} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

export function Backdrop() {
  const { width, height } = useWindowDimensions();
  const vmax = Math.max(width, height);
  const size = vmax * 0.9;
  const focused = useIsFocused();
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {focused ? (
        <>
          <Light
            id="a"
            color="#9ff3e4"
            peak={0.34}
            size={size}
            style={{ top: -size * 0.45, left: -size * 0.4 }}
            dx={width * 0.2}
            dy={height * 0.14}
            grow={1.15}
          />
          <Light
            id="b"
            color="#7c5cff"
            peak={0.42}
            size={size}
            style={{ top: height * 0.1, right: -size * 0.5 }}
            dx={-width * 0.28}
            dy={-height * 0.1}
            grow={0.88}
          />
          <Light
            id="c"
            color="#ff4fa3"
            peak={0.32}
            size={size}
            style={{ bottom: -size * 0.6, left: -size * 0.1 }}
            dx={width * 0.16}
            dy={-height * 0.16}
            grow={1.1}
          />
        </>
      ) : null}
      <View style={styles.veil} />
    </View>
  );
}

const styles = StyleSheet.create({
  light: { position: 'absolute' },
  veil: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,15,0.28)' },
});
