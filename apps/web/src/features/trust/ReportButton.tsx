import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { SelectField, TextAreaField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useSession } from '../auth/session';
import { ReportReasons, trustApi, type ReportReason, type ReportTarget } from './api';

/** A quiet "Report" link that opens a small form in place. Signed-in members only. */
export function ReportButton({
  targetType,
  targetId,
}: {
  targetType: ReportTarget;
  targetId: string;
}) {
  const { t } = useI18n();
  const { status } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>('SCAM');
  const [details, setDetails] = useState('');
  const send = useMutation({
    mutationFn: () =>
      trustApi.report({ targetType, targetId, reason, details: details.trim() || null }),
  });

  if (status !== 'signedIn') return null;
  if (send.isSuccess)
    return (
      <p className="alert alert--note report" role="status">
        <NoteIcon />
        <span>{t('report.sent')}</span>
      </p>
    );
  if (!open)
    return (
      <p className="report">
        <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
          {t('report.open')}
        </button>
      </p>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <form className="counter report" onSubmit={submit} noValidate aria-label={t('report.title')}>
      <h3>{t('report.title')}</h3>
      <SelectField
        label={t('report.reason')}
        value={reason}
        onChange={(v) => setReason(v as ReportReason)}
        options={ReportReasons.map((r) => ({ value: r, label: t(`report.reason.${r}`) }))}
      />
      <TextAreaField
        label={t('report.details')}
        optional
        value={details}
        onChange={setDetails}
        maxLength={1000}
        rows={3}
      />
      {send.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(send.error, t)}</span>
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn btn--small" disabled={send.isPending}>
          {t('report.send')}
        </button>
        <button
          type="button"
          className="btn btn--outline btn--small"
          onClick={() => setOpen(false)}
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
