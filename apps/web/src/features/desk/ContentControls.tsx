import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { TextAreaField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useCan } from '../auth/permissions';
import { deskApi } from './api';

/**
 * Staff hide or restore a listing or need straight from its page, with a reason for the audit
 * log. Shown only with the moderation permission for that direction.
 */
export function ContentControls({
  kind,
  id,
  hidden,
  queryKey,
}: {
  kind: 'LISTING' | 'NEED';
  id: string;
  hidden: boolean;
  queryKey: readonly unknown[];
}) {
  const { t } = useI18n();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const run = useMutation({
    mutationFn: () =>
      kind === 'LISTING'
        ? deskApi.hideListing(id, reason.trim(), hidden)
        : deskApi.hideNeed(id, reason.trim(), hidden),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      void qc.invalidateQueries({ queryKey: [...queryKey] });
    },
  });
  const allowed = hidden ? can('moderation:content:restore') : can('moderation:content:hide');
  if (!allowed) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t('staff.reasonHint'));
    setError(undefined);
    run.mutate();
  };
  const label = t(hidden ? 'content.restore' : 'content.hide');

  return (
    <div className="report">
      {hidden && (
        <p className="alert alert--note">
          <NoteIcon />
          <span>{t('content.hidden')}</span>
        </p>
      )}
      {open ? (
        <form className="counter counter--danger" onSubmit={submit} noValidate aria-label={label}>
          <TextAreaField
            label={t('staff.reason')}
            hint={t('staff.reasonHint')}
            value={reason}
            onChange={setReason}
            maxLength={500}
            rows={2}
            error={error}
          />
          <div className="formactions">
            <button type="submit" className="btn btn--danger btn--small" disabled={run.isPending}>
              {label}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setOpen(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
          {run.isError && (
            <p className="alert" role="alert">
              <AlertIcon />
              <span>{errorMessage(run.error, t)}</span>
            </p>
          )}
        </form>
      ) : (
        <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
          {label}
        </button>
      )}
    </div>
  );
}
