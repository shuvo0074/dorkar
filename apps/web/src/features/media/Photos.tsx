import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { mediaApi, PHOTO_TYPES, UploadRejected, type MediaPurpose } from './api';

/** Signed links expire after ten minutes; refresh a little before that. */
export function useMedia(id: string | undefined) {
  return useQuery({
    queryKey: ['media', id],
    queryFn: () => mediaApi.get(id!),
    enabled: Boolean(id),
    staleTime: 8 * 60_000,
    refetchInterval: 9 * 60_000,
  });
}

/**
 * One stored photo in a variant; decorative unless given alt text. Shows `fallback` (an etched
 * stamp) while loading or when the photo is unavailable.
 */
export function MediaImage({
  id,
  variant = 'thumb',
  alt = '',
  fallback = null,
}: {
  id: string | undefined;
  variant?: 'thumb' | 'medium' | 'original';
  alt?: string;
  fallback?: ReactNode;
}) {
  const media = useMedia(id);
  const src = media.data?.urls[variant] ?? media.data?.urls.original;
  if (!src) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={media.data?.width ?? undefined}
      height={media.data?.height ?? undefined}
    />
  );
}

/** Pick, upload and order photos for a listing, need, offer or lend item. */
export function PhotoPicker({
  purpose,
  value,
  onChange,
  max,
}: {
  purpose: MediaPurpose;
  value: string[];
  onChange: (ids: string[]) => void;
  max: number;
}) {
  const { t, num } = useI18n();
  const inputId = useId();
  const [problems, setProblems] = useState<string[]>([]);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const added: string[] = [];
      const issues: string[] = [];
      for (const file of files) {
        try {
          added.push((await mediaApi.upload(file, purpose)).id);
        } catch (err) {
          const name = file.name;
          if (err instanceof UploadRejected)
            issues.push(
              t(
                err.reason === 'TYPE'
                  ? 'photos.type'
                  : err.reason === 'SIZE'
                    ? 'photos.size'
                    : 'photos.rejected',
                { name },
              ),
            );
          else issues.push(`${name}: ${errorMessage(err, t)}`);
        }
      }
      return { added, issues };
    },
    onSuccess: ({ added, issues }) => {
      onChange([...value, ...added].slice(0, max));
      setProblems(issues);
    },
  });

  const room = max - value.length;
  return (
    <div className="photos">
      <p className="label">{t('photos.label')}</p>
      {value.length > 0 && (
        <ul className="photos__grid">
          {value.map((id, i) => (
            <li key={id} className="photos__item">
              <MediaImage id={id} alt={t('photos.photo', { n: num(i + 1) })} />
              <button
                type="button"
                className="photos__remove"
                aria-label={t('photos.remove', { n: num(i + 1) })}
                onClick={() => onChange(value.filter((v) => v !== id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {room > 0 ? (
        <label className="btn btn--outline btn--small photos__add" htmlFor={inputId}>
          {upload.isPending ? t('photos.uploading') : t('photos.add')}
          <input
            id={inputId}
            type="file"
            accept={PHOTO_TYPES.join(',')}
            multiple
            disabled={upload.isPending}
            className="visually-hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].slice(0, room);
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }}
          />
        </label>
      ) : (
        <p className="field__hint">{t('photos.full')}</p>
      )}
      <p className="field__hint">{t('photos.hint', { n: max })}</p>
      {problems.length > 0 && (
        <div className="alert" role="alert">
          <AlertIcon />
          <ul className="photos__problems">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
