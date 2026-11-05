import type { NeedMode } from '@dorkar/contracts';
import { useFormat } from '@web/lib/format';
import type { Money } from '@web/lib/money';
import { needCode } from '@web/features/needs/modes';
import { Pressable, StyleSheet, View } from 'react-native';
import { c, modeTint, r } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { T } from '../../ui/Text';
import { modeIcon } from './modeIcons';

export interface EntryNeed {
  id: string;
  mode: NeedMode;
  title: string;
  budget: { max: Money | null };
  location?: { district: string; area?: string | null };
  district?: string;
}

/** One need as a row: mode tile, code, headline, place and budget. */
export function NeedEntry({ need }: { need: EntryNeed }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const Icon = modeIcon[need.mode];
  const district = need.location?.district ?? need.district;
  const meta = [
    district && f.district(district),
    need.budget.max ? t('entry.budget', { amount: f.taka(need.budget.max) }) : t('entry.open'),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="link"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={() => nav.navigate('Need', { id: need.id })}
    >
      <View style={[styles.tile, { backgroundColor: modeTint[need.mode] }]}>
        <Icon size={24} color={c.ink} />
      </View>
      <View style={styles.text}>
        <T v="code" color={c.inkSoft}>
          {needCode(need)}
        </T>
        <T v="bodyStrong" numberOfLines={2}>
          {need.title}
        </T>
        <T v="small" color={c.inkSoft}>
          {meta}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingVertical: 10, alignItems: 'center' },
  pressed: { opacity: 0.6 },
  tile: {
    width: 48,
    height: 48,
    borderRadius: r.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 1 },
});
