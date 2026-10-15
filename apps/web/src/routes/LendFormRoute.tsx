import { Conditions, findContactInfo, type Condition, type District } from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  CheckField,
  DistrictField,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/forms/fields';
import { AlertIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { categoryOptions, useCategories } from '../features/catalog/categories';
import { lendingApi, type LendItemDetail, type LendItemInput } from '../features/lending/api';
import { PhotoPicker } from '../features/media/Photos';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits, parseTaka, poisha, takaInput } from '../lib/money';
import { useIntent } from '../lib/useIntent';

export default function LendFormRoute() {
  const { id } = useParams();
  return (
    <SignedInOnly from={id ? `/lend/${id}/edit` : '/lend/new'}>
      {id ? <Edit id={id} /> : <LendForm />}
    </SignedInOnly>
  );
}

function Edit({ id }: { id: string }) {
  const item = useQuery({ queryKey: ['lend-items', id], queryFn: () => lendingApi.item(id) });
  if (item.isPending) return <LedgerSkeleton rows={6} />;
  if (item.isError) return <LoadError onRetry={() => void item.refetch()} />;
  return <LendForm item={item.data} />;
}

function LendForm({ item }: { item?: LendItemDetail }) {
  const { t } = useI18n();
  const f = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intent = useIntent();
  const categories = useCategories();
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [condition, setCondition] = useState<Condition>(item?.condition ?? 'USED');
  const [district, setDistrict] = useState<string>(item?.district ?? '');
  const [photos, setPhotos] = useState<string[]>(item?.mediaIds ?? []);
  const [deposit, setDeposit] = useState(takaInput(item?.deposit));
  const [maxDays, setMaxDays] = useState(String(item?.maxLoanDays ?? 7));
  const [nid, setNid] = useState(item?.requirements.nidVerified ?? false);
  const [minDeals, setMinDeals] = useState(String(item?.requirements.minCompletedDeals ?? 0));
  const [minRating, setMinRating] = useState(
    typeof item?.requirements.minRating === 'number' ? String(item.requirements.minRating) : '',
  );
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: (input: LendItemInput) =>
      item ? lendingApi.update(item.id, input) : lendingApi.create(input, intent.key),
    onSuccess: (saved) => {
      intent.renew();
      void qc.invalidateQueries({ queryKey: ['lend-items'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/lend/${saved.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(asciiDigits(maxDays));
    const deals = Number(asciiDigits(minDeals || '0'));
    const rating = minRating.trim() ? Number(asciiDigits(minRating)) : null;
    const dep = deposit.trim() ? parseTaka(deposit) : null;
    const errs = {
      title:
        title.trim().length < 3
          ? t('listingForm.titleShort')
          : findContactInfo(title)
            ? t('needForm.contact')
            : undefined,
      description: findContactInfo(description) ? t('needForm.contact') : undefined,
      categoryId: categoryId ? undefined : t('common.required'),
      district: district ? undefined : t('common.required'),
      maxDays:
        Number.isInteger(days) && days >= 1 && days <= 365
          ? undefined
          : t('common.range', { min: 1, max: 365 }),
      minDeals: Number.isInteger(deals) && deals >= 0 ? undefined : t('common.badNumber'),
      minRating:
        rating === null || (rating >= 1 && rating <= 5)
          ? undefined
          : t('common.range', { min: 1, max: 5 }),
      deposit: deposit.trim() && dep === null ? t('common.badAmount') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      categoryId,
      title: title.trim(),
      description: description.trim(),
      condition,
      district: district as District,
      mediaIds: photos,
      deposit: dep === null ? null : poisha(dep),
      maxLoanDays: days,
      requirements: { nidVerified: nid, minCompletedDeals: deals, minRating: rating },
    });
  };

  return (
    <div className="formpage">
      <header className="desk__head">
        <p className="crumb">
          {item ? (
            <Link to={`/lend/${item.id}`}>{item.title}</Link>
          ) : (
            <Link to="/lend">{t('lend.title')}</Link>
          )}
        </p>
        <h1 tabIndex={-1}>{t(item ? 'lendForm.editTitle' : 'lendForm.title')}</h1>
        <p className="desk__lede">{t('lendForm.lede')}</p>
      </header>
      <form onSubmit={submit} noValidate>
        <section className="formsec" aria-labelledby="lf1">
          <h2 id="lf1">
            <span className="formsec__n" aria-hidden="true">
              1
            </span>
            {t('lendForm.s1')}
          </h2>
          <TextField
            label={t('listingForm.titleField')}
            value={title}
            onChange={setTitle}
            maxLength={120}
            error={errors['title']}
          />
          <TextAreaField
            label={t('listingForm.description')}
            optional
            value={description}
            onChange={setDescription}
            maxLength={2000}
            error={errors['description']}
          />
          <SelectField
            label={t('needForm.category')}
            value={categoryId}
            onChange={setCategoryId}
            placeholder={t('needForm.categoryPick')}
            options={categoryOptions(categories.flat)}
            error={errors['categoryId']}
          />
          <div className="pair">
            <SelectField
              label={t('lend.condition')}
              value={condition}
              onChange={(v) => setCondition(v as Condition)}
              options={Conditions.map((c) => ({ value: c, label: f.condition(c) }))}
            />
            <DistrictField
              label={t('place.district')}
              value={district}
              onChange={setDistrict}
              placeholder={t('place.pick')}
              error={errors['district']}
            />
          </div>
          <PhotoPicker purpose="LEND_ITEM" value={photos} onChange={setPhotos} max={8} />
        </section>
        <section className="formsec" aria-labelledby="lf2">
          <h2 id="lf2">
            <span className="formsec__n" aria-hidden="true">
              2
            </span>
            {t('lendForm.s2')}
          </h2>
          <div className="pair">
            <MoneyField
              label={t('lend.deposit')}
              optional
              value={deposit}
              onChange={setDeposit}
              error={errors['deposit']}
            />
            <TextField
              label={t('lendForm.maxDays')}
              inputMode="numeric"
              value={maxDays}
              onChange={setMaxDays}
              error={errors['maxDays']}
            />
          </div>
        </section>
        <section className="formsec" aria-labelledby="lf3">
          <h2 id="lf3">
            <span className="formsec__n" aria-hidden="true">
              3
            </span>
            {t('lendForm.s3')}
          </h2>
          <CheckField label={t('lendForm.nid')} checked={nid} onChange={setNid} />
          <div className="pair">
            <TextField
              label={t('lendForm.minDeals')}
              inputMode="numeric"
              value={minDeals}
              onChange={setMinDeals}
              error={errors['minDeals']}
            />
            <TextField
              label={t('lendForm.minRating')}
              optional
              inputMode="decimal"
              value={minRating}
              onChange={setMinRating}
              error={errors['minRating']}
            />
          </div>
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
            <button type="submit" className="btn" disabled={save.isPending}>
              {save.isPending
                ? t('common.saving')
                : t(item ? 'lendForm.saveChanges' : 'lendForm.save')}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
