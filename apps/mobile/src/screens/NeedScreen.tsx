import { useCategories } from '@web/features/catalog/categories';
import {
  needCommands,
  needEditable,
  needsApi,
  type Need,
  type NeedCommand,
} from '@web/features/needs/api';
import { needCode } from '@web/features/needs/modes';
import { useFormat } from '@web/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { AttributeList } from '../features/catalog/AttributeList';
import { Matches } from '../features/needs/Matches';
import { NeedTermsList } from '../features/needs/NeedTerms';
import { FactAside, FactValue, ModeTile, NotFound, TimelineItem } from '../features/needs/parts';
import { OfferCompare } from '../features/offers/OfferCompare';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button, LinkText } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { Alert, Card, LoadError, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact, Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

export default function NeedScreen() {
  const { id } = useParams<'Need'>()!;
  const qc = useQueryClient();
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) {
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  }
  if (need.error instanceof ApiError && need.error.status === 404) return <NotFound />;
  if (need.isError) {
    return (
      <Screen>
        <LoadError onRetry={() => void need.refetch()} />
      </Screen>
    );
  }
  return (
    <NeedPage
      need={need.data}
      refreshing={need.isRefetching}
      onRefresh={() => {
        void need.refetch();
        void qc.invalidateQueries({ queryKey: ['offers', 'need', id] });
        void qc.invalidateQueries({ queryKey: ['needs', id, 'matches'] });
      }}
    />
  );
}

function NeedPage({
  need,
  refreshing,
  onRefresh,
}: {
  need: Need;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, date, num } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const session = useSession();
  const categories = useCategories();
  const notice = useParams<'Need'>()?.notice;
  const mine = session.account?.id === need.requesterId;
  const budget = f.range(need.budget.min, need.budget.max);

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Stack>
        <LinkText label={t('nav.needs')} onPress={() => nav.navigate('Needs')} />
        <Row>
          <ModeTile mode={need.mode} size={36} />
          <T v="code" color={c.inkSoft}>
            {t('need.code', { code: needCode(need) })}
          </T>
          <Badge label={f.state(need.status)} />
        </Row>
        <PageTitle>{need.title}</PageTitle>
        <T color={c.inkSoft}>
          {[
            f.place(need.location),
            budget ?? t('need.budget.none'),
            need.publishedAt
              ? t('need.posted', { when: f.relative(need.publishedAt) })
              : t('need.draft'),
          ].join(' · ')}
        </T>
        {notice ? (
          <Alert
            tone="info"
            message={t(notice === 'posted' ? 'need.notice.posted' : 'need.notice.draft')}
          />
        ) : null}
        {mine && need.status === 'HIDDEN' ? <Alert message={t('need.hidden')} /> : null}
      </Stack>

      <Section title={t('need.about')}>
        {need.description ? <T>{need.description}</T> : null}
        <Card>
          {!mine ? (
            <Fact label={t('need.postedBy')}>
              <UserLink userId={need.requesterId} />
            </Fact>
          ) : null}
          <Fact label={t('need.mode')}>{t(`mode.${need.mode}`)}</Fact>
          <Fact label={t('need.category')}>{categories.name(need.categoryId) || '—'}</Fact>
          <Fact label={t('need.quantity')}>{num(need.quantity)}</Fact>
          <Fact label={t('need.budget')}>
            <FactValue>{budget ?? t('need.budget.none')}</FactValue>
            {need.budget.flexible ? <FactAside>{t('money.flexible')}</FactAside> : null}
          </Fact>
          <Fact label={t('need.place')}>{f.place(need.location)}</Fact>
          {need.mode !== 'HIRE' ? (
            <Fact label={t('need.delivery')}>{f.delivery(need.deliveryPreference)}</Fact>
          ) : null}
          {need.mode !== 'HIRE' ? (
            <Fact label={t('need.conditions')}>
              {need.condition.length
                ? need.condition.map((x) => f.condition(x)).join(', ')
                : t('need.conditions.any')}
            </Fact>
          ) : null}
          {need.requiredBy ? (
            <Fact label={t('needForm.requiredBy')}>{date(need.requiredBy, 'short')}</Fact>
          ) : null}
          <NeedTermsList terms={need.modeTerms} />
          <AttributeList categoryId={need.categoryId} values={need.attributes} />
        </Card>
      </Section>

      <Card>
        <T v="bodyStrong">
          {need.offerCount === 0
            ? t('need.offers.none')
            : need.offerCount === 1
            ? t('need.offers.one')
            : t('need.offers', { n: need.offerCount })}
        </T>
        {need.expiresAt && need.status === 'OPEN' ? (
          <T color={c.inkSoft}>{t('need.expires', { when: date(need.expiresAt, 'short') })}</T>
        ) : null}
        {mine ? (
          <OwnerControls need={need} />
        ) : session.status === 'signedIn' ? (
          need.status === 'OPEN' ? (
            <Button
              block
              label={t('need.makeOffer')}
              onPress={() => nav.navigate('OfferForm', { needId: need.id })}
            />
          ) : (
            <T color={c.inkSoft}>{t('need.notOpen')}</T>
          )
        ) : (
          <Button
            block
            label={t('need.signInToOffer')}
            onPress={() =>
              nav.navigate('SignIn', { from: { name: 'Need', params: { id: need.id } } })
            }
          />
        )}
      </Card>
      {!mine ? <ReportButton targetType="NEED" targetId={need.id} /> : null}

      {mine && need.status !== 'DRAFT' ? <OfferCompare need={need} /> : null}
      {mine && need.status !== 'DRAFT' ? <Matches needId={need.id} /> : null}
      {mine && need.history && need.history.length > 0 ? <History need={need} /> : null}
    </Screen>
  );
}

function OwnerControls({ need }: { need: Need }) {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (x: NeedCommand) => needsApi.command(need.id, x),
    onSuccess: (saved) => {
      setConfirm(false);
      qc.setQueryData(['needs', need.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: () => setConfirm(false),
  });
  const commands = needCommands[need.status];

  return (
    <Stack>
      <T v="label" color={c.inkSoft}>
        {t('need.yours')}
      </T>
      {need.visibility === 'MATCHED_ONLY' ? <T color={c.inkSoft}>{t('need.matchedOnly')}</T> : null}
      <Row>
        {needEditable(need.status) ? (
          <Button
            kind="outline"
            small
            label={t('common.edit')}
            onPress={() => nav.navigate('NeedForm', { id: need.id })}
          />
        ) : null}
        {need.status === 'OPEN' && (need.mode === 'SOURCE' || need.mode === 'BUY') ? (
          <Button
            kind="outline"
            small
            label={t('need.reverseAuction')}
            onPress={() => nav.navigate('AuctionForm', { needId: need.id })}
          />
        ) : null}
        {commands
          .filter((x) => x !== 'close')
          .map((x) => (
            <Button
              key={x}
              small
              kind={x === 'publish' || x === 'renew' ? 'primary' : 'outline'}
              disabled={run.isPending}
              label={t(`need.cmd.${x}`)}
              onPress={() => run.mutate(x)}
            />
          ))}
        {commands.includes('close') ? (
          <Button
            kind="danger"
            small
            label={t('need.cmd.close')}
            onPress={() => setConfirm(true)}
          />
        ) : null}
      </Row>
      <Confirm
        visible={confirm}
        danger
        title={t('need.cmd.close')}
        body={t('need.confirm.close')}
        confirmLabel={t('need.confirm.yes')}
        cancelLabel={t('common.keep')}
        busy={run.isPending}
        onConfirm={() => run.mutate('close')}
        onClose={() => setConfirm(false)}
      />
      {run.isError ? <Alert message={errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}

function History({ need }: { need: Need }) {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <Section title={t('need.history')}>
      <Card>
        {[...(need.history ?? [])].reverse().map((h, i) => (
          <TimelineItem
            key={i}
            at={h.at}
            text={
              h.from
                ? t('need.history.entry', { from: f.state(h.from), to: f.state(h.to) })
                : f.state(h.to)
            }
            note={h.reason === 'MODERATION' ? t('need.history.MODERATION') : null}
          />
        ))}
      </Card>
    </Section>
  );
}
