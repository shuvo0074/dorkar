import { NeedModes, type NeedMode } from '@dorkar/contracts';
import { categoryOptions, useCategories } from '@web/features/catalog/categories';
import { needsApi, type NeedSearch } from '@web/features/needs/api';
import { parseTaka, takaInput } from '@web/lib/money';
import { CommonActions } from '@react-navigation/native';
import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { c, space } from '../design/tokens';
import { NeedEntry } from '../features/needs/NeedEntry';
import { usePagedListProps } from '../features/needs/parts';
import { useI18n } from '../lib/i18n';
import { useNav, useParams, type RootParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips, DistrictField, FieldShell, MoneyField, SelectField, TextField } from '../ui/Fields';
import { Card, Empty, LoadError, PageTitle, Row, Screen, Stack } from '../ui/Layout';
import { Skeleton, usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

/** Filters live in the route's params, so a link can open a ready-made search. */
function readSearch(p: RootParams['Needs']): NeedSearch {
  const budget = Number(p?.budget);
  return {
    q: p?.q || undefined,
    mode: NeedModes.includes(p?.mode as NeedMode) ? (p?.mode as NeedMode) : undefined,
    categoryId: p?.categoryId || undefined,
    district: p?.district || undefined,
    budgetMaxAtLeast: Number.isInteger(budget) && budget > 0 ? budget : undefined,
  };
}

export default function NeedsScreen() {
  const { t, num } = useI18n();
  const nav = useNav();
  const params = useParams<'Needs'>();
  const search = readSearch(params);
  const feed = usePaged(['needs', 'feed', search], (cursor) => needsApi.feed(search, cursor));
  const listProps = usePagedListProps(feed);

  // setParams merges, so every filter is named: an absent one must clear.
  const apply = (s: NeedSearch) =>
    nav.dispatch(
      CommonActions.setParams({
        q: s.q,
        mode: s.mode,
        categoryId: s.categoryId,
        district: s.district,
        budget: s.budgetMaxAtLeast ? String(s.budgetMaxAtLeast) : undefined,
      }),
    );

  return (
    <Screen scroll={false}>
      <FlatList
        {...listProps}
        data={feed.rows}
        keyExtractor={(n) => n.id}
        renderItem={({ item }) => <NeedEntry need={item} />}
        ListHeaderComponent={
          <Stack gap={space.section}>
            <Stack>
              <PageTitle>{t('feed.title')}</PageTitle>
              <T color={c.inkSoft}>{t('feed.lede')}</T>
              <Button
                kind="outline"
                small
                label={t('feed.postOwn')}
                onPress={() =>
                  nav.navigate('Tabs', { screen: 'Home', params: { focusComposer: Date.now() } })
                }
              />
            </Stack>
            <Filters key={JSON.stringify(search)} search={search} onApply={apply} />
            <View style={styles.resultsHead}>
              <T v="section" accessibilityRole="header">
                {t('feed.results')}
              </T>
              {feed.data ? (
                <T v="small" color={c.inkSoft}>
                  {t('feed.count', { n: num(feed.rows.length) })}
                </T>
              ) : null}
            </View>
            {feed.isPending ? <Skeleton rows={4} /> : null}
            {feed.isError ? <LoadError onRetry={() => void feed.refetch()} /> : null}
          </Stack>
        }
        ListEmptyComponent={feed.data ? <Empty title={t('feed.empty')} /> : undefined}
      />
    </Screen>
  );
}

function Filters({ search, onApply }: { search: NeedSearch; onApply: (s: NeedSearch) => void }) {
  const { t } = useI18n();
  const categories = useCategories();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(search.q ?? '');
  const [mode, setMode] = useState<NeedMode | ''>(search.mode ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState(search.district ?? '');
  const [budget, setBudget] = useState(takaInput(search.budgetMaxAtLeast));
  const [error, setError] = useState<string>();

  const submit = () => {
    const b = budget.trim() ? parseTaka(budget) : null;
    if (budget.trim() && b === null) return setError(t('common.badAmount'));
    setError(undefined);
    onApply({
      q: q.trim() || undefined,
      mode: mode || undefined,
      categoryId: categoryId || undefined,
      district: district || undefined,
      budgetMaxAtLeast: b ?? undefined,
    });
  };

  return (
    <Card>
      <View style={styles.filterBar}>
        <T v="bodyStrong" accessibilityRole="header" style={styles.shrink}>
          {t('feed.filters')}
        </T>
        <Button
          kind="outline"
          small
          label={open ? t('common.hideFilters') : t('common.showFilters')}
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      {open ? (
        <Stack>
          <FieldShell label={t('feed.mode')}>
            <Chips
              label={t('feed.mode')}
              value={mode}
              onChange={(v) => {
                const m = v as NeedMode | '';
                setMode(m);
                if (m && categoryId && !categories.byId.get(categoryId)?.modes.includes(m))
                  setCategoryId('');
              }}
              options={[
                { value: '', label: t('feed.allModes') },
                ...NeedModes.map((m) => ({ value: m, label: t(`mode.${m}`) })),
              ]}
            />
          </FieldShell>
          <TextField
            label={t('feed.q')}
            value={q}
            onChange={setQ}
            maxLength={100}
            inputProps={{ returnKeyType: 'search', onSubmitEditing: submit }}
          />
          <SelectField
            label={t('feed.category')}
            value={categoryId}
            onChange={setCategoryId}
            placeholder={t('common.any')}
            options={categoryOptions(categories.flat, mode || undefined)}
          />
          <DistrictField
            label={t('feed.district')}
            value={district}
            onChange={setDistrict}
            placeholder={t('feed.anywhere')}
          />
          <MoneyField label={t('feed.budget')} value={budget} onChange={setBudget} error={error} />
          <Row>
            <Button small label={t('feed.apply')} onPress={submit} />
            <Button kind="outline" small label={t('feed.reset')} onPress={() => onApply({})} />
          </Row>
        </Stack>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  resultsHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  filterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  shrink: { flexShrink: 1 },
});
