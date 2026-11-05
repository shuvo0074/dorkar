import { auctionsApi, type AuctionKind } from '@web/features/auctions/api';
import { c } from '../design/tokens';
import { AuctionEntry } from '../features/auctions/AuctionEntry';
import { useSession } from '../features/auth/session';
import { PagedList } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Fields';
import { Section, Stack } from '../ui/Layout';
import { usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function AuctionsScreen() {
  const { t, num } = useI18n();
  const nav = useNav();
  const { status } = useSession();
  const kindParam = useParams<'Auctions'>()?.kind;
  const kind: AuctionKind | '' =
    kindParam === 'FORWARD' || kindParam === 'REVERSE' ? kindParam : '';
  const list = usePaged(['auctions', kind], (cursor) =>
    auctionsApi.list({ kind: kind || undefined, status: 'OPEN' }, cursor),
  );

  return (
    <PagedList
      query={list}
      columns={2}
      empty={t('auctions.empty')}
      renderRow={(a) => <AuctionEntry a={a} />}
      header={
        <>
          <Stack>
            <T color={c.inkSoft}>{t('auctions.lede')}</T>
            {status === 'signedIn' ? (
              <Button
                kind="outline"
                small
                label={t('auctions.yours')}
                onPress={() => nav.navigate('MyAuctions')}
              />
            ) : null}
          </Stack>
          <Section
            title={t('auctions.title')}
            right={
              list.data ? (
                <T v="small" color={c.inkSoft}>
                  {t('feed.count', { n: num(list.rows.length) })}
                </T>
              ) : null
            }
          >
            <Chips
              label={t('auctions.kind')}
              value={kind}
              onChange={(k) => nav.navigate('Auctions', k ? { kind: k } : {})}
              options={[
                { value: '', label: t('auctions.kind.all') },
                { value: 'FORWARD', label: t('auctions.kind.FORWARD') },
                { value: 'REVERSE', label: t('auctions.kind.REVERSE') },
              ]}
            />
          </Section>
        </>
      }
    />
  );
}
