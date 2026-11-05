import { auctionsApi, type AuctionInput, type AuctionKind } from '@web/features/auctions/api';
import { catalogApi } from '@web/features/catalog/api';
import { needsApi } from '@web/features/needs/api';
import { asciiDigits, parseTaka, poisha } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { StackActions } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { FormSection, PageSkeleton, useTitle } from '../features/catalog/pageParts';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { DateField, MoneyField, TextField } from '../ui/Fields';
import { Alert, Screen, Stack } from '../ui/Layout';
import { T } from '../ui/Text';

export default function AuctionFormScreen() {
  const params = useParams<'AuctionForm'>();
  return (
    <SignedInOnly>
      <Subject listingId={params?.listingId ?? null} needId={params?.needId ?? null} />
    </SignedInOnly>
  );
}

function Subject({ listingId, needId }: { listingId: string | null; needId: string | null }) {
  const { t } = useI18n();
  const listing = useQuery({
    queryKey: ['listings', listingId],
    queryFn: () => catalogApi.listing(listingId!),
    enabled: Boolean(listingId),
  });
  const need = useQuery({
    queryKey: ['needs', needId],
    queryFn: () => needsApi.get(needId!),
    enabled: Boolean(needId),
  });
  if (!listingId && !needId)
    return (
      <Screen>
        <Alert tone="info" message={t('auctionForm.missing')} />
      </Screen>
    );
  if (listing.isPending && need.isPending) return <PageSkeleton rows={5} />;
  if (listing.data)
    return <AuctionForm kind="FORWARD" subjectId={listing.data.id} title={listing.data.title} />;
  if (need.data)
    return <AuctionForm kind="REVERSE" subjectId={need.data.id} title={need.data.title} />;
  return <PageSkeleton rows={5} />;
}

function AuctionForm({
  kind,
  subjectId,
  title,
}: {
  kind: AuctionKind;
  subjectId: string;
  title: string;
}) {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const intent = useIntent();
  const [start, setStart] = useState('');
  const [reserve, setReserve] = useState('');
  const [step, setStep] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [snipe, setSnipe] = useState('120');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  useTitle(t(`auctionForm.title.${kind}`));
  const create = useMutation({
    mutationFn: (input: AuctionInput) => auctionsApi.create(input, intent.key),
    onSuccess: (a) => {
      intent.renew();
      qc.setQueryData(['auctions', a.id], a);
      void qc.invalidateQueries({ queryKey: ['me'] });
      // Back from the running auction never lands on the finished form.
      nav.dispatch(StackActions.replace('Auction', { id: a.id }));
    },
  });

  const submit = () => {
    const s = start.trim() ? parseTaka(start) : null;
    const r = reserve.trim() ? parseTaka(reserve) : null;
    const inc = parseTaka(step);
    const q = Number(asciiDigits(quantity));
    const sn = Number(asciiDigits(snipe || '0'));
    const errs = {
      start:
        kind === 'FORWARD' && (s === null || s === 0)
          ? t('common.badAmount')
          : start.trim() && s === null
          ? t('common.badAmount')
          : undefined,
      reserve: reserve.trim() && r === null ? t('common.badAmount') : undefined,
      step: inc === null || inc === 0 ? t('common.badAmount') : undefined,
      quantity:
        kind === 'FORWARD' && (!Number.isInteger(q) || q < 1) ? t('common.badNumber') : undefined,
      closes: !closes
        ? t('common.required')
        : opens && new Date(closes) <= new Date(opens)
        ? t('common.badRange')
        : undefined,
      snipe:
        !Number.isInteger(sn) || sn < 0 || sn > 600
          ? t('common.range', { min: 0, max: 600 })
          : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    create.mutate({
      kind,
      subjectId,
      ...(kind === 'FORWARD' ? { quantity: q } : {}),
      ...(s !== null ? { startPrice: poisha(s) } : {}),
      reservePrice: r === null ? null : poisha(r),
      minIncrement: poisha(inc!),
      ...(opens ? { startsAt: new Date(opens).toISOString() } : {}),
      endsAt: new Date(closes).toISOString(),
      antiSnipeSeconds: sn,
    });
  };

  return (
    <Screen>
      <Stack gap={4}>
        <T v="bodyStrong">{title}</T>
        <T color={c.inkSoft}>{t(`auctionForm.lede.${kind}`)}</T>
      </Stack>
      <FormSection>
        <MoneyField
          label={t('auctionForm.startPrice')}
          optional={kind === 'REVERSE'}
          hint={kind === 'REVERSE' ? t('auctionForm.startPriceHint.REVERSE') : undefined}
          value={start}
          onChange={setStart}
          error={errors['start']}
        />
        <MoneyField
          label={t('auctionForm.step')}
          value={step}
          onChange={setStep}
          error={errors['step']}
        />
        <MoneyField
          label={t('auctionForm.reserve')}
          optional
          hint={t('auctionForm.reserveHint')}
          value={reserve}
          onChange={setReserve}
          error={errors['reserve']}
        />
        {kind === 'FORWARD' ? (
          <TextField
            label={t('auctionForm.quantity')}
            keyboard="number-pad"
            value={quantity}
            onChange={setQuantity}
            error={errors['quantity']}
          />
        ) : null}
        <DateField
          mode="datetime"
          label={t('auctionForm.startsAt')}
          optional
          hint={t('auctionForm.startsAtHint')}
          value={opens}
          onChange={setOpens}
        />
        <DateField
          mode="datetime"
          label={t('auctionForm.endsAt')}
          hint={t('auctionForm.endsAtHint')}
          value={closes}
          onChange={setCloses}
          error={errors['closes']}
        />
        <TextField
          label={t('auctionForm.antiSnipe')}
          keyboard="number-pad"
          value={snipe}
          onChange={setSnipe}
          error={errors['snipe']}
        />
        {create.isError ? <Alert message={errorMessage(create.error, t)} /> : null}
        <Button block busy={create.isPending} label={t('auctionForm.start')} onPress={submit} />
      </FormSection>
    </Screen>
  );
}
