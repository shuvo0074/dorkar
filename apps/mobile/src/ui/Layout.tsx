import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  KeyboardAvoidingView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop } from '../design/Backdrop';
import { c, cardEdge, elevation, r, space } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { Button } from './Button';
import { AlertIcon } from './icons';
import { T } from './Text';

/**
 * One page: the design's backdrop, scrolling content with the gutter, pull to refresh, and room
 * for the keyboard. `scroll={false}` for pages that bring their own list.
 */
export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing = false,
  footer,
  bottomInset = true,
  contentStyle,
  keyboardOffset = 0,
}: {
  /** How far this page starts below the window's top; a pinned composer needs it to clear the keyboard. */
  keyboardOffset?: number;
  children: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Pinned under the scrolling content: a page's primary action. */
  footer?: ReactNode;
  bottomInset?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const bottom = bottomInset ? insets.bottom : 0;
  return (
    <View style={styles.screen}>
      <Backdrop />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={keyboardOffset}
      >
        {scroll ? (
          <ScrollView
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[
              styles.content,
              { paddingBottom: (footer ? space.section : bottom) + space.section },
              contentStyle,
            ]}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={c.accent}
                  colors={[c.brand]}
                />
              ) : undefined
            }
          >
            {children}
          </ScrollView>
        ) : (
          <View style={styles.flex}>{children}</View>
        )}
        {footer ? (
          <View style={[styles.footer, { paddingBottom: bottom + 12 }]}>{footer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

/** White card on the ground (or glass, or a bento tile): the design decides. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, elevation.card, cardEdge, style]}>{children}</View>;
}

export function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <T v="section" accessibilityRole="header" style={styles.flexShrink}>
          {title}
        </T>
        {right}
      </View>
      {children}
    </View>
  );
}

export const Row = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => (
  <View style={[styles.row, style]}>{children}</View>
);

export const Stack = ({
  gap = space.gap,
  children,
  style,
}: {
  gap?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) => <View style={[{ gap }, style]}>{children}</View>;

export const PageTitle = ({ children }: { children: ReactNode }) => (
  <T v="title" accessibilityRole="header">
    {children}
  </T>
);

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <View
      style={styles.center}
      accessibilityLabel={label ?? t('loading')}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator color={c.accent} />
    </View>
  );
}

/** Warnings: red ink on the red tint. */
export function Alert({ message, tone = 'error' }: { message: string; tone?: 'error' | 'info' }) {
  const fg = tone === 'error' ? c.redInk : c.brandInk;
  return (
    <View
      accessibilityRole="alert"
      style={[styles.alert, { backgroundColor: tone === 'error' ? c.redTint : c.brandTint }]}
    >
      <AlertIcon color={fg} size={20} />
      <T v="small" color={tone === 'error' ? c.redInk : c.ink} style={styles.flexShrink}>
        {message}
      </T>
    </View>
  );
}

export function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Stack>
      <Alert message={message ?? t('load.error')} />
      <Button kind="outline" small label={t('account.retry')} onPress={onRetry} />
    </Stack>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <T v="section" align="center">
        {title}
      </T>
      {body ? (
        <T color={c.inkSoft} align="center">
          {body}
        </T>
      ) : null}
      {action}
    </View>
  );
}

export const Divider = () => <View style={styles.divider} />;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.ground },
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  content: { padding: space.gutter, gap: space.section },
  footer: {
    paddingHorizontal: space.gutter,
    paddingTop: 12,
    backgroundColor: c.ground,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.line,
  },
  card: { backgroundColor: c.paper, borderRadius: r.card, padding: 16, gap: 12 },
  section: { gap: 12 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  center: { padding: 32, alignItems: 'center' },
  alert: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderRadius: r.control,
    alignItems: 'flex-start',
  },
  empty: { padding: 24, gap: 10, alignItems: 'center' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line },
});
