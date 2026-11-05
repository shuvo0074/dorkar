import {
  Conditions,
  DeliveryModes,
  findContactInfo,
  type Condition,
  type DeliveryMode,
} from '@dorkar/contracts';
import { needsApi, type Need } from '@web/features/needs/api';
import { offersApi, type OfferInput } from '@web/features/offers/api';
import { useFormat } from '@web/lib/format';
import { asciiDigits, parseTaka, poisha } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { StackActions } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import {
  offerTermsFromNeed,
  OfferTermsFields,
  readOfferTerms,
  type OfferTermsDraft,
} from '../features/offers/OfferTerms';
import { errorMessage } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import {
  Chips,
  DateField,
  FieldShell,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../ui/Fields';
import { Alert, Card, LoadError, Screen, Section, Stack } from '../ui/Layout';
import { Skeleton } from '../ui/Misc';
import { PhotoPicker } from '../ui/PhotoPicker';
import { T } from '../ui/Text';

export default function OfferFormScreen() {
  const { needId } = useParams<'OfferForm'>()!;
  return (
    <SignedInOnly>
      <Loader id={needId} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) {
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  }
  if (need.isError) {
    return (
      <Screen>
        <LoadError onRetry={() => void need.refetch()} />
      </Screen>
    );
  }
  return <OfferForm need={need.data} />;
}

const EXPIRY = ['24', '72', '168'] as const;

function OfferForm({ need }: { need: Need }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const qc = useQueryClient();
  const session = useSession();
  const intent = useIntent();
  const remaining = Math.max(1, need.quantity - need.acceptedQuantity);
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState(String(remaining));
  const [condition, setCondition] = useState<Condition | ''>(need.condition[0] ?? '');
  const [method, setMethod] = useState<DeliveryMode>(
    need.mode === 'HIRE'
      ? 'ON_SITE'
      : need.deliveryPreference === 'PICKUP'
      ? 'BUYER_PICKUP'
      : 'SELLER_DELIVERY',
  );
  const [fee, setFee] = useState('');
  const [eta, setEta] = useState('');
  const [available, setAvailable] = useState('');
  const [terms, setTerms] = useState<OfferTermsDraft>(() =>
    offerTermsFromNeed(need.mode, need.modeTerms),
  );
  const [message, setMessage] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>('72');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const send = useMutation({
    mutationFn: (input: OfferInput) => offersApi.submit(need.id, input, intent.key),
    onSuccess: (offer) => {
      intent.renew();
      qc.setQueryData(['offers', offer.id], offer);
      void qc.invalidateQueries({ queryKey: ['me'] });
      nav.dispatch(StackActions.replace('Offer', { id: offer.id, notice: 'sent' }));
    },
  });

  const header = (
    <Stack>
      <LinkText
        label={need.title}
        onPress={() => nav.navigate('Need', { id: need.id }, { pop: true })}
      />
      <T color={c.inkSoft}>{t('offerForm.lede')}</T>
      <T v="small" color={c.inkSoft}>
        {[
          f.place(need.location),
          f.range(need.budget.min, need.budget.max) ?? t('need.budget.none'),
        ].join(' · ')}
      </T>
    </Stack>
  );

  if (session.account?.id === need.requesterId || need.status !== 'OPEN') {
    return (
      <Screen>
        {header}
        <Alert
          tone="info"
          message={t(
            session.account?.id === need.requesterId ? 'offerForm.own' : 'offerForm.closed',
          )}
        />
      </Screen>
    );
  }

  const submit = () => {
    const errs: Record<string, string | undefined> = {};
    const p = parseTaka(price);
    if (p === null || p === 0) errs['price'] = t('common.badAmount');
    const q = Number(asciiDigits(quantity));
    if (!Number.isInteger(q) || q < 1) errs['quantity'] = t('common.badNumber');
    const feeP = fee.trim() ? parseTaka(fee) : null;
    if (fee.trim() && feeP === null) errs['fee'] = t('common.badAmount');
    const etaN = eta.trim() ? Number(asciiDigits(eta)) : null;
    if (etaN !== null && (!Number.isInteger(etaN) || etaN < 0 || etaN > 365))
      errs['eta'] = t('common.badNumber');
    if (findContactInfo(message)) errs['message'] = t('needForm.contact');
    const mt = readOfferTerms(need.mode, terms);
    for (const [k, key] of Object.entries(mt.errors)) errs[`terms.${k}`] = t(key);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    send.mutate({
      price: poisha(p!),
      quantity: q,
      deliveryTerms: {
        method,
        ...(feeP !== null ? { feeAmount: feeP } : {}),
        ...(etaN !== null ? { etaDays: etaN } : {}),
      },
      ...(condition ? { condition } : {}),
      ...(available ? { availabilityFrom: available } : {}),
      modeTerms: mt.value,
      ...(message.trim() ? { description: message.trim() } : {}),
      ...(photos.length ? { attachmentMediaIds: photos } : {}),
      expiresInHours: Number(expiry),
    });
  };

  const termErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k.startsWith('terms.'))
      .map(([k, v]) => [k.slice(6), v]),
  );

  return (
    <Screen>
      {header}
      <Card>
        <Section title={`${num(1)}. ${t('offer.price')}`}>
          <MoneyField
            label={t('offerForm.price')}
            hint={t('offerForm.priceHint')}
            value={price}
            onChange={setPrice}
            error={errors['price']}
          />
          <TextField
            label={t('offerForm.quantity')}
            hint={t('offerForm.quantityHint', { n: num(need.quantity) })}
            keyboard="number-pad"
            value={quantity}
            onChange={setQuantity}
            error={errors['quantity']}
          />
          {need.mode !== 'HIRE' ? (
            <SelectField
              label={t('offerForm.condition')}
              value={condition}
              onChange={(v) => setCondition(v as Condition | '')}
              placeholder={t('offerForm.conditionPick')}
              options={Conditions.map((x) => ({ value: x, label: f.condition(x) }))}
            />
          ) : null}
          <OfferTermsFields
            mode={need.mode}
            draft={terms}
            onChange={setTerms}
            errors={termErrors}
          />
        </Section>
      </Card>

      <Card>
        <Section title={`${num(2)}. ${t('offerForm.delivery')}`}>
          <SelectField
            label={t('offerForm.delivery')}
            value={method}
            onChange={(v) => setMethod(v as DeliveryMode)}
            options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
          />
          <MoneyField
            label={t('offerForm.fee')}
            optional
            value={fee}
            onChange={setFee}
            error={errors['fee']}
          />
          <TextField
            label={t('offerForm.eta')}
            optional
            keyboard="number-pad"
            value={eta}
            onChange={setEta}
            error={errors['eta']}
          />
          <DateField
            label={t('offerForm.available')}
            optional
            value={available}
            onChange={setAvailable}
          />
        </Section>
      </Card>

      <Card>
        <Section title={`${num(3)}. ${t('offerForm.send')}`}>
          <TextAreaField
            label={t('offerForm.message')}
            optional
            hint={t('offerForm.messageHint')}
            value={message}
            onChange={setMessage}
            maxLength={2000}
            error={errors['message']}
          />
          <PhotoPicker purpose="OFFER" value={photos} onChange={setPhotos} max={5} />
          <FieldShell label={t('offerForm.expires')}>
            <Chips
              label={t('offerForm.expires')}
              value={expiry}
              onChange={(v) => setExpiry(v as (typeof EXPIRY)[number])}
              options={EXPIRY.map((h) => ({ value: h, label: t(`offerForm.expires.${h}`) }))}
            />
          </FieldShell>
          {send.isError ? (
            <Alert
              message={
                send.error instanceof ApiError && send.error.code === 'VERIFICATION_REQUIRED'
                  ? t('offerForm.verify')
                  : errorMessage(send.error, t)
              }
            />
          ) : null}
          <Button
            block
            busy={send.isPending}
            label={send.isPending ? t('offerForm.sending') : t('offerForm.send')}
            onPress={submit}
          />
        </Section>
      </Card>
    </Screen>
  );
}
