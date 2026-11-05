import { findContactInfo } from '@dorkar/contracts';
import { needsApi } from '@web/features/needs/api';
import { offersApi, type OfferAction, type OfferDetail } from '@web/features/offers/api';
import { shortCode, useFormat } from '@web/lib/format';
import { asciiDigits, parseTaka, poisha, takaInput } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { c, r } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { MessageButton } from '../features/messages/MessageButton';
import { FactAside, FactValue, ModeTile, NotFound, TimelineItem } from '../features/needs/parts';
import { OfferTermsList } from '../features/offers/OfferTerms';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { MoneyField, TextAreaField, TextField } from '../ui/Fields';
import { Alert, Card, LoadError, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact, MediaImage, Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

export default function OfferScreen() {
  const { id } = useParams<'Offer'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const offer = useQuery({ queryKey: ['offers', id], queryFn: () => offersApi.get(id) });
  if (offer.isPending) {
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  }
  if (offer.error instanceof ApiError && offer.error.status === 404) return <NotFound />;
  if (offer.isError) {
    return (
      <Screen>
        <LoadError onRetry={() => void offer.refetch()} />
      </Screen>
    );
  }
  return (
    <OfferPage
      offer={offer.data}
      refreshing={offer.isRefetching}
      onRefresh={() => void offer.refetch()}
    />
  );
}

function OfferPage({
  offer,
  refreshing,
  onRefresh,
}: {
  offer: OfferDetail;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, num, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const session = useSession();
  const [accepted, setAccepted] = useState(false);
  const notice = useParams<'Offer'>()?.notice;
  const need = useQuery({
    queryKey: ['needs', offer.needId],
    queryFn: () => needsApi.get(offer.needId),
  });
  const role = session.account?.id === offer.buyerId ? 'BUYER' : 'SELLER';
  const d = offer.deliveryTerms;

  useLayoutEffect(() => {
    nav.setOptions({ title: t('offer.title', { code: shortCode('O', offer.id) }) });
  }, [nav, t, offer.id]);

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Stack>
        <LinkText
          label={need.data?.title ?? t('offer.onNeed')}
          onPress={() => nav.navigate('Need', { id: offer.needId })}
        />
        <Row>
          {need.data ? <ModeTile mode={need.data.mode} size={36} /> : null}
          <Badge label={f.state(offer.status)} />
          <T v="small" color={c.inkSoft}>
            {t(role === 'BUYER' ? 'offer.theirOffer' : 'offer.yourOffer')}
          </T>
        </Row>
        <PageTitle>{`${f.taka(offer.price)} × ${num(offer.quantity)}`}</PageTitle>
        {notice === 'sent' ? <Alert tone="info" message={t('offer.sent')} /> : null}
        {accepted || offer.status === 'ACCEPTED' ? (
          <>
            <Alert tone="info" message={t('offer.accepted')} />
            <LinkText label={t('nav.deals')} onPress={() => nav.navigate('Deals')} />
          </>
        ) : null}
        {offer.hidden ? <Alert message={t('offer.hidden')} /> : null}
      </Stack>

      <Section title={t('need.details')}>
        {offer.description ? <T>{offer.description}</T> : null}
        {offer.attachmentMediaIds.length > 0 ? (
          <Row>
            {offer.attachmentMediaIds.map((m, i) => (
              <MediaImage
                key={m}
                id={m}
                style={styles.photo}
                alt={t('photos.photo', { n: num(i + 1) })}
              />
            ))}
          </Row>
        ) : null}
        <Card>
          <Fact label={t('deal.otherSide')}>
            <UserLink userId={role === 'BUYER' ? offer.sellerId : offer.buyerId} />
          </Fact>
          <Fact label={t('offer.quantity')}>{num(offer.quantity)}</Fact>
          {offer.condition ? (
            <Fact label={t('offer.condition')}>{f.condition(offer.condition)}</Fact>
          ) : null}
          <Fact label={t('offer.delivery')}>
            <FactValue>
              {d.feeAmount
                ? t('offer.deliveryFee', { method: f.delivery(d.method), fee: f.taka(d.feeAmount) })
                : f.delivery(d.method)}
            </FactValue>
            {d.etaDays !== undefined ? (
              <FactAside>{t('offer.eta', { n: d.etaDays })}</FactAside>
            ) : null}
          </Fact>
          {offer.availabilityFrom ? (
            <Fact label={t('offer.available')}>{date(offer.availabilityFrom, 'short')}</Fact>
          ) : null}
          <OfferTermsList terms={offer.modeTerms} />
        </Card>
      </Section>

      <Card>
        {offer.awaiting ? (
          offer.awaiting === role ? (
            <Badge tone="hot" label={t('compare.yourTurn')} />
          ) : (
            <T v="bodyStrong">{t('compare.theirTurn')}</T>
          )
        ) : null}
        {offer.status !== 'ACCEPTED' && offer.awaiting ? (
          <T color={c.inkSoft}>{t('offer.expires', { when: date(offer.expiresAt) })}</T>
        ) : null}
        <Actions offer={offer} onAccepted={() => setAccepted(true)} />
        <MessageButton
          contextType="OFFER"
          contextId={offer.id}
          label={t(role === 'BUYER' ? 'chat.messageSeller' : 'chat.messageBuyer')}
        />
      </Card>
      {role === 'BUYER' ? <ReportButton targetType="OFFER" targetId={offer.id} /> : null}

      <Section title={t('offer.rounds')}>
        <Card>
          {[...offer.rounds].reverse().map((x) => (
            <TimelineItem
              key={x.round}
              at={x.createdAt}
              text={[
                t('offer.round', { n: x.round }),
                x.proposedBy === role ? t('offer.you') : t(`offer.by.${x.proposedBy}`),
                `${f.taka(x.price)} × ${num(x.quantity)}`,
              ].join(' · ')}
              note={x.message ? `“${x.message}”` : null}
            />
          ))}
        </Card>
      </Section>
    </Screen>
  );
}

function Actions({ offer, onAccepted }: { offer: OfferDetail; onAccepted: () => void }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState<OfferAction | null>(null);

  const done = (next: OfferDetail) => {
    intent.renew();
    setOpen(null);
    qc.setQueryData(['offers', offer.id], next);
    void qc.invalidateQueries({ queryKey: ['me'] });
    void qc.invalidateQueries({ queryKey: ['offers', 'need', offer.needId] });
    void qc.invalidateQueries({ queryKey: ['needs', offer.needId] });
  };
  const act = useMutation({
    mutationFn: (a: Exclude<OfferAction, 'COUNTER'>) =>
      a === 'ACCEPT'
        ? offersApi.accept(offer.id, intent.key)
        : a === 'REJECT'
        ? offersApi.reject(offer.id)
        : offersApi.withdraw(offer.id),
    onSuccess: (next, a) => {
      done(next);
      if (a === 'ACCEPT') onAccepted();
    },
    onError: () => setOpen(null),
  });

  if (offer.actions.length === 0) return null;

  return (
    <Stack>
      {open === 'COUNTER' ? (
        <Counter
          offer={offer}
          intentKey={intent.key}
          onDone={done}
          onCancel={() => setOpen(null)}
        />
      ) : (
        <>
          {offer.actions.includes('ACCEPT') ? (
            <Button block label={t('offer.accept')} onPress={() => setOpen('ACCEPT')} />
          ) : null}
          {offer.actions.includes('COUNTER') ? (
            <Button
              block
              kind="outline"
              label={t('offer.counter')}
              onPress={() => setOpen('COUNTER')}
            />
          ) : null}
          {offer.actions.includes('REJECT') ? (
            <Button
              block
              kind="danger"
              label={t('offer.reject')}
              onPress={() => setOpen('REJECT')}
            />
          ) : null}
          {offer.actions.includes('WITHDRAW') ? (
            <Button
              block
              kind="danger"
              label={t('offer.withdraw')}
              onPress={() => setOpen('WITHDRAW')}
            />
          ) : null}
        </>
      )}
      <Confirm
        visible={open === 'ACCEPT'}
        title={t('offer.acceptYes')}
        body={t('offer.acceptConfirm', { price: f.taka(offer.price), n: num(offer.quantity) })}
        confirmLabel={t('offer.acceptYes')}
        cancelLabel={t('common.keep')}
        busy={act.isPending}
        onConfirm={() => act.mutate('ACCEPT')}
        onClose={() => setOpen(null)}
      />
      <Confirm
        visible={open === 'REJECT'}
        danger
        title={t('offer.rejectYes')}
        body={t('offer.rejectConfirm')}
        confirmLabel={t('offer.rejectYes')}
        cancelLabel={t('common.keep')}
        busy={act.isPending}
        onConfirm={() => act.mutate('REJECT')}
        onClose={() => setOpen(null)}
      />
      <Confirm
        visible={open === 'WITHDRAW'}
        danger
        title={t('offer.withdrawYes')}
        body={t('offer.withdrawConfirm')}
        confirmLabel={t('offer.withdrawYes')}
        cancelLabel={t('common.keep')}
        busy={act.isPending}
        onConfirm={() => act.mutate('WITHDRAW')}
        onClose={() => setOpen(null)}
      />
      {act.isError ? <Alert message={errorMessage(act.error, t)} /> : null}
    </Stack>
  );
}

function Counter({
  offer,
  intentKey,
  onDone,
  onCancel,
}: {
  offer: OfferDetail;
  intentKey: string;
  onDone: (o: OfferDetail) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = useState(takaInput(offer.price));
  const [quantity, setQuantity] = useState(String(offer.quantity));
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const send = useMutation({
    mutationFn: (input: Parameters<typeof offersApi.counter>[1]) =>
      offersApi.counter(offer.id, input, intentKey),
    onSuccess: onDone,
  });

  const submit = () => {
    const p = parseTaka(price);
    const q = Number(asciiDigits(quantity));
    const errs = {
      price: p === null || p === 0 ? t('common.badAmount') : undefined,
      quantity: !Number.isInteger(q) || q < 1 ? t('common.badNumber') : undefined,
      message: findContactInfo(message) ? t('needForm.contact') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    send.mutate({
      price: poisha(p!),
      quantity: q,
      ...(message.trim() ? { message: message.trim() } : {}),
    });
  };

  return (
    <Stack>
      <T v="section" accessibilityRole="header">
        {t('offer.counterTitle')}
      </T>
      <MoneyField
        label={t('offer.price')}
        value={price}
        onChange={setPrice}
        error={errors['price']}
      />
      <TextField
        label={t('offer.quantity')}
        keyboard="number-pad"
        value={quantity}
        onChange={setQuantity}
        error={errors['quantity']}
      />
      <TextAreaField
        label={t('offer.counterMessage')}
        optional
        value={message}
        onChange={setMessage}
        maxLength={1000}
        error={errors['message']}
      />
      {send.isError ? <Alert message={errorMessage(send.error, t)} /> : null}
      <Button block busy={send.isPending} label={t('offer.counterSend')} onPress={submit} />
      <Button block kind="outline" label={t('common.cancel')} onPress={onCancel} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  photo: { width: 100, height: 100, borderRadius: r.control, backgroundColor: c.paperShade },
});
