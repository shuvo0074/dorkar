import { DeliveryModes, findContactInfo, type DeliveryMode } from '@dorkar/contracts';
import {
  dealCode,
  dealsApi,
  dealTitle,
  DisputeReasons,
  finalStates,
  type DealAction,
  type DealCommandBody,
  type DealDetail,
  type DisputeReason,
} from '@web/features/deals/api';
import { disputesApi } from '@web/features/disputes/api';
import { needsApi } from '@web/features/needs/api';
import { useFormat } from '@web/lib/format';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { MessageButton } from '../features/messages/MessageButton';
import { FactAside, FactValue, ModeTile, NotFound, TimelineItem } from '../features/needs/parts';
import { DealReviews } from '../features/trust/DealReviews';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { DateField, SelectField, TextAreaField } from '../ui/Fields';
import { Alert, Card, LoadError, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact, Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

export default function DealScreen() {
  const { id } = useParams<'Deal'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const qc = useQueryClient();
  const deal = useQuery({ queryKey: ['deals', id], queryFn: () => dealsApi.get(id) });
  if (deal.isPending) {
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  }
  if (deal.error instanceof ApiError && deal.error.status === 404) return <NotFound />;
  if (deal.isError) {
    return (
      <Screen>
        <LoadError onRetry={() => void deal.refetch()} />
      </Screen>
    );
  }
  return (
    <DealPage
      deal={deal.data}
      refreshing={deal.isRefetching}
      onRefresh={() => {
        void deal.refetch();
        void qc.invalidateQueries({ queryKey: ['deals', id, 'reviews'] });
      }}
    />
  );
}

function DealPage({
  deal,
  refreshing,
  onRefresh,
}: {
  deal: DealDetail;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, num, date, has } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  const need = useQuery({
    queryKey: ['needs', deal.needId],
    queryFn: () => needsApi.get(deal.needId!),
    enabled: Boolean(deal.needId),
  });
  const title = dealTitle(deal) ?? need.data?.title ?? t('deals.code', { code: dealCode(deal.id) });
  const role = deal.viewerRole;
  const mineConfirmed = role === 'BUYER' ? deal.buyerConfirmedAt : deal.sellerConfirmedAt;
  const theirsConfirmed = role === 'BUYER' ? deal.sellerConfirmedAt : deal.buyerConfirmedAt;

  const openSource = (() => {
    switch (deal.sourceType) {
      case 'OFFER':
        return () => nav.navigate('Offer', { id: deal.sourceId });
      case 'LISTING':
        return deal.listingId ? () => nav.navigate('Listing', { id: deal.listingId! }) : null;
      case 'AUCTION':
        return () => nav.navigate('Auction', { id: deal.sourceId });
      case 'BOOKING':
        return () => nav.navigate('Booking', { id: deal.sourceId });
      case 'LOAN':
        return () => nav.navigate('Loan', { id: deal.sourceId });
    }
  })();

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Stack>
        <LinkText label={t('nav.deals')} onPress={() => nav.navigate('Deals')} />
        <Row>
          <ModeTile mode={deal.mode} size={36} />
          <T v="code" color={c.inkSoft}>
            {t('deals.code', { code: dealCode(deal.id) })}
          </T>
          <Badge
            tone={finalStates.has(deal.state) ? 'quiet' : 'good'}
            label={f.state(deal.state)}
          />
          {role ? (
            <T v="small" color={c.inkSoft}>
              {t(`deals.as.${role}`)}
            </T>
          ) : null}
        </Row>
        <PageTitle>{title}</PageTitle>
        <T color={c.inkSoft}>
          {`${f.taka(deal.amount)}${deal.quantity > 1 ? ` × ${num(deal.quantity)}` : ''} · ${t(
            'deal.payment.cash',
          )}`}
        </T>
      </Stack>

      <Section title={t('need.details')}>
        <Card>
          <Fact label={t('deal.amount')}>{f.taka(deal.amount)}</Fact>
          <Fact label={t('deal.quantity')}>{num(deal.quantity)}</Fact>
          <Fact label={t('deal.mode')}>{t(`mode.${deal.mode}`)}</Fact>
          {role ? (
            <Fact label={t('deal.otherSide')}>
              <UserLink userId={role === 'BUYER' ? deal.sellerId : deal.buyerId} />
            </Fact>
          ) : null}
          <Fact label={t('deal.source')}>
            <FactValue>{t(`deal.source.${deal.sourceType}`)}</FactValue>
            {openSource ? <LinkText label={t('deal.openSource')} onPress={openSource} /> : null}
          </Fact>
          {deal.needId ? (
            <Fact label={t('deal.need')}>
              <LinkText
                label={need.data?.title ?? t('deal.openSource')}
                onPress={() => nav.navigate('Need', { id: deal.needId! })}
              />
            </Fact>
          ) : null}
          {deal.state === 'CREATED' ? (
            <Fact label={t('deal.confirmations')}>
              {mineConfirmed && theirsConfirmed
                ? t('deal.confirmed.both')
                : mineConfirmed
                ? t('deal.confirmed.you')
                : theirsConfirmed
                ? t('deal.confirmed.them')
                : t('deal.confirmed.none')}
            </Fact>
          ) : null}
          {deal.payment ? (
            <Fact label={t('deal.payment')}>
              {`${f.taka(deal.payment.amount)} · ${t(`deal.payment.${deal.payment.status}`)}`}
            </Fact>
          ) : null}
          {deal.delivery ? (
            <Fact label={t('deal.delivery')}>
              <FactValue>{`${f.delivery(deal.delivery.method)} · ${t(
                `deal.delivery.${deal.delivery.status}`,
              )}`}</FactValue>
              {deal.delivery.scheduledFor ? (
                <FactAside>
                  {t('deal.scheduled', { when: date(deal.delivery.scheduledFor) })}
                </FactAside>
              ) : null}
              {deal.delivery.notes ? <FactAside>{`“${deal.delivery.notes}”`}</FactAside> : null}
            </Fact>
          ) : null}
          {deal.deposit ? (
            <Fact label={t('deal.deposit')}>
              {`${f.taka(deal.deposit.amount)} · ${t(`deal.deposit.${deal.deposit.status}`)}`}
            </Fact>
          ) : null}
          {deal.cancelReason ? (
            <Fact label={t('deal.cancelReason')}>{deal.cancelReason}</Fact>
          ) : null}
          {deal.disputeReason ? (
            <Fact label={t('deal.disputeReason')}>
              <FactValue>
                {`${deal.disputeCategory ? `${t(`reason.${deal.disputeCategory}`)}: ` : ''}${
                  deal.disputeReason
                }`}
              </FactValue>
              {role ? <DisputeLink transactionId={deal.id} /> : null}
            </Fact>
          ) : null}
        </Card>
      </Section>

      <Card>
        <Actions deal={deal} />
        {role ? (
          <MessageButton
            contextType="TRANSACTION"
            contextId={deal.id}
            label={t(role === 'BUYER' ? 'chat.messageSeller' : 'chat.messageBuyer')}
          />
        ) : null}
      </Card>

      {deal.state === 'COMPLETED' && role ? <DealReviews transactionId={deal.id} /> : null}

      <Section title={t('deal.timeline')}>
        <Card>
          {[...deal.transitions].reverse().map((tr, i) => (
            <TimelineItem
              key={i}
              at={tr.at}
              text={tr.from === tr.to ? f.state(tr.to) : `${f.state(tr.from)} → ${f.state(tr.to)}`}
              note={`${
                tr.actorId && tr.actorId === me
                  ? t('deal.byYou')
                  : has(`deal.by.${tr.actorRole}`)
                  ? t(`deal.by.${tr.actorRole}` as MessageKey)
                  : tr.actorRole.toLowerCase()
              }${tr.reason ? ` · “${tr.reason}”` : ''}`}
            />
          ))}
        </Card>
      </Section>
    </Screen>
  );
}

/** Steps whose button is the primary one; everything else is outlined. */
const FORWARD: DealAction[] = [
  'confirm',
  'mark-delivered',
  'confirm-receipt',
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
];

function Actions({ deal }: { deal: DealDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [open, setOpen] = useState<'cancel' | 'arrange-delivery' | 'dispute' | null>(null);
  const run = useMutation({
    mutationFn: (cmd: DealCommandBody) => dealsApi.command(deal.id, cmd, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setOpen(null);
      qc.setQueryData(['deals', deal.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (finalStates.has(deal.state)) return <T v="bodyStrong">{t('deal.final')}</T>;
  if (deal.actions.length === 0) return <T color={c.inkSoft}>{t('deal.noActions')}</T>;

  const forward = deal.actions.filter((a) => FORWARD.includes(a));
  return (
    <Stack>
      {open === null ? (
        <>
          {forward.map((a, i) => (
            <Stack key={a} gap={6}>
              <Button
                block
                kind={i === 0 ? 'primary' : 'outline'}
                disabled={run.isPending}
                label={t(`deal.cmd.${a}`)}
                onPress={() => run.mutate({ action: a } as DealCommandBody)}
              />
              {a === 'confirm' ||
              a === 'mark-delivered' ||
              a === 'confirm-receipt' ||
              a === 'complete' ? (
                <T v="small" color={c.inkSoft}>
                  {t(`deal.help.${a}`)}
                </T>
              ) : null}
            </Stack>
          ))}
          {deal.actions.includes('arrange-delivery') ? (
            <Button
              block
              kind="outline"
              small
              label={t('deal.cmd.arrange-delivery')}
              onPress={() => setOpen('arrange-delivery')}
            />
          ) : null}
          {deal.actions.includes('dispute') ? (
            <Button
              block
              kind="outline"
              small
              label={t('deal.cmd.dispute')}
              onPress={() => setOpen('dispute')}
            />
          ) : null}
          {deal.actions.includes('cancel') ? (
            <Button
              block
              kind="danger"
              small
              label={t('deal.cmd.cancel')}
              onPress={() => setOpen('cancel')}
            />
          ) : null}
        </>
      ) : null}
      {open === 'cancel' ? (
        <CancelForm busy={run.isPending} onSend={run.mutate} onClose={() => setOpen(null)} />
      ) : null}
      {open === 'arrange-delivery' ? (
        <ArrangeForm busy={run.isPending} onSend={run.mutate} onClose={() => setOpen(null)} />
      ) : null}
      {open === 'dispute' ? (
        <DisputeForm
          mode={deal.mode}
          busy={run.isPending}
          onSend={run.mutate}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {run.isError ? <Alert message={errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}

interface SubForm {
  busy: boolean;
  onSend: (cmd: DealCommandBody) => void;
  onClose: () => void;
}

function CancelForm({ busy, onSend, onClose }: SubForm) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (reason.trim().length < 3) return setError(t('common.required'));
    onSend({ action: 'cancel', reason: reason.trim() });
  };
  return (
    <Stack>
      <TextAreaField
        label={t('deal.cancel.reason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        error={error}
      />
      <Button block kind="danger" busy={busy} label={t('deal.cancel.yes')} onPress={submit} />
      <Button block kind="outline" label={t('common.keep')} onPress={onClose} />
    </Stack>
  );
}

function ArrangeForm({ busy, onSend, onClose }: SubForm) {
  const { t } = useI18n();
  const f = useFormat();
  const [method, setMethod] = useState<DeliveryMode>('SELF_ARRANGED');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (findContactInfo(notes)) return setError(t('needForm.contact'));
    onSend({
      action: 'arrange-delivery',
      method,
      ...(when ? { scheduledFor: new Date(when).toISOString() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
  };
  return (
    <Stack>
      <SelectField
        label={t('deal.arrange.method')}
        value={method}
        onChange={(v) => setMethod(v as DeliveryMode)}
        options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
      />
      <DateField
        mode="datetime"
        label={t('deal.arrange.when')}
        optional
        value={when}
        onChange={setWhen}
      />
      <TextAreaField
        label={t('deal.arrange.notes')}
        optional
        hint={t('deal.arrange.notesHint')}
        value={notes}
        onChange={setNotes}
        maxLength={500}
        error={error}
      />
      <Button block busy={busy} label={t('deal.arrange.send')} onPress={submit} />
      <Button block kind="outline" label={t('common.cancel')} onPress={onClose} />
    </Stack>
  );
}

function DisputeForm({ busy, onSend, onClose, mode }: SubForm & { mode: DealDetail['mode'] }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<DisputeReason>(
    mode === 'RENT' || mode === 'BORROW' ? 'NOT_RETURNED' : 'NOT_RECEIVED',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (reason.trim().length < 3) return setError(t('common.required'));
    onSend({ action: 'dispute', reason: reason.trim(), category });
  };
  return (
    <Stack>
      <Alert tone="info" message={t('deal.dispute.help')} />
      <SelectField
        label={t('deal.dispute.category')}
        value={category}
        onChange={(v) => setCategory(v as DisputeReason)}
        options={DisputeReasons.map((x) => ({ value: x, label: t(`reason.${x}`) }))}
      />
      <TextAreaField
        label={t('deal.dispute.reason')}
        value={reason}
        onChange={setReason}
        maxLength={500}
        error={error}
      />
      <Button block busy={busy} label={t('deal.dispute.send')} onPress={submit} />
      <Button block kind="outline" label={t('common.cancel')} onPress={onClose} />
    </Stack>
  );
}

/** The dispute on this deal, found among the member's disputes. */
function DisputeLink({ transactionId }: { transactionId: string }) {
  const { t } = useI18n();
  const nav = useNav();
  const mine = useQuery({
    queryKey: ['me', 'disputes', 'for', transactionId],
    queryFn: () => disputesApi.mine(),
  });
  const d = mine.data?.data.find((x) => x.transactionId === transactionId);
  if (!d) return null;
  return (
    <LinkText label={t('dispute.see')} onPress={() => nav.navigate('Dispute', { id: d.id })} />
  );
}
