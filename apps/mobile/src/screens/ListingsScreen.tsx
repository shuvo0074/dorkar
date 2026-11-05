import { Conditions, type Condition } from '@dorkar/contracts';
import {
  catalogApi,
  ListingKinds,
  type ListingKind,
  type ListingSearch,
} from '@web/features/catalog/api';
import { categoryOptions, useCategories } from '@web/features/catalog/categories';
import { useFormat } from '@web/lib/format';
import { parseTaka, takaInput } from '@web/lib/money';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { c, space } from '../design/tokens';
import { ListingEntry } from '../features/catalog/ListingEntry';
import { FilterPanel, PagedList } from '../features/catalog/pageParts';
import { useI18n } from '../lib/i18n';
import { useNav, useParams, type RootParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { Chips, DistrictField, MoneyField, SelectField, TextField } from '../ui/Fields';
import { Row, Section, Stack } from '../ui/Layout';
import { usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

const SORTS = ['newest', 'price_asc', 'price_desc'] as const;
type Params = NonNullable<RootParams['Listings']>;

function readSearch(p: Params): ListingSearch {
  const n = (v: string | undefined) => {
    const x = Number(v);
    return Number.isInteger(x) && x > 0 ? x : undefined;
  };
  return {
    q: p.q || undefined,
    kind: ListingKinds.includes(p.kind as ListingKind) ? (p.kind as ListingKind) : undefined,
    condition: Conditions.includes(p.condition as Condition)
      ? (p.condition as Condition)
      : undefined,
    categoryId: p.categoryId || undefined,
    district: p.district || undefined,
    minPrice: n(p.min),
    maxPrice: n(p.max),
    sort: SORTS.includes(p.sort as (typeof SORTS)[number])
      ? (p.sort as (typeof SORTS)[number])
      : undefined,
  };
}

export default function ListingsScreen() {
  const { t, num } = useI18n();
  const nav = useNav();
  const params = useParams<'Listings'>() ?? {};
  const search = readSearch(params);
  const list = usePaged(['listings', search], (cursor) => catalogApi.listings(search, cursor));

  const apply = (s: ListingSearch) => {
    nav.navigate('Listings', {
      ...(s.q ? { q: s.q } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.condition ? { condition: s.condition } : {}),
      ...(s.categoryId ? { categoryId: s.categoryId } : {}),
      ...(s.district ? { district: s.district } : {}),
      ...(s.minPrice ? { min: String(s.minPrice) } : {}),
      ...(s.maxPrice ? { max: String(s.maxPrice) } : {}),
      ...(s.sort && s.sort !== 'newest' ? { sort: s.sort } : {}),
    });
  };

  return (
    <PagedList
      query={list}
      columns={2}
      empty={t('listings.empty')}
      moreLabel={t('listings.more')}
      renderRow={(l) => <ListingEntry listing={l} />}
      header={
        <>
          <Stack>
            <T color={c.inkSoft}>{t('listings.lede')}</T>
            <Button
              kind="outline"
              small
              label={t('listings.postNeed')}
              onPress={() =>
                nav.navigate('Tabs', { screen: 'Home', params: { focusComposer: Date.now() } })
              }
            />
          </Stack>
          <Filters key={JSON.stringify(params)} search={search} onApply={apply} />
          <Section
            title={t('listings.title')}
            right={
              list.data ? (
                <T v="small" color={c.inkSoft}>
                  {t('feed.count', { n: num(list.rows.length) })}
                </T>
              ) : null
            }
          >
            {null}
          </Section>
        </>
      }
    />
  );
}

function Filters({
  search,
  onApply,
}: {
  search: ListingSearch;
  onApply: (s: ListingSearch) => void;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const categories = useCategories();
  const [q, setQ] = useState(search.q ?? '');
  const [kind, setKind] = useState<ListingKind | ''>(search.kind ?? '');
  const [condition, setCondition] = useState<string>(search.condition ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState<string>(search.district ?? '');
  const [min, setMin] = useState(takaInput(search.minPrice));
  const [max, setMax] = useState(takaInput(search.maxPrice));
  const [sort, setSort] = useState<(typeof SORTS)[number]>(search.sort ?? 'newest');
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});

  const submit = () => {
    const lo = min.trim() ? parseTaka(min) : null;
    const hi = max.trim() ? parseTaka(max) : null;
    const errs = {
      ...(min.trim() && lo === null ? { min: t('common.badAmount') } : {}),
      ...(max.trim() && hi === null ? { max: t('common.badAmount') } : {}),
      ...(lo !== null && hi !== null && lo > hi ? { min: t('needForm.budgetOrder') } : {}),
    };
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onApply({
      q: q.trim() || undefined,
      kind: kind || undefined,
      condition: (condition || undefined) as Condition | undefined,
      categoryId: categoryId || undefined,
      district: district || undefined,
      minPrice: lo ?? undefined,
      maxPrice: hi ?? undefined,
      sort,
    });
  };

  return (
    <FilterPanel title={t('listings.filters')}>
      <T v="label" color={c.inkSoft}>
        {t('listings.kind')}
      </T>
      <Chips
        label={t('listings.kind')}
        value={kind}
        onChange={(v) => setKind(v as ListingKind | '')}
        options={[
          { value: '', label: t('listings.kind.all') },
          ...ListingKinds.map((k) => ({ value: k, label: t(`kind.${k}`) })),
        ]}
      />
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
        options={categoryOptions(categories.flat)}
      />
      <DistrictField
        label={t('feed.district')}
        value={district}
        onChange={setDistrict}
        placeholder={t('feed.anywhere')}
      />
      <SelectField
        label={t('listings.condition')}
        value={condition}
        onChange={setCondition}
        placeholder={t('common.any')}
        options={Conditions.map((x) => ({ value: x, label: f.condition(x) }))}
      />
      <MoneyField label={t('listings.minPrice')} value={min} onChange={setMin} error={errors.min} />
      <MoneyField label={t('listings.maxPrice')} value={max} onChange={setMax} error={errors.max} />
      <SelectField
        label={t('listings.sort')}
        value={sort}
        onChange={(v) => setSort(v as (typeof SORTS)[number])}
        options={SORTS.map((s) => ({ value: s, label: t(`listings.sort.${s}`) }))}
      />
      <Row style={styles.actions}>
        <Button small label={t('listings.apply')} onPress={submit} />
        <Button kind="outline" small label={t('feed.reset')} onPress={() => onApply({})} />
      </Row>
    </FilterPanel>
  );
}

const styles = StyleSheet.create({
  actions: { paddingTop: space.gap },
});
