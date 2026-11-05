import {
  Conditions,
  DeliveryModes,
  findContactInfo,
  type Condition,
  type DeliveryMode,
  type District,
} from '@dorkar/contracts';
import {
  catalogApi,
  ListingKinds,
  PriceUnits,
  type Listing,
  type ListingInput,
  type ListingKind,
  type PriceUnit,
} from '@web/features/catalog/api';
import { categoryOptions, useCategories, useCategory } from '@web/features/catalog/categories';
import { useFormat } from '@web/lib/format';
import { asciiDigits, parseTaka, poisha, takaInput } from '@web/lib/money';
import { StackActions } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import {
  AttributeFields,
  draftFromValues,
  readAttributes,
  type AttributeDraft,
} from '../features/catalog/AttributeFields';
import { FormSection, PageError, PageSkeleton, useTitle } from '../features/catalog/pageParts';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import {
  Chips,
  DistrictField,
  FieldShell,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../ui/Fields';
import { Alert, Screen, Stack } from '../ui/Layout';
import { PhotoPicker } from '../ui/PhotoPicker';
import { T } from '../ui/Text';

interface Form {
  kind: ListingKind;
  title: string;
  description: string;
  categoryId: string;
  attributes: AttributeDraft;
  condition: Condition | '';
  price: string;
  priceUnit: PriceUnit;
  quantity: string;
  district: string;
  area: string;
  deliveryModes: DeliveryMode[];
  mediaIds: string[];
}

const blank: Form = {
  kind: 'PRODUCT',
  title: '',
  description: '',
  categoryId: '',
  attributes: {},
  condition: '',
  price: '',
  priceUnit: 'TOTAL',
  quantity: '1',
  district: '',
  area: '',
  deliveryModes: [],
  mediaIds: [],
};

const fromListing = (l: Listing): Form => ({
  kind: l.kind,
  title: l.title,
  description: l.description,
  categoryId: l.categoryId,
  attributes: draftFromValues(l.attributes),
  condition: l.condition ?? '',
  price: takaInput(l.price),
  priceUnit: l.priceUnit,
  quantity: String(l.quantityAvailable),
  district: l.district,
  area: l.area ?? '',
  deliveryModes: l.deliveryModes,
  mediaIds: l.mediaIds,
});

export default function ListingFormScreen() {
  const id = useParams<'ListingForm'>()?.id;
  return (
    <SignedInOnly>{id ? <EditListing id={id} /> : <ListingForm initial={blank} />}</SignedInOnly>
  );
}

function EditListing({ id }: { id: string }) {
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  if (listing.isPending) return <PageSkeleton />;
  if (listing.isError) return <PageError onRetry={() => void listing.refetch()} />;
  return <ListingForm initial={fromListing(listing.data)} listing={listing.data} />;
}

function ListingForm({ initial, listing }: { initial: Form; listing?: Listing }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const qc = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const category = useCategory(form.categoryId || undefined);
  useTitle(t(listing ? 'listingForm.editTitle' : 'listingForm.title'));

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = useMutation({
    mutationFn: async ({ input, publish }: { input: ListingInput; publish: boolean }) => {
      const saved = listing
        ? await catalogApi.updateListing(listing.id, input)
        : await catalogApi.createListing(input);
      return publish && saved.status === 'DRAFT'
        ? catalogApi.listingCommand(saved.id, 'publish')
        : saved;
    },
    onSuccess: (saved) => {
      qc.setQueryData(['listings', saved.id], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
      // Back from the result never lands on the finished form.
      if (listing) nav.navigate('Listing', { id: saved.id, notice: 'saved' }, { pop: true });
      else nav.dispatch(StackActions.replace('Listing', { id: saved.id, notice: 'created' }));
    },
  });

  const submit = (publish: boolean) => {
    const errs: Record<string, string | undefined> = {};
    const title = form.title.trim();
    if (title.length < 3) errs['title'] = t('listingForm.titleShort');
    if (!form.categoryId) errs['categoryId'] = t('common.required');
    if (!form.district) errs['district'] = t('common.required');
    const price = parseTaka(form.price);
    if (price === null) errs['price'] = t('common.badAmount');
    const quantity = Number(asciiDigits(form.quantity));
    if (!Number.isInteger(quantity) || quantity < 0)
      errs['quantity'] = t('listingForm.badQuantity');
    if (findContactInfo(title)) errs['title'] = t('needForm.contact');
    if (findContactInfo(form.description)) errs['description'] = t('needForm.contact');
    const schema = category.data?.attributeSchema;
    const attrs = schema ? readAttributes(schema, form.attributes) : null;
    for (const [k, msg] of Object.entries(attrs?.errors ?? {})) errs[`attr.${k}`] = msg;
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      publish,
      input: {
        kind: form.kind,
        categoryId: form.categoryId,
        title,
        description: form.description.trim(),
        condition: form.kind === 'SERVICE' ? null : form.condition || null,
        price: poisha(price!),
        priceUnit: form.priceUnit,
        quantityAvailable: quantity,
        attributes: attrs?.value ?? {},
        district: form.district as District,
        area: form.area.trim() || null,
        deliveryModes: form.deliveryModes,
        mediaIds: form.mediaIds,
      },
    });
  };

  const attrErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k, v]) => k.startsWith('attr.') && v)
      .map(([k, v]) => [k.slice(5), v!]),
  );
  const isDraft = !listing || listing.status === 'DRAFT';
  const toggleDelivery = (v: string) => {
    const d = v as DeliveryMode;
    set(
      'deliveryModes',
      form.deliveryModes.includes(d)
        ? form.deliveryModes.filter((x) => x !== d)
        : [...form.deliveryModes, d],
    );
  };

  return (
    <Screen>
      <T color={c.inkSoft}>{t('listingForm.lede')}</T>

      <FormSection n={1} title={t('listingForm.s1')}>
        <FieldShell label={t('listingForm.kind')}>
          <Chips
            label={t('listingForm.kind')}
            value={form.kind}
            onChange={(k) => set('kind', k as ListingKind)}
            options={ListingKinds.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
          />
        </FieldShell>
        <TextField
          label={t('listingForm.titleField')}
          hint={t('listingForm.titleHint')}
          value={form.title}
          onChange={(v) => set('title', v)}
          maxLength={120}
          error={errors['title']}
        />
        <TextAreaField
          label={t('listingForm.description')}
          optional
          value={form.description}
          onChange={(v) => set('description', v)}
          maxLength={4000}
          error={errors['description']}
        />
        <SelectField
          label={t('needForm.category')}
          value={form.categoryId}
          onChange={(v) => setForm((x) => ({ ...x, categoryId: v, attributes: {} }))}
          placeholder={categories.isPending ? t('loading') : t('needForm.categoryPick')}
          options={categoryOptions(categories.flat)}
          error={errors['categoryId']}
        />
        {category.data ? (
          <AttributeFields
            schema={category.data.attributeSchema}
            draft={form.attributes}
            onChange={(v) => set('attributes', v)}
            errors={attrErrors}
          />
        ) : null}
        {form.kind !== 'SERVICE' ? (
          <SelectField
            label={t('listing.condition')}
            value={form.condition}
            onChange={(v) => set('condition', v as Condition | '')}
            placeholder={t('offerForm.conditionPick')}
            options={Conditions.map((x) => ({ value: x, label: f.condition(x) }))}
          />
        ) : null}
      </FormSection>

      <FormSection n={2} title={t('listingForm.s2')}>
        <MoneyField
          label={t('listingForm.price')}
          value={form.price}
          onChange={(v) => set('price', v)}
          error={errors['price']}
        />
        <SelectField
          label={t('listingForm.unit')}
          value={form.priceUnit}
          onChange={(v) => set('priceUnit', v as PriceUnit)}
          options={PriceUnits.map((u) => ({ value: u, label: t(`listingForm.unit.${u}`) }))}
        />
        <TextField
          label={t('listingForm.quantity')}
          keyboard="number-pad"
          value={form.quantity}
          onChange={(v) => set('quantity', v)}
          error={errors['quantity']}
        />
      </FormSection>

      <FormSection n={3} title={t('listingForm.s3')}>
        <DistrictField
          label={t('place.district')}
          value={form.district}
          onChange={(v) => set('district', v)}
          placeholder={t('place.pick')}
          error={errors['district']}
        />
        <TextField
          label={t('place.area')}
          optional
          hint={t('place.areaHint')}
          value={form.area}
          onChange={(v) => set('area', v)}
          maxLength={80}
        />
        <FieldShell label={t('listingForm.deliveryModes')}>
          <Chips
            label={t('listingForm.deliveryModes')}
            options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
            value={form.deliveryModes}
            onChange={toggleDelivery}
          />
        </FieldShell>
      </FormSection>

      <FormSection n={4} title={t('listingForm.s4')}>
        <PhotoPicker
          purpose="LISTING"
          value={form.mediaIds}
          onChange={(v) => set('mediaIds', v)}
          max={10}
        />
        <T v="small" color={c.inkSoft}>
          {t('needForm.contact')}
        </T>
        {Object.values(errors).some(Boolean) ? <Alert message={t('needForm.fix')} /> : null}
        {save.isError ? <Alert message={errorMessage(save.error, t)} /> : null}
        <Stack>
          {isDraft ? (
            <>
              <Button
                block
                busy={save.isPending}
                label={save.isPending ? t('common.saving') : t('listingForm.saveAndPublish')}
                onPress={() => submit(true)}
              />
              <Button
                block
                kind="outline"
                disabled={save.isPending}
                label={t('listingForm.save')}
                onPress={() => submit(false)}
              />
            </>
          ) : (
            <Button
              block
              busy={save.isPending}
              label={save.isPending ? t('common.saving') : t('listingForm.saveChanges')}
              onPress={() => submit(false)}
            />
          )}
        </Stack>
      </FormSection>
    </Screen>
  );
}
