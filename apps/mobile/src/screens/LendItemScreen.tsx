import { findContactInfo } from '@dorkar/contracts';
import { useCategories } from '@web/features/catalog/categories';
import { itemCode, lendingApi, type LendItemDetail } from '@web/features/lending/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import {
  Gallery,
  NotFound,
  PageError,
  PageSkeleton,
  useRefresh,
} from '../features/catalog/pageParts';
import { MessageButton } from '../features/messages/MessageButton';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage, ruleOf } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { DateField, TextAreaField } from '../ui/Fields';
import { BorrowIcon } from '../ui/icons';
import { Alert, Card, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact } from '../ui/Misc';
import { T } from '../ui/Text';

export default function LendItemScreen() {
  const { id } = useParams<'LendItem'>()!;
  const item = useQuery({ queryKey: ['lend-items', id], queryFn: () => lendingApi.item(id) });
  const pull = useRefresh(() => item.refetch());
  if (item.isPending) return <PageSkeleton />;
  if (item.error instanceof ApiError && item.error.status === 404) return <NotFound />;
  if (item.isError) return <PageError onRetry={() => void item.refetch()} />;
  return (
    <Screen {...pull}>
      <ItemPage item={item.data} />
    </Screen>
  );
}

function ItemPage({ item }: { item: LendItemDetail }) {
  const { t, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const session = useSession();
  const categories = useCategories();
  const r = item.requirements;
  const reqs = [
    r.nidVerified && t('lend.req.nid'),
    r.minCompletedDeals > 0 && t('lend.req.deals', { n: r.minCompletedDeals }),
    r.minRating !== null && t('lend.req.rating', { n: r.minRating }),
  ].filter(Boolean);
  const first = item.mediaIds[0];

  return (
    <>
      <Stack>
        <Row>
          <T v="code" color={c.inkSoft}>
            {t('lend.code', { code: itemCode(item.id) })}
          </T>
          {!item.active ? <Badge label={t('lend.inactive')} /> : null}
        </Row>
        <PageTitle>{item.title}</PageTitle>
        <T color={c.inkSoft}>
          {f.district(item.district)} ·{' '}
          {item.deposit ? `${t('lend.deposit')} ${f.taka(item.deposit)}` : t('lend.noDeposit')}
        </T>
      </Stack>

      <Gallery
        ids={first ? [first] : []}
        label={t('lend.about')}
        fallback={<BorrowIcon size={48} color={c.inkSoft} />}
      />

      <Section title={t('lend.about')}>
        {item.description ? <T>{item.description}</T> : null}
        <Card>
          {!item.viewerIsOwner ? (
            <Fact label={t('lend.lender')}>
              <UserLink userId={item.lenderId} />
            </Fact>
          ) : null}
          <Fact label={t('need.category')}>{categories.name(item.categoryId) || '—'}</Fact>
          <Fact label={t('lend.condition')}>{f.condition(item.condition)}</Fact>
          <Fact label={t('lend.deposit')}>
            {item.deposit ? f.taka(item.deposit) : t('lend.noDeposit')}
          </Fact>
          <Fact label={t('lend.maxDays')}>{t('lend.days', { n: item.maxLoanDays })}</Fact>
          <Fact label={t('lend.requirements')}>
            {reqs.length ? reqs.join(' · ') : t('lend.req.anyone')}
          </Fact>
          <Fact label={t('lend.stats')}>
            <T v="bodyStrong" align="right">
              {t('lend.statsValue', { n: item.lenderStats.completedLoans })}
            </T>
            {item.lenderStats.onTimeReturnRate !== null ? (
              <T v="small" color={c.inkSoft} align="right">
                {t('lend.onTime', {
                  pct: num(Math.round(item.lenderStats.onTimeReturnRate * 100)),
                })}
              </T>
            ) : null}
          </Fact>
        </Card>
      </Section>

      <Stack>
        <Card>
          {item.viewerIsOwner ? (
            <OwnerControls item={item} />
          ) : !item.active ? (
            <T color={c.inkSoft}>{t('lend.inactive')}</T>
          ) : session.status !== 'signedIn' ? (
            <Button
              block
              label={t('lend.signIn')}
              onPress={() =>
                nav.navigate('SignIn', { from: { name: 'LendItem', params: { id: item.id } } })
              }
            />
          ) : (
            <>
              <AskForm item={item} />
              <MessageButton
                contextType="LEND_ITEM"
                contextId={item.id}
                label={t('chat.messageLender')}
              />
            </>
          )}
        </Card>
        {!item.viewerIsOwner ? <ReportButton targetType="LEND_ITEM" targetId={item.id} /> : null}
      </Stack>
    </>
  );
}

function AskForm({ item }: { item: LendItemDetail }) {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const intent = useIntent();
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const ask = useMutation({
    mutationFn: (input: { startAt: string; returnBy: string; message?: string }) =>
      lendingApi.request({ itemId: item.id, ...input }, intent.key),
    onSuccess: (loan) => {
      intent.renew();
      qc.setQueryData(['loans', loan.id], loan);
      void qc.invalidateQueries({ queryKey: ['me'] });
      nav.navigate('Loan', { id: loan.id });
    },
  });

  const submit = () => {
    if (!from || !until) return setError(t('common.badDate'));
    if (new Date(until) <= new Date(from)) return setError(t('common.badRange'));
    if (findContactInfo(message)) return setError(t('needForm.contact'));
    setError(undefined);
    ask.mutate({
      startAt: new Date(from).toISOString(),
      returnBy: new Date(until).toISOString(),
      ...(message.trim() ? { message: message.trim() } : {}),
    });
  };
  const notEligible = ruleOf(ask.error) === 'BORROWER_NOT_ELIGIBLE';

  return (
    <Stack>
      <DateField mode="datetime" label={t('lend.from')} value={from} onChange={setFrom} />
      <DateField mode="datetime" label={t('lend.returnBy')} value={until} onChange={setUntil} />
      <TextAreaField
        label={t('lend.message')}
        optional
        value={message}
        onChange={setMessage}
        maxLength={500}
      />
      <Button block busy={ask.isPending} label={t('lend.send')} onPress={submit} />
      {error || ask.isError ? (
        <Alert
          message={error ?? (notEligible ? t('lend.notEligible') : errorMessage(ask.error, t))}
        />
      ) : null}
    </Stack>
  );
}

function OwnerControls({ item }: { item: LendItemDetail }) {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const intent = useIntent();
  const [confirm, setConfirm] = useState(false);
  const done = () => {
    intent.renew();
    setConfirm(false);
    void qc.invalidateQueries({ queryKey: ['lend-items', item.id] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const stop = useMutation({
    mutationFn: () => lendingApi.deactivate(item.id, intent.key),
    onSuccess: done,
    // The sheet would hide the message.
    onError: () => setConfirm(false),
  });
  const restart = useMutation({
    mutationFn: () => lendingApi.update(item.id, { active: true }),
    onSuccess: done,
  });
  return (
    <Stack>
      <T v="label" color={c.inkSoft}>
        {t('lend.yours')}
      </T>
      <Row>
        <Button
          kind="outline"
          small
          label={t('common.edit')}
          onPress={() => nav.navigate('LendForm', { id: item.id })}
        />
        {item.active ? (
          <Button
            kind="danger"
            small
            label={t('lend.deactivate')}
            onPress={() => setConfirm(true)}
          />
        ) : (
          <Button
            small
            busy={restart.isPending}
            label={t('lend.reactivate')}
            onPress={() => restart.mutate()}
          />
        )}
      </Row>
      <Confirm
        visible={confirm}
        danger
        title={t('lend.deactivate')}
        body={t('lend.deactivateConfirm')}
        confirmLabel={t('lend.deactivateYes')}
        busy={stop.isPending}
        onConfirm={() => stop.mutate()}
        onClose={() => setConfirm(false)}
      />
      {stop.isError || restart.isError ? (
        <Alert message={errorMessage(stop.error ?? restart.error, t)} />
      ) : null}
    </Stack>
  );
}
