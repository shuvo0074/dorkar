import {
  Conditions,
  DeliveryModes,
  findContactInfo,
  type Condition,
  type DeliveryMode,
  type District,
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
  CheckGroup,
  DistrictField,
  MoneyField,
  Segmented,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/forms/fields';
import { AlertIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import {
  catalogApi,
  ListingKinds,
  PriceUnits,
  type Listing,
  type ListingInput,
  type ListingKind,
  type PriceUnit,
} from '../features/catalog/api';
import { categoryOptions, useCategories, useCategory } from '../features/catalog/categories';
import { PhotoPicker } from '../features/media/Photos';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha, takaInput } from '../lib/money';

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

export default function ListingFormRoute() {
  const { id } = useParams();
  return (
    <SignedInOnly from={id ? `/listings/${id}/edit` : '/listings/new'}>
      {id ? <EditListing id={id} /> : <ListingForm initial={blank} />}
    </SignedInOnly>
  );
}

function EditListing({ id }: { id: string }) {
  const listing = useQuery({ queryKey: ['listings', id], queryFn: () => catalogApi.listing(id) });
  if (listing.isPending) return <LedgerSkeleton rows={6} />;
  if (listing.isError) return <LoadError onRetry={() => void listing.refetch()} />;
  return <ListingForm initial={fromListing(listing.data)} listing={listing.data} />;
}

function ListingForm({ initial, listing }: { initial: Form; listing?: Listing }) {
  const { t } = useI18n();
  const f = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const category = useCategory(form.categoryId || undefined);

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
      void navigate(`/listings/${saved.id}`, {
        state: { notice: listing ? 'saved' : 'created' },
      });
    },
  });

  const submit = (publish: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
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
    if (Object.values(errs).some(Boolean)) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('.listingform [aria-invalid="true"]')?.focus(),
      );
      return;
    }
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
  const section = (n: number, id: string, title: string) => (
    <h2 id={id}>
      <span className="formsec__n" aria-hidden="true">
        {n}
      </span>
      {title}
    </h2>
  );

  return (
    <div className="formpage listingform">
      <header className="desk__head">
        <p className="crumb">
          {listing ? (
            <Link to={`/listings/${listing.id}`}>{listing.title}</Link>
          ) : (
            <Link to="/my/listings">{t('myListings.title')}</Link>
          )}
        </p>
        <h1 tabIndex={-1}>{t(listing ? 'listingForm.editTitle' : 'listingForm.title')}</h1>
        <p className="desk__lede">{t('listingForm.lede')}</p>
      </header>

      <form onSubmit={submit(isDraft)} noValidate>
        <section className="formsec" aria-labelledby="lf-1">
          {section(1, 'lf-1', t('listingForm.s1'))}
          <Segmented
            legend={t('listingForm.kind')}
            name="listing-kind"
            value={form.kind}
            onChange={(k) => set('kind', k)}
            options={ListingKinds.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
          />
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
          {category.data && (
            <AttributeFields
              schema={category.data.attributeSchema}
              draft={form.attributes}
              onChange={(v) => set('attributes', v)}
              errors={attrErrors}
            />
          )}
          {form.kind !== 'SERVICE' && (
            <SelectField
              label={t('listing.condition')}
              value={form.condition}
              onChange={(v) => set('condition', v as Condition | '')}
              placeholder={t('offerForm.conditionPick')}
              options={Conditions.map((c) => ({ value: c, label: f.condition(c) }))}
            />
          )}
        </section>

        <section className="formsec" aria-labelledby="lf-2">
          {section(2, 'lf-2', t('listingForm.s2'))}
          <div className="pair">
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
          </div>
          <TextField
            label={t('listingForm.quantity')}
            inputMode="numeric"
            value={form.quantity}
            onChange={(v) => set('quantity', v)}
            error={errors['quantity']}
          />
        </section>

        <section className="formsec" aria-labelledby="lf-3">
          {section(3, 'lf-3', t('listingForm.s3'))}
          <div className="pair">
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
          </div>
          <CheckGroup
            legend={t('listingForm.deliveryModes')}
            options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
            value={form.deliveryModes}
            onChange={(v) => set('deliveryModes', v)}
          />
        </section>

        <section className="formsec" aria-labelledby="lf-4">
          {section(4, 'lf-4', t('listingForm.s4'))}
          <PhotoPicker
            purpose="LISTING"
            value={form.mediaIds}
            onChange={(v) => set('mediaIds', v)}
            max={10}
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
                  {save.isPending ? t('common.saving') : t('listingForm.saveAndPublish')}
                </button>
                <button
                  type="button"
                  className="btn btn--outline"
                  disabled={save.isPending}
                  onClick={submit(false)}
                >
                  {t('listingForm.save')}
                </button>
              </>
            ) : (
              <button type="submit" className="btn" disabled={save.isPending}>
                {save.isPending ? t('common.saving') : t('listingForm.saveChanges')}
              </button>
            )}
          </div>
        </section>
      </form>
    </div>
  );
}
