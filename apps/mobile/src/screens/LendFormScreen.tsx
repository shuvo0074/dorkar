import { Conditions, findContactInfo, type Condition, type District } from '@dorkar/contracts';
import { categoryOptions, useCategories } from '@web/features/catalog/categories';
import { lendingApi, type LendItemDetail, type LendItemInput } from '@web/features/lending/api';
import { useFormat } from '@web/lib/format';
import { asciiDigits, parseTaka, poisha, takaInput } from '@web/lib/money';
import { useIntent } from '@web/lib/useIntent';
import { StackActions } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { c } from '../design/tokens';
import { FormSection, PageError, PageSkeleton, useTitle } from '../features/catalog/pageParts';
import { errorMessage } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { SignedInOnly } from '../nav/SignedInOnly';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import {
  CheckField,
  DistrictField,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '../ui/Fields';
import { Alert, Screen } from '../ui/Layout';
import { PhotoPicker } from '../ui/PhotoPicker';
import { T } from '../ui/Text';

export default function LendFormScreen() {
  const id = useParams<'LendForm'>()?.id;
  return <SignedInOnly>{id ? <Edit id={id} /> : <LendForm />}</SignedInOnly>;
}

function Edit({ id }: { id: string }) {
  const item = useQuery({ queryKey: ['lend-items', id], queryFn: () => lendingApi.item(id) });
  if (item.isPending) return <PageSkeleton />;
  if (item.isError) return <PageError onRetry={() => void item.refetch()} />;
  return <LendForm item={item.data} />;
}

function LendForm({ item }: { item?: LendItemDetail }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
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
  useTitle(t(item ? 'lendForm.editTitle' : 'lendForm.title'));
  const save = useMutation({
    mutationFn: (input: LendItemInput) =>
      item ? lendingApi.update(item.id, input) : lendingApi.create(input, intent.key),
    onSuccess: (saved) => {
      intent.renew();
      void qc.invalidateQueries({ queryKey: ['lend-items'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      // Back from the result never lands on the finished form.
      if (item) nav.navigate('LendItem', { id: saved.id }, { pop: true });
      else nav.dispatch(StackActions.replace('LendItem', { id: saved.id }));
    },
  });

  const submit = () => {
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
    <Screen>
      <T color={c.inkSoft}>{t('lendForm.lede')}</T>
      <FormSection n={1} title={t('lendForm.s1')}>
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
        <SelectField
          label={t('lend.condition')}
          value={condition}
          onChange={(v) => setCondition(v as Condition)}
          options={Conditions.map((x) => ({ value: x, label: f.condition(x) }))}
        />
        <DistrictField
          label={t('place.district')}
          value={district}
          onChange={setDistrict}
          placeholder={t('place.pick')}
          error={errors['district']}
        />
        <PhotoPicker purpose="LEND_ITEM" value={photos} onChange={setPhotos} max={8} />
      </FormSection>
      <FormSection n={2} title={t('lendForm.s2')}>
        <MoneyField
          label={t('lend.deposit')}
          optional
          value={deposit}
          onChange={setDeposit}
          error={errors['deposit']}
        />
        <TextField
          label={t('lendForm.maxDays')}
          keyboard="number-pad"
          value={maxDays}
          onChange={setMaxDays}
          error={errors['maxDays']}
        />
      </FormSection>
      <FormSection n={3} title={t('lendForm.s3')}>
        <CheckField label={t('lendForm.nid')} value={nid} onChange={setNid} />
        <TextField
          label={t('lendForm.minDeals')}
          keyboard="number-pad"
          value={minDeals}
          onChange={setMinDeals}
          error={errors['minDeals']}
        />
        <TextField
          label={t('lendForm.minRating')}
          optional
          keyboard="decimal-pad"
          value={minRating}
          onChange={setMinRating}
          error={errors['minRating']}
        />
        {Object.values(errors).some(Boolean) ? <Alert message={t('needForm.fix')} /> : null}
        {save.isError ? <Alert message={errorMessage(save.error, t)} /> : null}
        <Button
          block
          busy={save.isPending}
          label={
            save.isPending ? t('common.saving') : t(item ? 'lendForm.saveChanges' : 'lendForm.save')
          }
          onPress={submit}
        />
      </FormSection>
    </Screen>
  );
}
