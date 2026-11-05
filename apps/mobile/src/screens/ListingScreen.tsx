import {
  catalogApi,
  listingCommands,
  listingEditable,
  type Listing,
  type ListingCommand,
} from '@web/features/catalog/api';
import { useCategories } from '@web/features/catalog/categories';
import { dealsApi } from '@web/features/deals/api';
import { useFormat } from '@web/lib/format';
import { ApiError } from '@web/lib/http';
import { asciiDigits } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { useSession } from '../features/auth/session';
import { AttributeList } from '../features/catalog/AttributeList';
import { kindIcon, listingCode, usePrice } from '../features/catalog/ListingEntry';
import {
  Gallery,
  NotFound,
  PageError,
  PageSkeleton,
  useRefresh,
} from '../features/catalog/pageParts';
import { MessageButton } from '../features/messages/MessageButton';
import { RentPanel } from '../features/rentals/RentPanel';
import { ReportButton } from '../features/trust/ReportButton';
import { UserLink } from '../features/trust/UserLink';
import { errorMessage, ruleOf } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { TextField } from '../ui/Fields';
import { Alert, Card, PageTitle, Row, Screen, Section, Stack } from '../ui/Layout';
import { Badge, Fact } from '../ui/Misc';
import { T } from '../ui/Text';

export default function ListingScreen() {
  const { id, notice } = useParams<'Listing'>()!;
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  const pull = useRefresh(() => listing.refetch());
  if (listing.isPending) return <PageSkeleton />;
  if (listing.error instanceof ApiError && listing.error.status === 404) return <NotFound />;
  if (listing.isError) return <PageError onRetry={() => void listing.refetch()} />;
  return (
    <Screen {...pull}>
      <ListingPage listing={listing.data} notice={notice} />
    </Screen>
  );
}

function ListingPage({
  listing,
  notice,
}: {
  listing: Listing;
  notice: 'created' | 'saved' | undefined;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const price = usePrice();
  const session = useSession();
  const categories = useCategories();
  const nav = useNav();
  const mine = session.account?.id === listing.sellerId;
  const Kind = kindIcon[listing.kind];

  return (
    <>
      <Stack>
        <Row>
          <T v="code" color={c.inkSoft}>
            {t('listing.code', { code: listingCode(listing.id) })}
          </T>
          <Badge label={t(`kind.${listing.kind}`)} />
          {listing.status !== 'PUBLISHED' ? <Badge label={f.state(listing.status)} /> : null}
        </Row>
        <PageTitle>{listing.title}</PageTitle>
        <T color={c.inkSoft}>
          {[price(listing), f.place({ district: listing.district, area: listing.area })].join(
            ' · ',
          )}
        </T>
        {notice ? (
          <Alert
            tone="info"
            message={t(notice === 'created' ? 'listing.notice.created' : 'listing.notice.saved')}
          />
        ) : null}
        {mine && listing.status === 'HIDDEN' ? <Alert message={t('listing.hidden')} /> : null}
      </Stack>

      <Gallery
        ids={listing.mediaIds}
        label={t('listing.photos')}
        fallback={<Kind size={48} color={c.inkSoft} />}
      />

      <Section title={t('listing.about')}>
        {listing.description ? <T>{listing.description}</T> : null}
        <Card>
          {!mine ? (
            <Fact label={t('listing.seller')}>
              <UserLink userId={listing.sellerId} />
            </Fact>
          ) : null}
          <Fact label={t('listing.price')}>{price(listing)}</Fact>
          <Fact label={t('listing.available')}>
            {t('listing.availableN', { n: listing.quantityAvailable })}
          </Fact>
          <Fact label={t('listing.category')}>{categories.name(listing.categoryId) || '—'}</Fact>
          {listing.condition ? (
            <Fact label={t('listing.condition')}>{f.condition(listing.condition)}</Fact>
          ) : null}
          <Fact label={t('listing.place')}>
            {f.place({ district: listing.district, area: listing.area })}
          </Fact>
          {listing.deliveryModes.length > 0 ? (
            <Fact label={t('listing.delivery')}>
              {listing.deliveryModes.map((d) => f.delivery(d)).join(', ')}
            </Fact>
          ) : null}
          <AttributeList categoryId={listing.categoryId} values={listing.attributes} />
        </Card>
      </Section>

      <Stack>
        <Card>
          <T v="price">{price(listing)}</T>
          {mine ? (
            <OwnerControls listing={listing} />
          ) : listing.status !== 'PUBLISHED' || listing.quantityAvailable === 0 ? (
            <T color={c.inkSoft}>{t('listing.unavailable')}</T>
          ) : session.status !== 'signedIn' ? (
            <Button
              block
              label={t(listing.kind === 'RENTAL' ? 'rent.signIn' : 'listing.signInToBuy')}
              onPress={() =>
                nav.navigate('SignIn', { from: { name: 'Listing', params: { id: listing.id } } })
              }
            />
          ) : listing.kind === 'RENTAL' ? (
            <RentPanel listing={listing} />
          ) : (
            <BuyPanel listing={listing} />
          )}
          {!mine && session.status === 'signedIn' ? (
            <MessageButton
              contextType="LISTING"
              contextId={listing.id}
              label={t('chat.messageSeller')}
            />
          ) : null}
        </Card>
        {!mine ? <ReportButton targetType="LISTING" targetId={listing.id} /> : null}
      </Stack>
    </>
  );
}

function BuyPanel({ listing }: { listing: Listing }) {
  const { t, has } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const qc = useQueryClient();
  const intent = useIntent();
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string>();
  const wholeOnly = listing.priceUnit === 'TOTAL';
  const n = Number(asciiDigits(qty));
  const buy = useMutation({
    mutationFn: () => dealsApi.buy(listing.id, n, intent.key),
    onSuccess: (d) => {
      intent.renew();
      qc.setQueryData(['deals', d.id], d);
      void qc.invalidateQueries({ queryKey: ['me'] });
      nav.navigate('Deal', { id: d.id });
    },
  });

  const submit = () => {
    if (!Number.isInteger(n) || n < 1 || n > listing.quantityAvailable)
      return setError(t('common.badNumber'));
    setError(undefined);
    buy.mutate();
  };
  const ruleKey: string = `listing.rule.${ruleOf(buy.error) ?? ''}`;

  return (
    <Stack>
      {!wholeOnly && listing.quantityAvailable > 1 ? (
        <TextField
          label={t('listing.buyQty')}
          keyboard="number-pad"
          value={qty}
          onChange={setQty}
          error={error}
        />
      ) : null}
      {Number.isInteger(n) && n > 0 ? (
        <T v="code">
          {t('listing.buyTotal', {
            amount: f.taka(wholeOnly ? listing.price.amount : listing.price.amount * n),
          })}
        </T>
      ) : null}
      <Button block busy={buy.isPending} label={t('listing.buy')} onPress={submit} />
      <T v="small" color={c.inkSoft}>
        {t('listing.buyHelp')}
      </T>
      {buy.isError ? (
        <Alert message={has(ruleKey) ? t(ruleKey) : errorMessage(buy.error, t)} />
      ) : null}
    </Stack>
  );
}

function OwnerControls({ listing }: { listing: Listing }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const nav = useNav();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (x: ListingCommand) => catalogApi.listingCommand(listing.id, x),
    onSuccess: (saved) => {
      setConfirm(false);
      qc.setQueryData(['listings', listing.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    // The sheet would hide the message.
    onError: () => setConfirm(false),
  });
  const commands = listingCommands[listing.status];

  return (
    <Stack>
      <T v="label" color={c.inkSoft}>
        {t('listing.yours')}
      </T>
      <Row>
        {listingEditable(listing.status) ? (
          <Button
            kind="outline"
            small
            label={t('common.edit')}
            onPress={() => nav.navigate('ListingForm', { id: listing.id })}
          />
        ) : null}
        {listing.kind === 'RENTAL' ? (
          <Button
            kind="outline"
            small
            label={t('rterms.title')}
            onPress={() => nav.navigate('RentalSettings', { id: listing.id })}
          />
        ) : null}
        {listing.kind === 'PRODUCT' && listing.status === 'PUBLISHED' ? (
          <Button
            kind="outline"
            small
            label={t('listing.auction')}
            onPress={() => nav.navigate('AuctionForm', { listingId: listing.id })}
          />
        ) : null}
        {commands
          .filter((x) => x !== 'withdraw')
          .map((x) => (
            <Button
              key={x}
              small
              kind={x === 'publish' ? 'primary' : 'outline'}
              disabled={run.isPending}
              label={t(`listing.cmd.${x}`)}
              onPress={() => run.mutate(x)}
            />
          ))}
        {commands.includes('withdraw') ? (
          <Button
            kind="danger"
            small
            label={t('listing.cmd.withdraw')}
            onPress={() => setConfirm(true)}
          />
        ) : null}
      </Row>
      <Confirm
        visible={confirm}
        danger
        title={t('listing.cmd.withdraw')}
        body={t('listing.withdrawConfirm')}
        confirmLabel={t('listing.withdrawYes')}
        busy={run.isPending}
        onConfirm={() => run.mutate('withdraw')}
        onClose={() => setConfirm(false)}
      />
      {run.isError ? <Alert message={errorMessage(run.error, t)} /> : null}
    </Stack>
  );
}
