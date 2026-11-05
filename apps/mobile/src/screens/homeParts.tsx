import { useQuery } from '@tanstack/react-query';
import { needsApi } from '@web/features/needs/api';
import { StyleSheet, View } from 'react-native';
import { c } from '../design/tokens';
import { NeedEntry } from '../features/needs/NeedEntry';
import { useI18n } from '../lib/i18n';
import { useNav } from '../nav/routes';
import { LinkText } from '../ui/Button';
import { Divider, Section } from '../ui/Layout';
import { T } from '../ui/Text';

/** Latest open needs on home; the same query the web's home page runs. */
export function useLatestNeeds() {
  return useQuery({
    queryKey: ['needs', 'feed', 'latest'],
    queryFn: () => needsApi.feed({}),
    select: (p) => p.data.slice(0, 15),
  });
}

export function LatestNeeds() {
  const { t } = useI18n();
  const nav = useNav();
  const latest = useLatestNeeds();
  if (!latest.data?.length) return null;
  return (
    <Section
      title={t('feed.latest')}
      right={<LinkText label={t('feed.seeAll')} onPress={() => nav.navigate('Needs')} />}
    >
      <View>
        {latest.data.map((n, i) => (
          <View key={n.id}>
            {i > 0 ? <Divider /> : null}
            <NeedEntry need={n} />
          </View>
        ))}
      </View>
    </Section>
  );
}

export function HowItWorks() {
  const { t, num } = useI18n();
  return (
    <Section title={t('how.title')}>
      <View style={styles.steps}>
        {([1, 2, 3] as const).map((n) => (
          <View key={n} style={styles.step}>
            <T v="section" color={c.accent}>
              {num(n)}
            </T>
            <View style={styles.stepText}>
              <T v="bodyStrong">{t(`how.${n}.title`)}</T>
              <T v="small" color={c.inkSoft}>
                {t(`how.${n}.body`)}
              </T>
            </View>
          </View>
        ))}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  steps: { gap: 12 },
  step: { flexDirection: 'row', gap: 12 },
  stepText: { flex: 1 },
});
