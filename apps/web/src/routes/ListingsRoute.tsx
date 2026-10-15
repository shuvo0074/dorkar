import { Conditions, type Condition } from '@dorkar/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  DistrictField,
  MoneyField,
  Segmented,
  SelectField,
  TextField,
} from '../components/forms/fields';
import { MoreButton, usePaged } from '../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import {
  catalogApi,
  ListingKinds,
  type ListingKind,
  type ListingSearch,
} from '../features/catalog/api';
import { categoryOptions, useCategories } from '../features/catalog/categories';
import { ListingEntry } from '../features/catalog/ListingEntry';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { parseTaka, takaInput } from '../lib/money';

const SORTS = ['newest', 'price_asc', 'price_desc'] as const;

function readSearch(p: URLSearchParams): ListingSearch {
  const kind = p.get('kind');
  const condition = p.get('condition');
  const sort = p.get('sort');
  const n = (k: string) => {
    const v = Number(p.get(k));
    return Number.isInteger(v) && v > 0 ? v : undefined;
  };
  return {
    q: p.get('q') || undefined,
    kind: ListingKinds.includes(kind as ListingKind) ? (kind as ListingKind) : undefined,
    condition: Conditions.includes(condition as Condition) ? (condition as Condition) : undefined,
    categoryId: p.get('category') || undefined,
    district: p.get('district') || undefined,
    minPrice: n('min'),
    maxPrice: n('max'),
    sort: SORTS.includes(sort as (typeof SORTS)[number])
      ? (sort as (typeof SORTS)[number])
      : undefined,
  };
}

export default function ListingsRoute() {
  const { t, num } = useI18n();
  const [params, setParams] = useSearchParams();
  const search = readSearch(params);
  const list = usePaged(['listings', search], (cursor) => catalogApi.listings(search, cursor));

  const apply = (s: ListingSearch) => {
    const q = new URLSearchParams();
    if (s.q) q.set('q', s.q);
    if (s.kind) q.set('kind', s.kind);
    if (s.condition) q.set('condition', s.condition);
    if (s.categoryId) q.set('category', s.categoryId);
    if (s.district) q.set('district', s.district);
    if (s.minPrice) q.set('min', String(s.minPrice));
    if (s.maxPrice) q.set('max', String(s.maxPrice));
    if (s.sort && s.sort !== 'newest') q.set('sort', s.sort);
    setParams(q);
  };

  return (
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('listings.title')}</h1>
        <p className="desk__lede">{t('listings.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--outline btn--small" to="/#post">
            {t('listings.postNeed')}
          </Link>
        </div>
      </header>

      <Filters key={params.toString()} search={search} onApply={apply} />

      <section aria-labelledby="results-title" aria-busy={list.isFetching}>
        <div className="section-head">
          <h2 id="results-title">{t('listings.title')}</h2>
          {list.data && <p>{t('feed.count', { n: num(list.rows.length) })}</p>}
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('listings.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="catalog">
            {list.rows.map((l) => (
              <ListingEntry key={l.id} listing={l} />
            ))}
          </ul>
        )}
        <MoreButton query={list} label={t('listings.more')} />
      </section>
    </div>
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
  const [condition, setCondition] = useState(search.condition ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState(search.district ?? '');
  const [min, setMin] = useState(takaInput(search.minPrice));
  const [max, setMax] = useState(takaInput(search.maxPrice));
  const [sort, setSort] = useState(search.sort ?? 'newest');
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
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
    <section className="panel filters" aria-labelledby="filters-title">
      <h2 id="filters-title" className="filters__title">
        {t('listings.filters')}
      </h2>
      <form onSubmit={submit} noValidate>
        <Segmented
          legend={t('listings.kind')}
          name="listing-kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: '' as const, label: t('listings.kind.all') },
            ...ListingKinds.map((k) => ({ value: k, label: t(`kind.${k}`) })),
          ]}
        />
        <div className="filters__grid">
          <TextField
            compact
            type="search"
            label={t('feed.q')}
            value={q}
            onChange={setQ}
            maxLength={100}
          />
          <SelectField
            compact
            label={t('feed.category')}
            value={categoryId}
            onChange={setCategoryId}
            placeholder={t('common.any')}
            options={categoryOptions(categories.flat)}
          />
          <DistrictField
            compact
            label={t('feed.district')}
            value={district}
            onChange={setDistrict}
            placeholder={t('feed.anywhere')}
          />
          <SelectField
            compact
            label={t('listings.condition')}
            value={condition}
            onChange={setCondition}
            placeholder={t('common.any')}
            options={Conditions.map((c) => ({ value: c, label: f.condition(c) }))}
          />
          <MoneyField
            compact
            label={t('listings.minPrice')}
            value={min}
            onChange={setMin}
            error={errors.min}
          />
          <MoneyField
            compact
            label={t('listings.maxPrice')}
            value={max}
            onChange={setMax}
            error={errors.max}
          />
          <SelectField
            compact
            label={t('listings.sort')}
            value={sort}
            onChange={(v) => setSort(v as (typeof SORTS)[number])}
            options={SORTS.map((s) => ({ value: s, label: t(`listings.sort.${s}`) }))}
          />
        </div>
        <div className="filters__actions">
          <button type="submit" className="btn btn--small">
            {t('listings.apply')}
          </button>
          <button type="button" className="btn btn--outline btn--small" onClick={() => onApply({})}>
            {t('feed.reset')}
          </button>
        </div>
      </form>
    </section>
  );
}
