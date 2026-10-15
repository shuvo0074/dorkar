import {
  Conditions,
  findContactInfo,
  type Condition,
  type District,
  type NeedMode,
} from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  AttributeFields,
  draftFromValues,
  readAttributes,
  type AttributeDraft,
} from '../components/forms/AttributeFields';
import {
  CheckField,
  CheckGroup,
  DistrictField,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { categoryOptions, useCategories, useCategory } from '../features/catalog/categories';
import {
  DeliveryPreferences,
  needsApi,
  type DeliveryPreference,
  type Need,
  type NeedInput,
} from '../features/needs/api';
import { clearDraft, loadDraft, splitDraft } from '../features/needs/draft';
import { ModeKey } from '../features/needs/ModeKey';
import {
  NeedTermsFields,
  readNeedTerms,
  termsDraftFrom,
  type TermsDraft,
} from '../features/needs/NeedTerms';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { parseTaka, poisha, takaInput } from '../lib/money';

interface Form {
  mode: NeedMode;
  title: string;
  description: string;
  categoryId: string;
  quantity: string;
  conditions: Condition[];
  terms: TermsDraft;
  attributes: AttributeDraft;
  budgetMin: string;
  budgetMax: string;
  flexible: boolean;
  district: string;
  area: string;
  delivery: DeliveryPreference;
  requiredBy: string;
  matchedOnly: boolean;
}

function fromComposer(): Form {
  const d = loadDraft();
  const { title, description } = splitDraft(d.text);
  return {
    mode: d.mode,
    title,
    description,
    categoryId: '',
    quantity: '1',
    conditions: [],
    terms: {},
    attributes: {},
    budgetMin: '',
    budgetMax: '',
    flexible: false,
    district: '',
    area: '',
    delivery: 'EITHER',
    requiredBy: '',
    matchedOnly: false,
  };
}

function fromNeed(n: Need): Form {
  return {
    mode: n.mode,
    title: n.title,
    description: n.description ?? '',
    categoryId: n.categoryId,
    quantity: String(n.quantity),
    conditions: n.condition,
    terms: termsDraftFrom(n.mode, n.modeTerms),
    attributes: draftFromValues(n.attributes),
    budgetMin: takaInput(n.budget.min),
    budgetMax: takaInput(n.budget.max),
    flexible: n.budget.flexible,
    district: n.location.district,
    area: n.location.area ?? '',
    delivery: n.deliveryPreference,
    requiredBy: n.requiredBy ?? '',
    matchedOnly: n.visibility === 'MATCHED_ONLY',
  };
}

export default function NeedFormRoute() {
  const { id } = useParams();
  return (
    <SignedInOnly from={id ? `/needs/${id}/edit` : '/needs/new'}>
      {id ? <EditNeed id={id} /> : <NeedForm initial={fromComposer()} />}
    </SignedInOnly>
  );
}

function EditNeed({ id }: { id: string }) {
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) return <LedgerSkeleton rows={6} />;
  if (need.isError) return <LoadError onRetry={() => void need.refetch()} />;
  return <NeedForm initial={fromNeed(need.data)} need={need.data} />;
}

type Errors = Partial<Record<string, string>>;

function NeedForm({ initial, need }: { initial: Form; need?: Need }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const category = useCategory(form.categoryId || undefined);
  const locked = Boolean(need && need.offerCount > 0);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = useMutation({
    mutationFn: async ({ input, publish }: { input: NeedInput; publish: boolean }) => {
      if (!need) return needsApi.create({ ...input, publish });
      const patch: Partial<NeedInput> = { ...input };
      delete patch.publish;
      // Mode and category are frozen once offers exist; only send them while they can change.
      if (locked) {
        delete patch.mode;
        delete patch.categoryId;
      }
      const saved = await needsApi.update(need.id, patch);
      return publish && saved.status === 'DRAFT' ? needsApi.command(need.id, 'publish') : saved;
    },
    onSuccess: (saved) => {
      if (!need) clearDraft();
      qc.setQueryData(['needs', saved.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['needs', 'feed'] });
      void navigate(`/needs/${saved.id}`, {
        state: { notice: saved.status === 'DRAFT' ? 'draft' : 'posted' },
      });
    },
  });

  const validate = (): NeedInput | null => {
    const e: Errors = {};
    const title = form.title.trim();
    if (title.length < 5) e['title'] = t('needForm.titleShort');
    if (!form.categoryId) e['categoryId'] = t('common.required');
    if (!form.district) e['district'] = t('common.required');
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) e['quantity'] = t('common.badNumber');
    const min = form.budgetMin.trim() ? parseTaka(form.budgetMin) : null;
    const max = form.budgetMax.trim() ? parseTaka(form.budgetMax) : null;
    if (form.budgetMin.trim() && min === null) e['budgetMin'] = t('common.badAmount');
    if (form.budgetMax.trim() && max === null) e['budgetMax'] = t('common.badAmount');
    if (min !== null && max !== null && min > max) e['budgetMin'] = t('needForm.budgetOrder');
    for (const [k, text] of [
      ['title', title],
      ['description', form.description],
    ] as const) {
      if (findContactInfo(text)) e[k] = t('needForm.contact');
    }
    const terms = readNeedTerms(form.mode, form.terms);
    for (const [k, key] of Object.entries(terms.errors)) e[`terms.${k}`] = t(key, { n: 1000 });
    const schema = category.data?.attributeSchema;
    const attrs = schema ? readAttributes(schema, form.attributes, { partial: true }) : null;
    for (const [k, msg] of Object.entries(attrs?.errors ?? {})) e[`attr.${k}`] = msg;

    setErrors(e);
    if (Object.keys(e).length > 0) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('.needform [aria-invalid="true"]')?.focus(),
      );
      return null;
    }
    return {
      mode: form.mode,
      categoryId: form.categoryId,
      title,
      description: form.description.trim() || null,
      quantity,
      budget:
        min === null && max === null && !form.flexible
          ? null
          : {
              min: min === null ? null : poisha(min),
              max: max === null ? null : poisha(max),
              flexible: form.flexible,
            },
      condition: form.conditions,
      attributes: attrs?.value ?? {},
      modeTerms: terms.value,
      location: {
        district: form.district as District,
        ...(form.area.trim() ? { area: form.area.trim() } : {}),
      },
      deliveryPreference: form.delivery,
      requiredBy: form.requiredBy || null,
      visibility: form.matchedOnly ? 'MATCHED_ONLY' : 'PUBLIC',
    };
  };

  const submit = (publish: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    const input = validate();
    if (!input) return;
    // A brand-new need without a budget or description sends no nulls the API would refuse.
    if (!need) {
      if (input.budget === null) delete input.budget;
      if (input.description === null) delete input.description;
      if (input.requiredBy === null) delete input.requiredBy;
    }
    save.mutate({ input, publish });
  };

  const err = (k: string) => errors[k];
  const termErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k, v]) => k.startsWith('terms.') && v)
      .map(([k, v]) => [k.slice(6), v]),
  );
  const attrErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k, v]) => k.startsWith('attr.') && v)
      .map(([k, v]) => [k.slice(5), v!]),
  );
  const options = categoryOptions(categories.flat, form.mode);
  const isDraft = !need || need.status === 'DRAFT';

  return (
    <div className="formpage needform">
      <header className="desk__head">
        {need && (
          <p className="crumb">
            <Link to={`/needs/${need.id}`}>{need.title}</Link>
          </p>
        )}
        <h1 tabIndex={-1}>{t(need ? 'needForm.editTitle' : 'needForm.title')}</h1>
        <p className="desk__lede">{t('needForm.lede')}</p>
      </header>

      <form onSubmit={submit(isDraft)} noValidate>
        <section className="formsec" aria-labelledby="nf-1">
          <h2 id="nf-1">
            <span className="formsec__n" aria-hidden="true">
              1
            </span>
            {t('needForm.s1')}
          </h2>
          {locked ? (
            <p className="alert alert--note">
              <NoteIcon />
              <span>{t('needForm.modeLocked')}</span>
            </p>
          ) : (
            <ModeKey
              value={form.mode}
              onChange={(mode) => {
                const keep = categories.byId.get(form.categoryId)?.modes.includes(mode);
                setForm((f) => ({
                  ...f,
                  mode,
                  terms: {},
                  ...(keep ? {} : { categoryId: '', attributes: {} }),
                }));
              }}
            />
          )}
          <TextField
            label={t('needForm.titleField')}
            hint={t('needForm.titleHint')}
            value={form.title}
            onChange={(v) => set('title', v)}
            maxLength={120}
            placeholder={t(`mode.${form.mode}.example`)}
            error={err('title')}
          />
          <TextAreaField
            label={t('needForm.description')}
            optional
            hint={t('needForm.descriptionHint')}
            value={form.description}
            onChange={(v) => set('description', v)}
            maxLength={2000}
            error={err('description')}
          />
          {categories.isError ? (
            <LoadError onRetry={() => void categories.refetch()} />
          ) : (
            <SelectField
              label={t('needForm.category')}
              hint={t('needForm.categoryHint')}
              value={form.categoryId}
              onChange={(v) => setForm((f) => ({ ...f, categoryId: v, attributes: {} }))}
              placeholder={categories.isPending ? t('loading') : t('needForm.categoryPick')}
              options={locked ? options.filter((o) => o.value === form.categoryId) : options}
              error={err('categoryId')}
            />
          )}
        </section>

        <section className="formsec" aria-labelledby="nf-2">
          <h2 id="nf-2">
            <span className="formsec__n" aria-hidden="true">
              2
            </span>
            {t('needForm.s2')}
          </h2>
          <div className="pair">
            <TextField
              label={t('needForm.quantity')}
              inputMode="numeric"
              value={form.quantity}
              onChange={(v) => set('quantity', v.replace(/\D/g, ''))}
              error={err('quantity')}
            />
          </div>
          {form.mode !== 'HIRE' && (
            <CheckGroup
              legend={t('needForm.conditions')}
              hint={t('needForm.conditionsHint')}
              options={Conditions.map((c) => ({ value: c, label: t(`condition.${c}`) }))}
              value={form.conditions}
              onChange={(v) => set('conditions', v)}
            />
          )}
          <NeedTermsFields
            mode={form.mode}
            draft={form.terms}
            onChange={(v) => set('terms', v)}
            errors={termErrors}
          />
          {category.data && (
            <AttributeFields
              schema={category.data.attributeSchema}
              draft={form.attributes}
              onChange={(v) => set('attributes', v)}
              errors={attrErrors}
              partial
            />
          )}
        </section>

        <section className="formsec" aria-labelledby="nf-3">
          <h2 id="nf-3">
            <span className="formsec__n" aria-hidden="true">
              3
            </span>
            {t('needForm.s3')}
          </h2>
          <div className="pair">
            <MoneyField
              label={t('needForm.budgetMin')}
              optional
              value={form.budgetMin}
              onChange={(v) => set('budgetMin', v)}
              error={err('budgetMin')}
            />
            <MoneyField
              label={t('needForm.budgetMax')}
              optional
              value={form.budgetMax}
              onChange={(v) => set('budgetMax', v)}
              error={err('budgetMax')}
            />
          </div>
          <p className="field__hint">{t('needForm.budgetHint')}</p>
          <CheckField
            label={t('needForm.flexible')}
            checked={form.flexible}
            onChange={(v) => set('flexible', v)}
          />
          <div className="pair">
            <DistrictField
              label={t('place.district')}
              value={form.district}
              onChange={(v) => set('district', v)}
              placeholder={t('place.pick')}
              error={err('district')}
            />
            <TextField
              label={t('place.area')}
              optional
              hint={t('place.areaHint')}
              value={form.area}
              onChange={(v) => set('area', v)}
              maxLength={80}
            />
          </div>
          <div className="pair">
            {form.mode !== 'HIRE' && (
              <SelectField
                label={t('needForm.delivery')}
                value={form.delivery}
                onChange={(v) => set('delivery', v as DeliveryPreference)}
                options={DeliveryPreferences.map((d) => ({
                  value: d,
                  label: t(d === 'EITHER' ? 'delivery.EITHER' : `delivery.${d}`),
                }))}
              />
            )}
            <TextField
              type="date"
              label={t('needForm.requiredBy')}
              optional
              value={form.requiredBy}
              onChange={(v) => set('requiredBy', v)}
            />
          </div>
        </section>

        <section className="formsec" aria-labelledby="nf-4">
          <h2 id="nf-4">
            <span className="formsec__n" aria-hidden="true">
              4
            </span>
            {t('needForm.s4')}
          </h2>
          <CheckField
            label={t('needForm.visibility')}
            checked={form.matchedOnly}
            onChange={(v) => set('matchedOnly', v)}
          />
          <p className="field__hint">{t('needForm.contact')}</p>
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
          <div className="formactions">
            {isDraft ? (
              <>
                <button type="submit" className="btn" disabled={save.isPending}>
                  {save.isPending
                    ? t('needForm.publishing')
                    : t(need ? 'needForm.savePublish' : 'needForm.publish')}
                </button>
                <button
                  type="button"
                  className="btn btn--outline"
                  disabled={save.isPending}
                  onClick={submit(false)}
                >
                  {t('needForm.saveDraft')}
                </button>
              </>
            ) : (
              <button type="submit" className="btn" disabled={save.isPending}>
                {save.isPending ? t('common.saving') : t('needForm.saveChanges')}
              </button>
            )}
          </div>
        </section>
      </form>
    </div>
  );
}
