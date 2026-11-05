import { dealCode } from '@web/features/deals/api';
import { disputesApi, type DisputeDetail, type Entry } from '@web/features/disputes/api';
import { shortCode, useFormat } from '@web/lib/format';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { NotFound } from '../features/account/NotFound';
import { useSession } from '../features/auth/session';
import { c, r } from '../design/tokens';
import { errorMessage } from '../lib/errors';
import { ApiError } from '../lib/http';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import { TextAreaField } from '../ui/Fields';
import {
  Alert,
  Card,
  Divider,
  LoadError,
  PageTitle,
  Row,
  Screen,
  Section,
  Stack,
} from '../ui/Layout';
import { Badge, Fact, MediaImage, Skeleton } from '../ui/Misc';
import { PhotoPicker } from '../ui/PhotoPicker';
import { T } from '../ui/Text';

export default function DisputeScreen() {
  const { id } = useParams<'Dispute'>()!;
  return (
    <SignedInOnly>
      <Loader id={id} />
    </SignedInOnly>
  );
}

function Loader({ id }: { id: string }) {
  const d = useQuery({ queryKey: ['disputes', id], queryFn: () => disputesApi.get(id) });
  if (d.isPending)
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  if (d.error instanceof ApiError && d.error.status === 404) return <NotFound />;
  if (d.isError)
    return (
      <Screen>
        <LoadError onRetry={() => void d.refetch()} />
      </Screen>
    );
  return <DisputePage d={d.data} refreshing={d.isRefetching} onRefresh={() => void d.refetch()} />;
}

function DisputePage({
  d,
  refreshing,
  onRefresh,
}: {
  d: DisputeDetail;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, date } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const staff = d.viewerRole === 'STAFF';
  const live = d.status !== 'RESOLVED' && d.status !== 'WITHDRAWN';

  useLayoutEffect(
    () => nav.setOptions({ title: t('dispute.code', { code: shortCode('D', d.id) }) }),
    [nav, t, d.id],
  );

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <Stack>
        <Badge tone={live ? 'good' : 'quiet'} label={f.state(d.status)} />
        <PageTitle>{t(`reason.${d.reason}`)}</PageTitle>
        <LinkText
          label={t('dispute.onDeal', { code: dealCode(d.transactionId) })}
          onPress={() => nav.navigate('Deal', { id: d.transactionId })}
        />
      </Stack>

      <Section title={t('need.details')}>
        {d.description ? <T>{d.description}</T> : null}
        <Card>
          <Fact label={t('dispute.openedBy')}>
            {staff
              ? t(`dispute.by.${d.openedBy}`)
              : d.openedBy === d.viewerRole
              ? t('dispute.openedBy.you')
              : t('dispute.openedBy.them')}
          </Fact>
          {d.amount ? <Fact label={t('dispute.amount')}>{f.taka(d.amount.amount)}</Fact> : null}
          {live ? <Fact label={t('dispute.respondBy')}>{date(d.respondBy)}</Fact> : null}
          {d.resolution ? (
            <Fact label={t('dispute.resolution')}>
              <T v="bodyStrong" align="right">
                {t(`dispute.res.${d.resolution}`)}
              </T>
              {d.resolutionNote ? (
                <T v="small" color={c.inkSoft} align="right">
                  “{d.resolutionNote}”
                </T>
              ) : null}
            </Fact>
          ) : null}
        </Card>
        {d.respondentMissedDeadline && live ? <T color={c.inkSoft}>{t('dispute.missed')}</T> : null}
      </Section>

      <PartyActions d={d} />
      <Timeline d={d} />
    </Screen>
  );
}

function Timeline({ d }: { d: DisputeDetail }) {
  const { t, date, has } = useI18n();
  const f = useFormat();
  const me = useSession().account?.id;
  return (
    <Section title={t('dispute.timeline')}>
      {[...d.timeline].reverse().map((e: Entry, i) => {
        const who =
          e.authorId && e.authorId === me ? t('dispute.by.you') : t(`dispute.by.${e.authorRole}`);
        const key = `dispute.kind.${e.kind}`;
        const kind = has(key) ? t(key) : e.kind;
        return (
          <Stack key={e.id} gap={6}>
            {i > 0 ? <Divider /> : null}
            <T v="code" color={c.inkSoft}>
              {date(e.createdAt)}
            </T>
            <T>
              <T v="bodyStrong">{who}</T> · {kind}
              {e.toStatus ? ` · ${f.state(e.toStatus)}` : ''}
            </T>
            {e.visibility === 'STAFF' ? <Badge label={t('dispute.staffOnly')} /> : null}
            {e.targetParty ? (
              <T v="small" color={c.inkSoft}>
                {t('dispute.toParty', {
                  party:
                    e.targetParty === 'BOTH'
                      ? t('dispute.party.BOTH')
                      : t(`dispute.by.${e.targetParty}`),
                })}
              </T>
            ) : null}
            {e.text ? <T>{e.text}</T> : null}
            {e.mediaIds.length > 0 ? (
              <View style={styles.media}>
                {e.mediaIds.map((m) => (
                  <MediaImage key={m} id={m} style={styles.photo} />
                ))}
              </View>
            ) : null}
          </Stack>
        );
      })}
    </Section>
  );
}

function PartyActions({ d }: { d: DisputeDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const intent = useIntent();
  const [statement, setStatement] = useState('');
  const [evidence, setEvidence] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const done = (next: DisputeDetail) => {
    intent.renew();
    setStatement('');
    setEvidence('');
    setPhotos([]);
    setConfirm(false);
    qc.setQueryData(['disputes', d.id], next);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const run = useMutation({
    mutationFn: (
      a:
        | { kind: 'statement'; text: string }
        | { kind: 'evidence'; text: string; mediaIds: string[] }
        | { kind: 'withdraw' },
    ) =>
      a.kind === 'statement'
        ? disputesApi.statement(d.id, a.text, intent.key)
        : a.kind === 'evidence'
        ? disputesApi.evidence(
            d.id,
            {
              ...(a.text ? { text: a.text } : {}),
              ...(a.mediaIds.length ? { mediaIds: a.mediaIds } : {}),
            },
            intent.key,
          )
        : disputesApi.withdraw(d.id, intent.key),
    onSuccess: done,
  });

  if (d.viewerRole === 'STAFF') return null;
  if (d.actions.length === 0) return <T color={c.inkSoft}>{t('deal.noActions')}</T>;

  const sendStatement = () => {
    if (statement.trim().length < 10) return setError(t('common.required'));
    setError(undefined);
    run.mutate({ kind: 'statement', text: statement.trim() });
  };
  const sendEvidence = () => {
    if (!evidence.trim() && photos.length === 0) return setError(t('dispute.evidenceEmpty'));
    setError(undefined);
    run.mutate({ kind: 'evidence', text: evidence.trim(), mediaIds: photos });
  };

  return (
    <Stack>
      {d.actions.includes('statement') ? (
        <Card>
          <TextAreaField
            label={t('dispute.statement')}
            hint={t('dispute.statementHint')}
            value={statement}
            onChange={setStatement}
            maxLength={4000}
          />
          <Button
            block
            disabled={run.isPending}
            label={t('dispute.statementSend')}
            onPress={sendStatement}
          />
        </Card>
      ) : null}
      {d.actions.includes('evidence') ? (
        <Card>
          <T v="section" accessibilityRole="header">
            {t('dispute.evidence')}
          </T>
          <TextAreaField
            label={t('dispute.evidenceText')}
            optional
            value={evidence}
            onChange={setEvidence}
            maxLength={2000}
          />
          <PhotoPicker purpose="DISPUTE" value={photos} onChange={setPhotos} max={10} />
          <Button
            block
            kind="outline"
            disabled={run.isPending}
            label={t('dispute.evidenceSend')}
            onPress={sendEvidence}
          />
        </Card>
      ) : null}
      {d.actions.includes('withdraw') ? (
        confirm ? (
          <Stack>
            <T>{t('dispute.withdrawConfirm')}</T>
            <Row>
              <Button
                kind="danger"
                small
                busy={run.isPending}
                label={t('dispute.withdrawYes')}
                onPress={() => run.mutate({ kind: 'withdraw' })}
              />
              <Button
                kind="outline"
                small
                label={t('common.keep')}
                onPress={() => setConfirm(false)}
              />
            </Row>
          </Stack>
        ) : (
          <Button
            kind="danger"
            small
            label={t('dispute.withdraw')}
            onPress={() => setConfirm(true)}
          />
        )
      ) : null}
      {error || run.isError ? <Alert message={error ?? errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  media: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { width: 96, height: 96, borderRadius: r.control, backgroundColor: c.paperShade },
});
