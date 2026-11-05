import {
  ReportReasons,
  trustApi,
  type ReportReason,
  type ReportTarget,
} from '@web/features/trust/api';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { Button } from '../../ui/Button';
import { SelectField, TextAreaField } from '../../ui/Fields';
import { Alert, Card, Row } from '../../ui/Layout';
import { T } from '../../ui/Text';
import { useSession } from '../auth/session';

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
  if (send.isSuccess) return <Alert tone="info" message={t('report.sent')} />;
  if (!open)
    return <Button kind="link" small label={t('report.open')} onPress={() => setOpen(true)} />;

  return (
    <Card>
      <T v="section" accessibilityRole="header">
        {t('report.title')}
      </T>
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
      />
      {send.isError ? <Alert message={errorMessage(send.error, t)} /> : null}
      <Row>
        <Button
          small
          busy={send.isPending}
          label={t('report.send')}
          onPress={() => send.mutate()}
        />
        <Button small kind="outline" label={t('common.cancel')} onPress={() => setOpen(false)} />
      </Row>
    </Card>
  );
}
