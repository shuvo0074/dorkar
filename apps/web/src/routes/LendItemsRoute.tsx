import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DistrictField, SelectField, TextField } from '../components/forms/fields';
import { LadderGlyph } from '../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { categoryOptions, useCategories } from '../features/catalog/categories';
import { itemCode, lendingApi, type LendItem } from '../features/lending/api';
import { MediaImage } from '../features/media/Photos';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { FilterPanel } from '../components/ui/FilterPanel';

export function LendEntry({ item }: { item: LendItem }) {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <li className="entry">
      <Link to={`/lend/${item.id}`} className="entry__link">
        <div className="entry__art">
          {item.mediaIds[0] ? (
            <MediaImage id={item.mediaIds[0]} fallback={<LadderGlyph />} />
          ) : (
            <LadderGlyph />
          )}
        </div>
        <span className="entry__code code">{itemCode(item.id)}</span>
        <span className="entry__title">{item.title}</span>
        <span className="entry__meta">
          {f.district(item.district)} ·{' '}
          {item.deposit ? `${t('lend.deposit')} ${f.taka(item.deposit)}` : t('lend.noDeposit')}
        </span>
      </Link>
    </li>
  );
}

export default function LendItemsRoute() {
  const { t, num } = useI18n();
  const categories = useCategories();
  const [params, setParams] = useSearchParams();
  const search = {
    q: params.get('q') || undefined,
    categoryId: params.get('category') || undefined,
    district: params.get('district') || undefined,
  };
  const list = usePaged(['lend-items', search], (cursor) => lendingApi.items(search, cursor));
  const [q, setQ] = useState(search.q ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState(search.district ?? '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (categoryId) next.set('category', categoryId);
    if (district) next.set('district', district);
    setParams(next);
  };

  return (
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('lend.title')}</h1>
        <p className="desk__lede">{t('lend.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--outline btn--small" to="/lend/new">
            {t('lend.lendYours')}
          </Link>
        </div>
      </header>
      <FilterPanel titleId="lend-filters" title={t('feed.filters')}>
        <form onSubmit={submit} noValidate>
          <div className="filters__grid">
            <TextField
              compact
              type="search"
              label={t('feed.q')}
              value={q}
              onChange={setQ}
              maxLength={200}
            />
            <SelectField
              compact
              label={t('feed.category')}
              value={categoryId}
              onChange={setCategoryId}
              placeholder={t('common.any')}
              options={categoryOptions(categories.flat, 'BORROW')}
            />
            <DistrictField
              compact
              label={t('feed.district')}
              value={district}
              onChange={setDistrict}
              placeholder={t('feed.anywhere')}
            />
          </div>
          <div className="filters__actions">
            <button type="submit" className="btn btn--small">
              {t('common.search')}
            </button>
          </div>
        </form>
      </FilterPanel>
      <section aria-labelledby="lend-results" aria-busy={list.isFetching}>
        <div className="section-head">
          <h2 id="lend-results">{t('lend.title')}</h2>
          {list.data && <p>{t('feed.count', { n: num(list.rows.length) })}</p>}
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('lend.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="catalog">
            {list.rows.map((i) => (
              <LendEntry key={i.id} item={i} />
            ))}
          </ul>
        )}
        <MoreButton query={list} label={t('lend.more')} />
      </section>
    </div>
  );
}
