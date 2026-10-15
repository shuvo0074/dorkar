import type { NeedMode } from '@dorkar/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../lib/i18n';
import { catalogApi, type CategoryNode } from './api';

export interface FlatCategory {
  id: string;
  name: string;
  /** "Electronics › Phones": the path, for choosing among similar names. */
  path: string;
  /** The top-level ancestor's name, for grouping in a select. */
  root: string;
  modes: NeedMode[];
  leaf: boolean;
}

/** The category tree changes rarely (the API caches it for five minutes too). */
export function useCategoryTree() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: catalogApi.categories,
    staleTime: 10 * 60_000,
  });
}

export function useCategory(id: string | undefined) {
  return useQuery({
    queryKey: ['categories', id],
    queryFn: () => catalogApi.category(id!),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
  });
}

/** The tree flattened depth-first, named in the page language. */
export function useCategories() {
  const { lang } = useI18n();
  const tree = useCategoryTree();
  const flat = useMemo(() => {
    const out: FlatCategory[] = [];
    const walk = (nodes: CategoryNode[], trail: string[], root: string | null) => {
      for (const n of [...nodes].sort((a, b) => a.sort - b.sort)) {
        const name = lang === 'bn' ? n.nameBn : n.nameEn;
        const path = [...trail, name];
        out.push({
          id: n.id,
          name,
          path: path.join(' › '),
          root: root ?? name,
          modes: n.modes,
          leaf: n.children.length === 0,
        });
        walk(n.children, path, root ?? name);
      }
    };
    walk(tree.data ?? [], [], null);
    return out;
  }, [tree.data, lang]);
  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);
  const name = useCallback((id: string) => byId.get(id)?.name ?? '', [byId]);
  return { ...tree, flat, byId, name };
}

/** Select options for categories that accept a mode, grouped under their top-level name. */
export function categoryOptions(flat: FlatCategory[], mode?: NeedMode) {
  return flat
    .filter((c) => !mode || c.modes.includes(mode))
    .map((c) => ({ value: c.id, label: c.path, group: c.root }));
}
