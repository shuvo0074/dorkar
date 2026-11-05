import { needsApi } from '@web/features/needs/api';
import { StyleSheet, View } from 'react-native';
import { c } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { LinkText } from '../../ui/Button';
import { Card, Row, Section } from '../../ui/Layout';
import { MoreButton, Skeleton, usePaged } from '../../ui/Misc';
import { T } from '../../ui/Text';
import { UserLink } from '../trust/UserLink';
import { Rows } from './parts';

/** For the need's owner: who Dorkar told about it, and how well each matched. */
export function Matches({ needId }: { needId: string }) {
  const { t, num } = useI18n();
  const nav = useNav();
  const list = usePaged(['needs', needId, 'matches'], (cursor) => needsApi.matches(needId, cursor));
  if (list.isError) return null;
  return (
    <Section title={t('matches.title')}>
      <T v="small" color={c.inkSoft}>
        {t('matches.note')}
      </T>
      {list.isPending ? <Skeleton rows={2} /> : null}
      {list.data && list.rows.length === 0 ? <T color={c.inkSoft}>{t('matches.empty')}</T> : null}
      {list.rows.length > 0 ? (
        <Card>
          <Rows>
            {list.rows
              .filter((m) => m.status !== 'DISMISSED')
              .map((m) => (
                <View key={m.matchId} style={styles.row}>
                  <Row style={styles.who}>
                    <UserLink userId={m.sellerId} />
                    {m.listingId ? (
                      <LinkText
                        label={t('matches.listing')}
                        onPress={() => nav.navigate('Listing', { id: m.listingId! })}
                      />
                    ) : null}
                    {m.status === 'RESPONDED' ? (
                      <T v="small" color={c.inkSoft}>
                        {t('matches.responded')}
                      </T>
                    ) : null}
                  </Row>
                  <T v="code" color={c.inkSoft}>
                    {t('matches.score', { n: num(Math.round(m.score)) })}
                  </T>
                </View>
              ))}
          </Rows>
        </Card>
      ) : null}
      <MoreButton query={list} />
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  who: { flex: 1 },
});
