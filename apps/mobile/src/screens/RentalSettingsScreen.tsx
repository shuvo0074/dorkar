import { catalogApi } from '@web/features/catalog/api';
import { rentalsApi, type RentalTerms } from '@web/features/rentals/api';
import { asciiDigits, parseTaka, poisha, takaInput } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { c } from '../design/tokens';
import { FormSection, PageError, PageSkeleton } from '../features/catalog/pageParts';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { CheckField, DateField, MoneyField, TextAreaField, TextField } from '../ui/Fields';
import { Alert, Screen, Stack } from '../ui/Layout';
import { T } from '../ui/Text';

export default function RentalSettingsScreen() {
  const { id } = useParams<'RentalSettings'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const { t } = useI18n();
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  const terms = useQuery({
    queryKey: ['listings', id, 'rental-terms'],
    queryFn: () => rentalsApi.terms(id),
  });
  if (listing.isPending || terms.isPending) return <PageSkeleton />;
  if (listing.isError) return <PageError onRetry={() => void listing.refetch()} />;
  if (terms.isError) return <PageError onRetry={() => void terms.refetch()} />;
  return (
    <Screen>
      <Stack gap={4}>
        <T v="bodyStrong">{listing.data.title}</T>
        <T color={c.inkSoft}>{t('rterms.lede')}</T>
      </Stack>
      <TermsForm listingId={id} initial={terms.data} />
      <Blocks listingId={id} />
    </Screen>
  );
}

const int = (v: string) => Number(asciiDigits(v.trim()));

function TermsForm({ listingId, initial }: { listingId: string; initial: RentalTerms }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [instant, setInstant] = useState(initial.instantBook);
  const [minH, setMinH] = useState(String(initial.minDurationHours));
  const [maxD, setMaxD] = useState(String(initial.maxDurationDays));
  const [deposit, setDeposit] = useState(takaInput(initial.deposit));
  const [notice, setNotice] = useState(String(initial.advanceNoticeHours));
  const [buffer, setBuffer] = useState(String(initial.bufferHours));
  const [note, setNote] = useState(initial.cancellationNote ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: (input: Parameters<typeof rentalsApi.saveTerms>[1]) =>
      rentalsApi.saveTerms(listingId, input),
    onSuccess: (saved) => qc.setQueryData(['listings', listingId, 'rental-terms'], saved),
  });

  const submit = () => {
    const range = (v: string, lo: number, hi: number) => {
      const n = int(v);
      return Number.isInteger(n) && n >= lo && n <= hi
        ? undefined
        : t('common.range', { min: lo, max: hi });
    };
    const dep = deposit.trim() ? parseTaka(deposit) : null;
    const errs = {
      minH: range(minH, 1, 8760),
      maxD: range(maxD, 1, 365),
      notice: range(notice, 0, 720),
      buffer: range(buffer, 0, 168),
      deposit: deposit.trim() && dep === null ? t('common.badAmount') : undefined,
      note: note.trim() && note.trim().length > 500 ? t('common.tooLong', { n: 500 }) : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      instantBook: instant,
      minDurationHours: int(minH),
      maxDurationDays: int(maxD),
      deposit: dep === null ? null : poisha(dep),
      advanceNoticeHours: int(notice),
      bufferHours: int(buffer),
      cancellationNote: note.trim() || null,
    });
  };

  return (
    <FormSection>
      <CheckField label={t('rterms.instantBook')} value={instant} onChange={setInstant} />
      <TextField
        label={t('rterms.minHours')}
        keyboard="number-pad"
        value={minH}
        onChange={setMinH}
        error={errors['minH']}
      />
      <TextField
        label={t('rterms.maxDays')}
        keyboard="number-pad"
        value={maxD}
        onChange={setMaxD}
        error={errors['maxD']}
      />
      <TextField
        label={t('rterms.noticeHours')}
        keyboard="number-pad"
        value={notice}
        onChange={setNotice}
        error={errors['notice']}
      />
      <TextField
        label={t('rterms.bufferHours')}
        keyboard="number-pad"
        value={buffer}
        onChange={setBuffer}
        error={errors['buffer']}
      />
      <MoneyField
        label={t('rterms.deposit')}
        optional
        value={deposit}
        onChange={setDeposit}
        error={errors['deposit']}
      />
      <TextAreaField
        label={t('rterms.cancellation')}
        optional
        value={note}
        onChange={setNote}
        maxLength={500}
        error={errors['note']}
      />
      {save.isSuccess ? <Alert tone="info" message={t('rterms.saved')} /> : null}
      {save.isError ? <Alert message={errorMessage(save.error, t)} /> : null}
      <Button block busy={save.isPending} label={t('rterms.save')} onPress={submit} />
    </FormSection>
  );
}

function Blocks({ listingId }: { listingId: string }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const blocks = useQuery({
    queryKey: ['listings', listingId, 'blocks'],
    queryFn: () => rentalsApi.blocks(listingId),
  });
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['listings', listingId, 'blocks'] });
    void qc.invalidateQueries({ queryKey: ['listings', listingId, 'availability'] });
  };
  const add = useMutation({
    mutationFn: (input: { startAt: string; endAt: string; reason?: string }) =>
      rentalsApi.addBlock(listingId, input, intent.key),
    onSuccess: () => {
      intent.renew();
      setFrom('');
      setUntil('');
      setReason('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (blockId: string) => rentalsApi.removeBlock(listingId, blockId),
    onSuccess: refresh,
  });

  const submit = () => {
    if (!from || !until) return setError(t('common.badDate'));
    if (new Date(until) <= new Date(from)) return setError(t('common.badRange'));
    setError(undefined);
    add.mutate({
      startAt: new Date(from).toISOString(),
      endAt: new Date(until).toISOString(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <FormSection title={t('blocks.title')}>
      <T color={c.inkSoft}>{t('blocks.lede')}</T>
      {blocks.data && blocks.data.length === 0 ? <T color={c.inkSoft}>{t('blocks.none')}</T> : null}
      {blocks.data?.map((b) => (
        <View key={b.id} style={styles.block}>
          <T v="small" style={styles.flex}>
            {t('dash.period', { from: date(b.startAt), to: date(b.endAt) })}
            {b.reason ? ` · ${b.reason}` : ''}
          </T>
          <Button
            kind="link"
            small
            label={t('blocks.remove')}
            onPress={() => remove.mutate(b.id)}
          />
        </View>
      ))}
      <DateField mode="datetime" label={t('rent.from')} value={from} onChange={setFrom} />
      <DateField mode="datetime" label={t('rent.until')} value={until} onChange={setUntil} />
      <TextField
        label={t('blocks.reason')}
        optional
        value={reason}
        onChange={setReason}
        maxLength={200}
      />
      {error || add.isError ? <Alert message={error ?? errorMessage(add.error, t)} /> : null}
      <Button kind="outline" small busy={add.isPending} label={t('blocks.add')} onPress={submit} />
    </FormSection>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  block: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
