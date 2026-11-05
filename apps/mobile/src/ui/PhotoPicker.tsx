import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  launchCamera,
  launchImageLibrary,
  type ImagePickerResponse,
} from 'react-native-image-picker';
import { c, r } from '../design/tokens';
import {
  mediaApi,
  UploadRejected,
  type MediaPurpose,
  type PickedFile,
} from '../features/media/api';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { Button } from './Button';
import { CloseIcon } from './icons';
import { Alert, Row } from './Layout';
import { Sheet } from './Dialog';
import { MediaImage } from './Misc';
import { T } from './Text';

/** Pick, upload and order photos for a listing, need, offer or lend item. */
export function PhotoPicker({
  purpose,
  value,
  onChange,
  max,
  label,
}: {
  purpose: MediaPurpose;
  value: string[];
  onChange: (ids: string[]) => void;
  max: number;
  label?: string;
}) {
  const { t, num } = useI18n();
  const [problem, setProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const upload = useMutation({
    mutationFn: async (files: PickedFile[]) => {
      const added: string[] = [];
      for (const f of files) added.push((await mediaApi.upload(f, purpose)).id);
      return added;
    },
    onSuccess: (added) => onChange([...value, ...added].slice(0, max)),
    onError: (e) => {
      if (e instanceof UploadRejected) {
        setProblem(
          t(
            e.reason === 'TYPE'
              ? 'photos.type'
              : e.reason === 'SIZE'
              ? 'photos.size'
              : 'photos.rejected',
            { name: t('photos.photo', { n: value.length + 1 }) },
          ),
        );
      } else setProblem(errorMessage(e, t));
    },
  });
  const handle = (res: ImagePickerResponse) => {
    setChoosing(false);
    const files = (res.assets ?? []).flatMap((a) =>
      a.uri && a.type ? [{ uri: a.uri, type: a.type, size: a.fileSize ?? 0 }] : [],
    );
    if (files.length) {
      setProblem(null);
      upload.mutate(files);
    }
  };
  const room = max - value.length;
  return (
    <View style={styles.wrap}>
      {label ?? t('photos.label') ? (
        <T v="label" color={c.inkSoft}>
          {label ?? t('photos.label')}
        </T>
      ) : null}
      <Row>
        {value.map((id, i) => (
          <View key={id} style={styles.thumb}>
            <MediaImage id={id} style={styles.image} alt={t('photos.photo', { n: num(i + 1) })} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('photos.remove', { n: num(i + 1) })}
              hitSlop={10}
              style={styles.remove}
              onPress={() => onChange(value.filter((x) => x !== id))}
            >
              <CloseIcon size={14} color={c.primaryFg} strokeWidth={3} />
            </Pressable>
          </View>
        ))}
      </Row>
      {room > 0 ? (
        <Button
          kind="outline"
          small
          busy={upload.isPending}
          label={upload.isPending ? t('photos.uploading') : t('photos.add')}
          onPress={() => setChoosing(true)}
        />
      ) : (
        <T v="small" color={c.inkSoft}>
          {t('photos.full')}
        </T>
      )}
      <T v="small" color={c.inkSoft}>
        {t('photos.hint', { n: max })}
      </T>
      {problem ? <Alert message={problem} /> : null}
      <Sheet visible={choosing} title={t('photos.add')} onClose={() => setChoosing(false)}>
        <Button
          block
          label={t('photo.library')}
          onPress={() =>
            void launchImageLibrary({
              mediaType: 'photo',
              selectionLimit: room,
              quality: 0.8,
              maxWidth: 2400,
              maxHeight: 2400,
            }).then(handle)
          }
        />
        <Button
          block
          kind="outline"
          label={t('photo.camera')}
          onPress={() =>
            void launchCamera({
              mediaType: 'photo',
              quality: 0.8,
              maxWidth: 2400,
              maxHeight: 2400,
            }).then(handle)
          }
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  thumb: {
    width: 84,
    height: 84,
    borderRadius: r.control,
    overflow: 'hidden',
    backgroundColor: c.paperShade,
  },
  image: { width: 84, height: 84 },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: c.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
