import {
  DeliveryModes,
  findContactInfo,
  SellerRoles,
  type DeliveryMode,
  type District,
  type SellerRole,
} from '@dorkar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CheckField,
  CheckGroup,
  DistrictField,
  Segmented,
  TextAreaField,
  TextField,
} from '../components/forms/fields';
import { AlertIcon, NoteIcon } from '../components/glyphs/glyphs';
import { LedgerSkeleton, LoadError, SignedInOnly } from '../components/ui/Status';
import { profileApi, type MyProfile, type SellerCapabilities } from '../features/account/api';
import { useCategories } from '../features/catalog/categories';
import { PhotoPicker } from '../features/media/Photos';
import { errorMessage, ruleOf } from '../lib/errors';
import { useFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { asciiDigits } from '../lib/money';

export default function ProfileSettingsRoute() {
  return (
    <SignedInOnly from="/account/profile">
      <Loader />
    </SignedInOnly>
  );
}

function Loader() {
  const { t } = useI18n();
  const me = useQuery({ queryKey: ['me', 'profile'], queryFn: profileApi.get });
  if (me.isPending) return <LedgerSkeleton rows={6} />;
  if (me.isError) return <LoadError onRetry={() => void me.refetch()} />;
  return (
    <div className="formpage">
      <header className="desk__head">
        <p className="crumb">
          <Link to="/account">{t('account.title')}</Link>
        </p>
        <h1 tabIndex={-1}>{t('me.title')}</h1>
        <p className="desk__lede">{t('me.lede')}</p>
        <div className="desk__meta">
          <Link to={`/users/${me.data.id}`}>{t('me.viewPublic')}</Link>
        </div>
      </header>
      <PublicProfile profile={me.data} />
      <Selling profile={me.data} />
      <Verification />
    </div>
  );
}

function Saved({ text }: { text: string }) {
  return (
    <p className="alert alert--note" role="status">
      <NoteIcon />
      <span>{text}</span>
    </p>
  );
}

function Failed({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <p className="alert" role="alert">
      <AlertIcon />
      <span>{errorMessage(error, t)}</span>
    </p>
  );
}

function PublicProfile({ profile }: { profile: MyProfile }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(profile.displayName);
  const [type, setType] = useState(profile.userType);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [district, setDistrict] = useState<string>(profile.district ?? '');
  const [area, setArea] = useState(profile.area ?? '');
  const [locale, setLocale] = useState(profile.locale);
  const [avatar, setAvatar] = useState<string[]>(
    profile.avatarMediaId ? [profile.avatarMediaId] : [],
  );
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: profileApi.update,
    onSuccess: (p) => {
      qc.setQueryData(['me', 'profile'], p);
      void qc.invalidateQueries({ queryKey: ['users', p.id] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const errs = {
      name:
        n.length < 2 || n.length > 60
          ? t('me.nameShort')
          : findContactInfo(n)
            ? t('needForm.contact')
            : undefined,
      bio: findContactInfo(bio) ? t('needForm.contact') : undefined,
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate({
      displayName: n,
      userType: type,
      bio: bio.trim() || null,
      district: (district || null) as District | null,
      area: area.trim() || null,
      locale,
      avatarMediaId: avatar[0] ?? null,
    });
  };

  return (
    <form className="formsec" onSubmit={submit} noValidate aria-labelledby="pp-title">
      <h2 id="pp-title">{t('me.public')}</h2>
      <TextField
        label={t('me.displayName')}
        hint={t('me.displayNameHint')}
        value={name}
        onChange={setName}
        maxLength={60}
        error={errors['name']}
      />
      <Segmented
        legend={t('me.userType')}
        name="user-type"
        value={type}
        onChange={setType}
        options={[
          { value: 'INDIVIDUAL', label: t('profile.individual') },
          { value: 'BUSINESS', label: t('profile.business') },
        ]}
      />
      <TextAreaField
        label={t('me.bio')}
        optional
        hint={t('me.bioHint')}
        value={bio}
        onChange={setBio}
        maxLength={500}
        rows={3}
        error={errors['bio']}
      />
      <div className="pair">
        <DistrictField
          label={t('place.district')}
          optional
          value={district}
          onChange={setDistrict}
          placeholder={t('place.pick')}
        />
        <TextField
          label={t('place.area')}
          optional
          value={area}
          onChange={setArea}
          maxLength={80}
        />
      </div>
      <Segmented
        legend={t('me.language')}
        name="locale"
        value={locale}
        onChange={setLocale}
        options={[
          { value: 'en', label: 'English' },
          { value: 'bn', label: 'বাংলা' },
        ]}
      />
      <PhotoPicker purpose="AVATAR" value={avatar} onChange={setAvatar} max={1} />
      {save.isSuccess && <Saved text={t('me.saved')} />}
      {save.isError && <Failed error={save.error} />}
      <div className="formactions">
        <button type="submit" className="btn" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('me.save')}
        </button>
      </div>
    </form>
  );
}

function Selling({ profile }: { profile: MyProfile }) {
  const { t } = useI18n();
  const f = useFormat();
  const categories = useCategories();
  const qc = useQueryClient();
  const initial: SellerCapabilities = profile.capabilities ?? {
    roles: ['SELLER'],
    categoryIds: [],
    serviceDistricts: [],
    deliveryModes: [],
    active: false,
  };
  const [caps, setCaps] = useState(initial);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string>();
  const set = <K extends keyof SellerCapabilities>(k: K, v: SellerCapabilities[K]) =>
    setCaps((c) => ({ ...c, [k]: v }));
  const save = useMutation({
    mutationFn: profileApi.setCapabilities,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'profile'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (caps.categoryIds.length > 30) return setError(t('seller.tooMany'));
    setError(undefined);
    save.mutate(caps);
  };

  return (
    <form className="formsec" onSubmit={submit} noValidate aria-labelledby="sell-title">
      <h2 id="sell-title">{t('seller.title')}</h2>
      <p className="muted">{t('seller.lede')}</p>
      <CheckField
        label={t('seller.active')}
        checked={caps.active}
        onChange={(v) => set('active', v)}
      />
      <CheckGroup<SellerRole>
        legend={t('seller.roles')}
        options={SellerRoles.map((r) => ({ value: r, label: t(`role.${r}`) }))}
        value={caps.roles}
        onChange={(v) => set('roles', v)}
      />
      <CheckGroup<string>
        legend={t('seller.categories')}
        hint={t('seller.categoriesHint')}
        options={categories.flat.map((c) => ({ value: c.id, label: c.path }))}
        value={caps.categoryIds}
        onChange={(v) => set('categoryIds', v)}
        error={error}
      />
      <fieldset className="checks">
        <legend className="label">{t('seller.districts')}</legend>
        {caps.serviceDistricts.length > 0 && (
          <ul className="chips">
            {caps.serviceDistricts.map((d) => (
              <li key={d}>
                <span>{f.district(d)}</span>
                <button
                  type="button"
                  aria-label={`${t('common.clear')} ${f.district(d)}`}
                  onClick={() =>
                    set(
                      'serviceDistricts',
                      caps.serviceDistricts.filter((x) => x !== d),
                    )
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <DistrictField
          compact
          label={t('place.district')}
          value={pick}
          onChange={(v) => {
            setPick('');
            if (v && !caps.serviceDistricts.includes(v as District))
              set('serviceDistricts', [...caps.serviceDistricts, v as District]);
          }}
          placeholder={t('place.pick')}
        />
        <p className="field__hint">{t('seller.districtsHint')}</p>
      </fieldset>
      <CheckGroup<DeliveryMode>
        legend={t('seller.delivery')}
        options={DeliveryModes.map((d) => ({ value: d, label: f.delivery(d) }))}
        value={caps.deliveryModes}
        onChange={(v) => set('deliveryModes', v)}
      />
      {save.isSuccess && <Saved text={t('seller.saved')} />}
      {save.isError && <Failed error={save.error} />}
      <div className="formactions">
        <button type="submit" className="btn" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('seller.save')}
        </button>
      </div>
    </form>
  );
}

function Verification() {
  const { t, date } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['me', 'verifications'], queryFn: profileApi.verifications });
  const [nid, setNid] = useState('');
  const [dob, setDob] = useState('');
  const [fullName, setFullName] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const send = useMutation({
    mutationFn: profileApi.submitNid,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'verifications'] }),
  });
  const nidState = list.data?.find((v) => v.kind === 'NID');
  const canSubmit =
    !nidState ||
    nidState.status === 'REJECTED' ||
    nidState.status === 'EXPIRED' ||
    nidState.status === 'REVOKED';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const digits = asciiDigits(nid).replace(/\D/g, '');
    const errs = {
      nid: [10, 13, 17].includes(digits.length) ? undefined : t('verify.badNid'),
      dob: dob ? undefined : t('common.required'),
      fullName: fullName.trim().length >= 2 ? undefined : t('common.required'),
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    send.mutate({ nidNumber: digits, dateOfBirth: dob, fullName: fullName.trim() });
  };
  const underage = ruleOf(send.error) === 'UNDERAGE';

  return (
    <section className="formsec" aria-labelledby="verify-title">
      <h2 id="verify-title">{t('verify.title')}</h2>
      <p className="muted">{t('verify.lede')}</p>
      {list.isPending && <LedgerSkeleton rows={2} />}
      {list.data && (
        <ul className="statelist">
          {(['PHONE', 'NID'] as const).map((kind) => {
            const v = list.data.find((x) => x.kind === kind);
            return (
              <li key={kind}>
                <span>{t(`verify.kind.${kind}`)}</span>
                <span className="code">
                  {v ? f.state(v.status) : t('verify.none')}
                  {v?.verifiedAt &&
                    ` · ${t('verify.since', { when: date(v.verifiedAt, 'short') })}`}
                  {v?.nidLast4 && ` · ${t('verify.ending', { last4: v.nidLast4 })}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {send.isSuccess ? (
        <Saved text={t('verify.sent')} />
      ) : (
        canSubmit &&
        list.data && (
          <form className="counter" onSubmit={submit} noValidate aria-labelledby="nid-title">
            <h3 id="nid-title">{t('verify.nidTitle')}</h3>
            <TextField
              label={t('verify.nidNumber')}
              hint={t('verify.nidNumberHint')}
              inputMode="numeric"
              autoComplete="off"
              value={nid}
              onChange={setNid}
              maxLength={40}
              error={errors['nid']}
            />
            <div className="pair">
              <TextField
                type="date"
                label={t('verify.dob')}
                value={dob}
                onChange={setDob}
                error={errors['dob']}
              />
              <TextField
                label={t('verify.fullName')}
                value={fullName}
                onChange={setFullName}
                maxLength={200}
                autoComplete="name"
                error={errors['fullName']}
              />
            </div>
            {send.isError &&
              (underage ? (
                <p className="alert" role="alert">
                  <AlertIcon />
                  <span>{t('verify.underage')}</span>
                </p>
              ) : (
                <Failed error={send.error} />
              ))}
            <div className="formactions">
              <button type="submit" className="btn btn--small" disabled={send.isPending}>
                {t('verify.send')}
              </button>
            </div>
          </form>
        )
      )}
    </section>
  );
}
