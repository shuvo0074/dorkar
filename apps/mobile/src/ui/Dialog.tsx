import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c, r } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { Button } from './Button';
import { T } from './Text';

/** A bottom sheet holding a short form or a confirmation. */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <Pressable
          style={styles.overlay}
          accessibilityLabel={t('common.cancel')}
          onPress={onClose}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <T v="section" accessibilityRole="header">
            {title}
          </T>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Asks before something hard to undo. */
export function Confirm({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  /** The way out, when "Cancel" would read as cancelling the thing itself. */
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      {body ? <T color={c.inkSoft}>{body}</T> : null}
      <Button
        block
        kind={danger ? 'danger' : 'primary'}
        busy={!!busy}
        label={confirmLabel}
        onPress={onConfirm}
      />
      <Button block kind="outline" label={cancelLabel ?? t('common.cancel')} onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { flex: 1, backgroundColor: c.overlay },
  sheet: {
    backgroundColor: c.sheet,
    borderTopLeftRadius: r.card,
    borderTopRightRadius: r.card,
    padding: 16,
    gap: 12,
    maxHeight: '85%',
  },
});
