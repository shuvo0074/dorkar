import { dealCode } from '@web/features/deals/api';
import { lendingApi, loanCode, type LoanAction, type LoanDetail } from '@web/features/lending/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import {
  NotFound,
  PageError,
  PageSkeleton,
  TimelineRow,
  useRefresh,
} from '../features/catalog/pageParts';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav, useParams } from '../nav/routes';
import { Button, LinkText } from '../ui/Button';
import { TextAreaField } from '../ui/Fields';
import { Alert, Card, Divider, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact } from '../ui/Misc';
import { T } from '../ui/Text';

export default function LoanScreen() {
  const { id } = useParams<'Loan'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const loan = useQuery({ queryKey: ['loans', id], queryFn: () => lendingApi.loan(id) });
  const pull = useRefresh(() => loan.refetch());
  if (loan.isPending) return <PageSkeleton />;
  if (loan.error instanceof ApiError && loan.error.status === 404) return <NotFound />;
  if (loan.isError) return <PageError onRetry={() => void loan.refetch()} />;
  return (
    <Screen {...pull}>
      <LoanPage loan={loan.data} />
    </Screen>
  );
}

function LoanPage({ loan }: { loan: LoanDetail }) {
  const { t, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const me = useSession().account?.id;
  return (
    <>
      <Stack>
        <Row>
          <T v="code" color={c.inkSoft}>
            {t('loan.code', { code: loanCode(loan.id) })}
          </T>
          <Badge label={f.state(loan.status)} />
          {loan.overdue ? <Badge tone="warn" label={t('loan.overdue')} /> : null}
          {loan.viewerRole ? (
            <T v="small" color={c.inkSoft}>
              {t(`loan.as.${loan.viewerRole}`)}
            </T>
          ) : null}
        </Row>
        <PageTitle>{loan.itemTitle}</PageTitle>
        <T color={c.inkSoft}>
          {t('dash.period', { from: date(loan.startAt), to: date(loan.returnBy) })}
        </T>
        {loan.status === 'APPROVED' ? <Alert tone="info" message={t('loan.handover')} /> : null}
      </Stack>

      <Section title={t('need.details')}>
        <Card>
          <Fact label={t('loan.item')}>
            <LinkText
              label={loan.itemTitle}
              onPress={() => nav.navigate('LendItem', { id: loan.itemId })}
            />
          </Fact>
          {loan.viewerRole ? (
            <Fact label={t('deal.otherSide')}>
              <UserLink userId={loan.viewerRole === 'LENDER' ? loan.borrowerId : loan.lenderId} />
            </Fact>
          ) : null}
          <Fact label={t('loan.period')}>
            {t('dash.period', { from: date(loan.startAt), to: date(loan.returnBy) })}
          </Fact>
          <Fact label={t('lend.deposit')}>
            {loan.deposit ? f.taka(loan.deposit) : t('lend.noDeposit')}
          </Fact>
          {loan.message ? <Fact label={t('loan.message')}>{loan.message}</Fact> : null}
          {loan.declineReason ? <Fact label={t('loan.declined')}>{loan.declineReason}</Fact> : null}
          {loan.returnedAt ? <Fact label={t('loan.returned')}>{date(loan.returnedAt)}</Fact> : null}
          {loan.transactionId ? (
            <Fact label={t('loan.deal')}>
              <LinkText
                label={dealCode(loan.transactionId)}
                onPress={() => nav.navigate('Deal', { id: loan.transactionId! })}
              />
            </Fact>
          ) : null}
        </Card>
      </Section>

      <Card>
        <Actions loan={loan} />
      </Card>

      <Section title={t('loan.timeline')}>
        <Stack gap={0}>
          {[...loan.transitions].reverse().map((tr, i) => (
            <Stack key={i} gap={0}>
              {i > 0 ? <Divider /> : null}
              <TimelineRow
                at={date(tr.at)}
                line={tr.from ? `${f.state(tr.from)} → ${f.state(tr.to)}` : f.state(tr.to)}
                sub={`${
                  tr.actorId === me
                    ? t('deal.byYou')
                    : tr.actorRole === 'SYSTEM'
                    ? t('deal.by.SYSTEM')
                    : t(`dash.role.${tr.actorRole}`)
                }${tr.reason ? ` · “${tr.reason}”` : ''}`}
              />
            </Stack>
          ))}
        </Stack>
      </Section>
    </>
  );
}

function Actions({ loan }: { loan: LoanDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [asking, setAsking] = useState<'decline' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const run = useMutation({
    mutationFn: ({ action, reason: r }: { action: LoanAction; reason?: string }) =>
      lendingApi.act(loan.id, action, r ? { reason: r } : {}, intent.key),
    onSuccess: (next) => {
      intent.renew();
      setAsking(null);
      qc.setQueryData(['loans', loan.id], next);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (loan.actions.length === 0) return <T color={c.inkSoft}>{t('deal.noActions')}</T>;
  const submit = () => {
    if (!asking) return;
    const r = reason.trim();
    if ((asking === 'decline' || r) && r.length < 3) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ action: asking, ...(r ? { reason: r } : {}) });
  };
  return (
    <Stack>
      {asking === null ? (
        <>
          {loan.actions.includes('approve') ? (
            <Button
              block
              disabled={run.isPending}
              label={t('loan.cmd.approve')}
              onPress={() => run.mutate({ action: 'approve' })}
            />
          ) : null}
          {loan.actions.includes('decline') ? (
            <Button
              kind="danger"
              small
              label={t('loan.cmd.decline')}
              onPress={() => setAsking('decline')}
            />
          ) : null}
          {loan.actions.includes('cancel') ? (
            <Button
              kind="danger"
              small
              label={t('loan.cmd.cancel')}
              onPress={() => setAsking('cancel')}
            />
          ) : null}
        </>
      ) : (
        <>
          <TextAreaField
            label={t('booking.reason')}
            optional={asking === 'cancel'}
            value={reason}
            onChange={setReason}
            maxLength={500}
            error={error}
          />
          <Row>
            <Button
              kind="danger"
              small
              busy={run.isPending}
              label={t(asking === 'decline' ? 'loan.cmd.decline' : 'loan.cmd.cancel')}
              onPress={submit}
            />
            <Button kind="outline" small label={t('common.keep')} onPress={() => setAsking(null)} />
          </Row>
        </>
      )}
      {run.isError ? <Alert message={errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}
