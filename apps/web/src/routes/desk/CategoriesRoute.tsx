import {
  NeedModes,
  type AttributeSchema,
  type AttributeSpec,
  type NeedMode,
} from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CheckField, CheckGroup, SelectField, TextField } from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { deskApi, type AdminCategory, type CategoryInput } from '../../features/desk/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { asciiDigits } from '../../lib/money';

export default function CategoriesRoute() {
  const { id } = useParams();
  return (
    <StaffPage needs="category:manage" from="/desk/categories">
      {id === 'new' ? <CategoryForm /> : id ? <EditLoader id={id} /> : <Tree />}
    </StaffPage>
  );
}

interface StaffCategory extends AdminCategory {
  name: string;
  path: string;
  depth: number;
  /** Off itself, or under a parent that is off: members cannot see it either way. */
  hidden: boolean;
}

/**
 * Every category, switched-off ones included: the public tree drops inactive
 * categories, so an editor built on it could never switch one back on.
 */
function useStaffCategories() {
  const { lang } = useI18n();
  const all = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: deskApi.categories,
  });
  const flat = useMemo(() => {
    const byParent = new Map<string | null, AdminCategory[]>();
    for (const c of all.data ?? []) {
      byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
    }
    const out: StaffCategory[] = [];
    const walk = (parentId: string | null, trail: string[], hidden: boolean) => {
      const kids = [...(byParent.get(parentId) ?? [])].sort(
        (a, b) => a.sort - b.sort || a.nameEn.localeCompare(b.nameEn),
      );
      for (const c of kids) {
        const name = lang === 'bn' ? c.nameBn : c.nameEn;
        const path = [...trail, name];
        const off = hidden || !c.active;
        out.push({ ...c, name, path: path.join(' › '), depth: trail.length, hidden: off });
        walk(c.id, path, off);
      }
    };
    walk(null, [], false);
    return out;
  }, [all.data, lang]);
  return { ...all, flat };
}

function Tree() {
  const { t } = useI18n();
  const cats = useStaffCategories();
  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('cat.title')}</h1>
        <p className="desk__lede">{t('cat.lede')}</p>
        <div className="desk__meta">
          <Link className="btn btn--small" to="/desk/categories/new">
            {t('cat.new')}
          </Link>
        </div>
      </header>
      <section aria-labelledby="tree-title">
        <div className="section-head">
          <h2 id="tree-title">{t('cat.title')}</h2>
        </div>
        {cats.isPending && <LedgerSkeleton rows={6} />}
        {cats.isError && <LoadError onRetry={() => void cats.refetch()} />}
        <ul className="cattree">
          {cats.flat.map((c) => (
            <li
              key={c.id}
              className={c.hidden ? 'cattree__off' : undefined}
              style={{ paddingLeft: `${c.depth * 24}px` }}
            >
              <Link to={`/desk/categories/${c.id}`}>{c.name}</Link>
              <span className="muted"> · {c.modes.map((m) => t(`mode.${m}`)).join(', ')}</span>
              {!c.active && (
                <>
                  {' '}
                  <span className="stamp" title={t('cat.offHint')}>
                    {t('cat.off')}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function EditLoader({ id }: { id: string }) {
  const c = useQuery({
    queryKey: ['categories', 'all', id],
    queryFn: () => deskApi.category(id),
  });
  if (c.isPending) return <LedgerSkeleton rows={6} />;
  if (c.isError) return <LoadError onRetry={() => void c.refetch()} />;
  return <CategoryForm key={c.data.id} category={c.data} />;
}

interface AttrRow {
  key: string;
  type: AttributeSpec['type'];
  en: string;
  bn: string;
  choices: string;
  unit: string;
  min: string;
  max: string;
  required: boolean;
}

function rowsFrom(schema: AttributeSchema | undefined): AttrRow[] {
  return Object.entries(schema?.properties ?? {}).map(([key, s]) => ({
    key,
    type: s.type,
    en: s.label.en,
    bn: s.label.bn,
    choices: s.type === 'string' && s.enum ? s.enum.join(', ') : '',
    unit: s.type === 'integer' || s.type === 'number' ? (s.unit ?? '') : '',
    min:
      (s.type === 'integer' || s.type === 'number') && s.minimum !== undefined
        ? String(s.minimum)
        : '',
    max:
      (s.type === 'integer' || s.type === 'number') && s.maximum !== undefined
        ? String(s.maximum)
        : '',
    required: schema?.required.includes(key) ?? false,
  }));
}

function schemaFrom(rows: AttrRow[]): AttributeSchema {
  const properties: AttributeSchema['properties'] = {};
  for (const r of rows) {
    const label = { en: r.en.trim(), bn: r.bn.trim() };
    const num = (v: string) => (v.trim() ? Number(asciiDigits(v)) : undefined);
    if (r.type === 'boolean') properties[r.key] = { type: 'boolean', label };
    else if (r.type === 'string') {
      const choices = r.choices
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      properties[r.key] = { type: 'string', label, ...(choices.length ? { enum: choices } : {}) };
    } else {
      const min = num(r.min);
      const max = num(r.max);
      properties[r.key] = {
        type: r.type,
        label,
        ...(min !== undefined ? { minimum: min } : {}),
        ...(max !== undefined ? { maximum: max } : {}),
        ...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
      };
    }
  }
  return { properties, required: rows.filter((r) => r.required).map((r) => r.key) };
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY = /^[a-z][A-Za-z0-9]{0,39}$/;

function CategoryForm({ category }: { category?: AdminCategory }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cats = useStaffCategories();
  const [parentId, setParentId] = useState(category?.parentId ?? '');
  const [slug, setSlug] = useState(category?.slug ?? '');
  const [nameEn, setNameEn] = useState(category?.nameEn ?? '');
  const [nameBn, setNameBn] = useState(category?.nameBn ?? '');
  const [modes, setModes] = useState<NeedMode[]>(category?.modes ?? ['BUY']);
  const [sort, setSort] = useState(String(category?.sort ?? 0));
  const [active, setActive] = useState(category?.active ?? true);
  const [rows, setRows] = useState<AttrRow[]>(() => rowsFrom(category?.attributeSchema));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: (input: CategoryInput) =>
      category ? deskApi.updateCategory(category.id, input) : deskApi.createCategory(input),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['categories'] });
      if (!category) void navigate(`/desk/categories/${r.data.id}`);
    },
  });

  const setRow = (i: number, patch: Partial<AttrRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const keys = rows.map((r) => r.key);
    const errs: Record<string, string | undefined> = {
      slug: SLUG.test(slug) ? undefined : t('cat.badSlug'),
      nameEn: nameEn.trim() ? undefined : t('common.required'),
      nameBn: nameBn.trim() ? undefined : t('common.required'),
      modes: modes.length ? undefined : t('common.required'),
    };
    rows.forEach((r, i) => {
      if (!KEY.test(r.key) || keys.indexOf(r.key) !== i) errs[`key${i}`] = t('cat.badKey');
      if (!r.en.trim() || !r.bn.trim()) errs[`label${i}`] = t('common.required');
    });
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      parentId: parentId || null,
      slug,
      nameEn: nameEn.trim(),
      nameBn: nameBn.trim(),
      modes,
      attributeSchema: schemaFrom(rows),
      sort: Number(asciiDigits(sort)) || 0,
      active,
    });
  };

  return (
    <div className="formpage">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/desk/categories">{t('cat.title')}</Link>
        </p>
        <h1 tabIndex={-1}>{category ? category.nameEn : t('cat.new')}</h1>
      </header>
      <form onSubmit={submit} noValidate>
        <section className="formsec">
          <SelectField
            label={t('cat.parent')}
            value={parentId}
            onChange={setParentId}
            placeholder={t('cat.top')}
            options={cats.flat
              .filter((c) => c.id !== category?.id)
              .map((c) => ({
                value: c.id,
                label: c.active ? c.path : `${c.path} (${t('cat.off')})`,
              }))}
          />
          <div className="pair">
            <TextField
              label={t('cat.nameEn')}
              value={nameEn}
              onChange={setNameEn}
              maxLength={80}
              error={errors['nameEn']}
            />
            <TextField
              label={t('cat.nameBn')}
              value={nameBn}
              onChange={setNameBn}
              maxLength={80}
              error={errors['nameBn']}
            />
          </div>
          <div className="pair">
            <TextField
              label={t('cat.slug')}
              hint={t('cat.slugHint')}
              value={slug}
              onChange={setSlug}
              maxLength={60}
              error={errors['slug']}
            />
            <TextField label={t('cat.sort')} inputMode="numeric" value={sort} onChange={setSort} />
          </div>
          <CheckGroup<NeedMode>
            legend={t('cat.modes')}
            options={NeedModes.map((m) => ({ value: m, label: t(`mode.${m}`) }))}
            value={modes}
            onChange={setModes}
            error={errors['modes']}
          />
          <CheckField label={t('cat.active')} checked={active} onChange={setActive} />
          {!active && <p className="muted">{t('cat.offHint')}</p>}
        </section>

        <section className="formsec" aria-labelledby="attrs-title">
          <h2 id="attrs-title">{t('cat.attributes')}</h2>
          {rows.map((r, i) => (
            <fieldset key={i} className="counter attrrow">
              <legend className="visually-hidden">{r.key || t('cat.attrKey')}</legend>
              <div className="pair">
                <TextField
                  compact
                  label={t('cat.attrKey')}
                  value={r.key}
                  onChange={(v) => setRow(i, { key: v })}
                  maxLength={40}
                  error={errors[`key${i}`]}
                />
                <SelectField
                  compact
                  label={t('cat.attrType')}
                  value={r.type}
                  onChange={(v) => setRow(i, { type: v as AttrRow['type'] })}
                  options={(['string', 'integer', 'number', 'boolean'] as const).map((x) => ({
                    value: x,
                    label: t(`cat.type.${x}`),
                  }))}
                />
              </div>
              <div className="pair">
                <TextField
                  compact
                  label={t('cat.attrLabelEn')}
                  value={r.en}
                  onChange={(v) => setRow(i, { en: v })}
                  maxLength={60}
                  error={errors[`label${i}`]}
                />
                <TextField
                  compact
                  label={t('cat.attrLabelBn')}
                  value={r.bn}
                  onChange={(v) => setRow(i, { bn: v })}
                  maxLength={60}
                />
              </div>
              {r.type === 'string' && (
                <TextField
                  compact
                  label={t('cat.attrEnum')}
                  hint={t('cat.attrEnumHint')}
                  value={r.choices}
                  onChange={(v) => setRow(i, { choices: v })}
                />
              )}
              {(r.type === 'integer' || r.type === 'number') && (
                <div className="pair pair--3">
                  <TextField
                    compact
                    label={t('cat.attrMin')}
                    inputMode="decimal"
                    value={r.min}
                    onChange={(v) => setRow(i, { min: v })}
                  />
                  <TextField
                    compact
                    label={t('cat.attrMax')}
                    inputMode="decimal"
                    value={r.max}
                    onChange={(v) => setRow(i, { max: v })}
                  />
                  <TextField
                    compact
                    label={t('cat.attrUnit')}
                    value={r.unit}
                    onChange={(v) => setRow(i, { unit: v })}
                    maxLength={12}
                  />
                </div>
              )}
              <div className="formactions">
                <CheckField
                  label={t('cat.attrRequired')}
                  checked={r.required}
                  onChange={(v) => setRow(i, { required: v })}
                />
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  {t('cat.attrRemove')}
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                {
                  key: '',
                  type: 'string',
                  en: '',
                  bn: '',
                  choices: '',
                  unit: '',
                  min: '',
                  max: '',
                  required: false,
                },
              ])
            }
          >
            {t('cat.attrAdd')}
          </button>
          {Object.values(errors).some(Boolean) && (
            <p className="alert" role="alert">
              <AlertIcon />
              <span>{t('needForm.fix')}</span>
            </p>
          )}
          {save.isError && (
            <p className="alert" role="alert">
              <AlertIcon />
              <span>{errorMessage(save.error, t)}</span>
            </p>
          )}
          {save.isSuccess && category && (
            <p className="alert alert--note" role="status">
              <NoteIcon />
              <span>{t('cat.saved')}</span>
            </p>
          )}
          <div className="formactions">
            <button type="submit" className="btn" disabled={save.isPending}>
              {t('cat.save')}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
