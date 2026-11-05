import { useFocusEffect } from '@react-navigation/native';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ModeTiles } from '../../design/ModeTiles';
import { c, fontFor, r, keyboardAppearance } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Layout';
import { T } from '../../ui/Text';
import { useSession } from '../auth/session';
import { loadDraft, saveDraft, type ComposerDraft } from './draft';

export interface ComposerHandle {
  focus: () => void;
}

/**
 * "What do you need?": the primary action. The words stay on the device and carry into the full
 * need form, through sign-in if needed.
 */
export const Composer = forwardRef<ComposerHandle>(function Composer(_, ref) {
  const { t, lang } = useI18n();
  const { status } = useSession();
  const nav = useNav();
  const [draft, setDraft] = useState<ComposerDraft>(loadDraft);
  const [empty, setEmpty] = useState(false);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));
  useEffect(() => saveDraft(draft), [draft]);
  // Posting clears the stored draft from another page: pick that up on return.
  useFocusEffect(useCallback(() => setDraft(loadDraft()), []));

  const submit = () => {
    if (!draft.text.trim()) {
      setEmpty(true);
      input.current?.focus();
      return;
    }
    if (status !== 'signedIn') nav.navigate('SignIn', { from: { name: 'NeedForm' } });
    else nav.navigate('NeedForm');
  };

  return (
    <View style={styles.wrap}>
      <ModeTiles value={draft.mode} onChange={(mode) => setDraft((d) => ({ ...d, mode }))} />
      <View style={styles.field}>
        <T v="label" color={c.inkSoft}>
          {t('home.field')}
        </T>
        <TextInput
          keyboardAppearance={keyboardAppearance}
          ref={input}
          testID="composer"
          accessibilityLabel={t('home.field')}
          multiline
          maxLength={600}
          value={draft.text}
          placeholder={t(`mode.${draft.mode}.example`)}
          placeholderTextColor={c.placeholder}
          selectionColor={c.accent}
          textAlignVertical="top"
          onChangeText={(text) => {
            setDraft((d) => ({ ...d, text }));
            if (empty) setEmpty(false);
          }}
          style={[styles.input, { fontFamily: fontFor(lang, 500) }]}
        />
        <T v="small" color={c.inkSoft}>
          {t('home.hint')}
        </T>
      </View>
      {empty ? <Alert message={t('home.empty')} /> : null}
      <Button testID="post" block label={t('home.post')} onPress={submit} />
      <Button
        block
        kind="outline"
        label={t('home.browse')}
        onPress={() => nav.navigate('Listings')}
      />
      {status === 'signedOut' ? (
        <T v="small" color={c.inkSoft}>
          {t('home.signInToPost')}
        </T>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  field: { gap: 6 },
  input: {
    minHeight: 96,
    borderRadius: r.control,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    backgroundColor: c.field,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: c.ink,
    fontSize: 16,
    lineHeight: 22,
  },
});
