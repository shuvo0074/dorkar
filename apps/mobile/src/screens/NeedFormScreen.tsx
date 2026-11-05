import {
  Conditions,
  findContactInfo,
  type Condition,
  type District,
  type NeedMode,
} from '@dorkar/contracts';
import { categoryOptions, useCategories, useCategory } from '@web/features/catalog/categories';
import {
  DeliveryPreferences,
  needsApi,
  type DeliveryPreference,
  type Need,
  type NeedInput,
} from '@web/features/needs/api';
import { parseTaka, poisha, takaInput } from '@web/lib/money';
import { StackActions } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { c } from '../design/tokens';
import {
  AttributeFields,
  draftFromValues,
  readAttributes,
  type AttributeDraft,
} from '../features/catalog/AttributeFields';
import { clearDraft, loadDraft, splitDraft } from '../features/needs/draft';
import { ModeTiles } from '../design/ModeTiles';
import {
  NeedTermsFields,
  readNeedTerms,
  termsDraftFrom,
  type TermsDraft,
} from '../features/needs/NeedTerms';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useNav, useParams } from '../nav/routes';
import { SignedInOnly } from '../nav/SignedInOnly';
import { Button, LinkText } from '../ui/Button';
import {
  CheckField,
  Chips,
  DateField,
  DistrictField,
  FieldShell,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../ui/Fields';
import { Alert, Card, LoadError, Screen, Section, Stack } from '../ui/Layout';
import { Skeleton } from '../ui/Misc';
import { T } from '../ui/Text';

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

export default function NeedFormScreen() {
  const id = useParams<'NeedForm'>()?.id;
  return <SignedInOnly>{id ? <EditNeed id={id} /> : <NewNeed />}</SignedInOnly>;
}

function NewNeed() {
  const [initial] = useState(fromComposer);
  return <NeedForm initial={initial} />;
}

function EditNeed({ id }: { id: string }) {
  const need = useQuery({ queryKey: ['needs', id], queryFn: () => needsApi.get(id) });
  if (need.isPending) {
    return (
      <Screen>
        <Skeleton rows={6} />
      </Screen>
    );
  }
  if (need.isError) {
    return (
      <Screen>
        <LoadError onRetry={() => void need.refetch()} />
      </Screen>
    );
  }
  return <NeedForm initial={fromNeed(need.data)} need={need.data} />;
}

type Errors = Partial<Record<string, string>>;

function NeedForm({ initial, need }: { initial: Form; need?: Need }) {
  const { t, num } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const category = useCategory(form.categoryId || undefined);
  const locked = Boolean(need && need.offerCount > 0);

  useLayoutEffect(() => {
    if (need) nav.setOptions({ title: t('needForm.editTitle') });
  }, [need, nav, t]);

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
      const params = {
        id: saved.id,
        notice: saved.status === 'DRAFT' ? ('draft' as const) : ('posted' as const),
      };
      // Back from the need must not land on the form again.
      if (need) nav.navigate('Need', params, { pop: true });
      else nav.dispatch(StackActions.replace('Need', params));
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
    if (Object.keys(e).length > 0) return null;
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

  const submit = (publish: boolean) => () => {
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
    <Screen>
      <Stack>
        {need ? (
          <LinkText
            label={need.title}
            onPress={() => nav.navigate('Need', { id: need.id }, { pop: true })}
          />
        ) : null}
        <T color={c.inkSoft}>{t('needForm.lede')}</T>
      </Stack>

      <Card>
        <Section title={`${num(1)}. ${t('needForm.s1')}`}>
          {locked ? (
            <Alert tone="info" message={t('needForm.modeLocked')} />
          ) : (
            <ModeTiles
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
        </Section>
      </Card>

      <Card>
        <Section title={`${num(2)}. ${t('needForm.s2')}`}>
          <TextField
            label={t('needForm.quantity')}
            keyboard="number-pad"
            value={form.quantity}
            onChange={(v) => set('quantity', v.replace(/\D/g, ''))}
            error={err('quantity')}
          />
          {form.mode !== 'HIRE' ? (
            <FieldShell label={t('needForm.conditions')} hint={t('needForm.conditionsHint')}>
              <Chips
                label={t('needForm.conditions')}
                value={form.conditions}
                onChange={(v) => {
                  const cond = v as Condition;
                  set(
                    'conditions',
                    form.conditions.includes(cond)
                      ? form.conditions.filter((x) => x !== cond)
                      : [...form.conditions, cond],
                  );
                }}
                options={Conditions.map((x) => ({ value: x, label: t(`condition.${x}`) }))}
              />
            </FieldShell>
          ) : null}
          <NeedTermsFields
            mode={form.mode}
            draft={form.terms}
            onChange={(v) => set('terms', v)}
            errors={termErrors}
          />
          {category.data ? (
            <AttributeFields
              schema={category.data.attributeSchema}
              draft={form.attributes}
              onChange={(v) => set('attributes', v)}
              errors={attrErrors}
              partial
            />
          ) : null}
        </Section>
      </Card>

      <Card>
        <Section title={`${num(3)}. ${t('needForm.s3')}`}>
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
          <T v="small" color={c.inkSoft}>
            {t('needForm.budgetHint')}
          </T>
          <CheckField
            label={t('needForm.flexible')}
            value={form.flexible}
            onChange={(v) => set('flexible', v)}
          />
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
          {form.mode !== 'HIRE' ? (
            <SelectField
              label={t('needForm.delivery')}
              value={form.delivery}
              onChange={(v) => set('delivery', v as DeliveryPreference)}
              options={DeliveryPreferences.map((d) => ({
                value: d,
                label: t(d === 'EITHER' ? 'delivery.EITHER' : `delivery.${d}`),
              }))}
            />
          ) : null}
          <DateField
            label={t('needForm.requiredBy')}
            optional
            value={form.requiredBy}
            onChange={(v) => set('requiredBy', v)}
          />
        </Section>
      </Card>

      <Card>
        <Section title={`${num(4)}. ${t('needForm.s4')}`}>
          <CheckField
            label={t('needForm.visibility')}
            value={form.matchedOnly}
            onChange={(v) => set('matchedOnly', v)}
          />
          <T v="small" color={c.inkSoft}>
            {t('needForm.contact')}
          </T>
          {Object.values(errors).some(Boolean) ? <Alert message={t('needForm.fix')} /> : null}
          {save.isError ? <Alert message={errorMessage(save.error, t)} /> : null}
          {isDraft ? (
            <>
              <Button
                block
                busy={save.isPending}
                label={
                  save.isPending
                    ? t('needForm.publishing')
                    : t(need ? 'needForm.savePublish' : 'needForm.publish')
                }
                onPress={submit(true)}
              />
              <Button
                block
                kind="outline"
                disabled={save.isPending}
                label={t('needForm.saveDraft')}
                onPress={submit(false)}
              />
            </>
          ) : (
            <Button
              block
              busy={save.isPending}
              label={save.isPending ? t('common.saving') : t('needForm.saveChanges')}
              onPress={submit(false)}
            />
          )}
        </Section>
      </Card>
    </Screen>
  );
}
