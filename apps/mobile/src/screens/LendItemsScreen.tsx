import { categoryOptions, useCategories } from '@web/features/catalog/categories';
import { lendingApi } from '@web/features/lending/api';
import { useState } from 'react';
import { c } from '../design/tokens';
import { FilterPanel, PagedList } from '../features/catalog/pageParts';
import { LendEntry } from '../features/lending/LendEntry';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { DistrictField, SelectField, TextField } from '../ui/Fields';
import { Section, Stack } from '../ui/Layout';
import { usePaged } from '../ui/Misc';
import { T } from '../ui/Text';

export default function LendItemsScreen() {
  const { t, num } = useI18n();
  const nav = useNav();
  const categories = useCategories();
  const params = useParams<'LendItems'>() ?? {};
  const search = {
    q: params.q || undefined,
    categoryId: params.categoryId || undefined,
    district: params.district || undefined,
  };
  const list = usePaged(['lend-items', search], (cursor) => lendingApi.items(search, cursor));
  const [q, setQ] = useState(search.q ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState<string>(search.district ?? '');

  const submit = () => {
    nav.navigate('LendItems', {
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(district ? { district } : {}),
    });
  };

  return (
    <PagedList
      query={list}
      columns={2}
      empty={t('lend.empty')}
      moreLabel={t('lend.more')}
      renderRow={(i) => <LendEntry item={i} />}
      header={
        <>
          <Stack>
            <T color={c.inkSoft}>{t('lend.lede')}</T>
            <Button
              kind="outline"
              small
              label={t('lend.lendYours')}
              onPress={() => nav.navigate('LendForm')}
            />
          </Stack>
          <FilterPanel title={t('feed.filters')}>
            <TextField
              label={t('feed.q')}
              value={q}
              onChange={setQ}
              maxLength={200}
              inputProps={{ returnKeyType: 'search', onSubmitEditing: submit }}
            />
            <SelectField
              label={t('feed.category')}
              value={categoryId}
              onChange={setCategoryId}
              placeholder={t('common.any')}
              options={categoryOptions(categories.flat, 'BORROW')}
            />
            <DistrictField
              label={t('feed.district')}
              value={district}
              onChange={setDistrict}
              placeholder={t('feed.anywhere')}
            />
            <Button small label={t('common.search')} onPress={submit} />
          </FilterPanel>
          <Section
            title={t('lend.title')}
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
