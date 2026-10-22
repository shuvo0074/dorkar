import { NeedModes, type NeedMode } from '@dorkar/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  DistrictField,
  MoneyField,
  Segmented,
  SelectField,
  TextField,
} from '../components/forms/fields';
import { LedgerSkeleton, LoadError } from '../components/ui/Status';
import { categoryOptions, useCategories } from '../features/catalog/categories';
import { needsApi, type NeedSearch } from '../features/needs/api';
import { NeedEntry } from '../features/needs/NeedEntry';
import { useI18n } from '../lib/i18n';
import { parseTaka, takaInput } from '../lib/money';
import { FilterPanel } from '../components/ui/FilterPanel';

/** Filters live in the URL, so a search can be shared or bookmarked. */
function readSearch(p: URLSearchParams): NeedSearch {
  const mode = p.get('mode');
  const budget = Number(p.get('budget'));
  return {
    q: p.get('q') || undefined,
    mode: NeedModes.includes(mode as NeedMode) ? (mode as NeedMode) : undefined,
    categoryId: p.get('category') || undefined,
    district: p.get('district') || undefined,
    budgetMaxAtLeast: Number.isInteger(budget) && budget > 0 ? budget : undefined,
  };
}

export default function NeedsRoute() {
  const { t, num } = useI18n();
  const [params, setParams] = useSearchParams();
  const search = readSearch(params);
  const feed = useInfiniteQuery({
    queryKey: ['needs', 'feed', search],
    queryFn: ({ pageParam }) => needsApi.feed(search, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const rows = feed.data?.pages.flatMap((p) => p.data) ?? [];

  const apply = (s: NeedSearch) => {
    const q = new URLSearchParams();
    if (s.q) q.set('q', s.q);
    if (s.mode) q.set('mode', s.mode);
    if (s.categoryId) q.set('category', s.categoryId);
    if (s.district) q.set('district', s.district);
    if (s.budgetMaxAtLeast) q.set('budget', String(s.budgetMaxAtLeast));
    setParams(q);
  };

  return (
    <div className="browse">
      <header className="desk__head">
        <h1 tabIndex={-1}>{t('feed.title')}</h1>
        <p className="desk__lede">{t('feed.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--outline btn--small" to="/#post">
            {t('feed.postOwn')}
          </Link>
        </div>
      </header>

      <Filters key={params.toString()} search={search} onApply={apply} />

      <section aria-labelledby="results-title" aria-busy={feed.isFetching}>
        <div className="section-head">
          <h2 id="results-title">{t('feed.results')}</h2>
          {feed.data && <p>{t('feed.count', { n: num(rows.length) })}</p>}
        </div>
        {feed.isPending && <LedgerSkeleton rows={4} />}
        {feed.isError && <LoadError onRetry={() => void feed.refetch()} />}
        {feed.data && rows.length === 0 && <p className="muted">{t('feed.empty')}</p>}
        {rows.length > 0 && (
          <ul className="catalog">
            {rows.map((n) => (
              <NeedEntry key={n.id} need={n} />
            ))}
          </ul>
        )}
        {feed.hasNextPage && (
          <div className="logmore">
            <button
              type="button"
              className="btn btn--outline btn--small"
              disabled={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage ? t('loading') : t('feed.more')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Filters({ search, onApply }: { search: NeedSearch; onApply: (s: NeedSearch) => void }) {
  const { t } = useI18n();
  const categories = useCategories();
  const [q, setQ] = useState(search.q ?? '');
  const [mode, setMode] = useState<NeedMode | ''>(search.mode ?? '');
  const [categoryId, setCategoryId] = useState(search.categoryId ?? '');
  const [district, setDistrict] = useState(search.district ?? '');
  const [budget, setBudget] = useState(takaInput(search.budgetMaxAtLeast));
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
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
    <FilterPanel titleId="filters-title" title={t('feed.filters')}>
      <form onSubmit={submit} noValidate>
        <Segmented
          legend={t('feed.mode')}
          name="feed-mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m && categoryId && !categories.byId.get(categoryId)?.modes.includes(m))
              setCategoryId('');
          }}
          options={[
            { value: '' as const, label: t('feed.allModes') },
            ...NeedModes.map((m) => ({ value: m, label: t(`mode.${m}`) })),
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
            options={categoryOptions(categories.flat, mode || undefined)}
          />
          <DistrictField
            compact
            label={t('feed.district')}
            value={district}
            onChange={setDistrict}
            placeholder={t('feed.anywhere')}
          />
          <MoneyField
            compact
            label={t('feed.budget')}
            value={budget}
            onChange={setBudget}
            error={error}
          />
        </div>
        <div className="filters__actions">
          <button type="submit" className="btn btn--small">
            {t('feed.apply')}
          </button>
          <button type="button" className="btn btn--outline btn--small" onClick={() => onApply({})}>
            {t('feed.reset')}
          </button>
        </div>
      </form>
    </FilterPanel>
  );
}
