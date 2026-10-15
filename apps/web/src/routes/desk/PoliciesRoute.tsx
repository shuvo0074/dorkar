import { NeedModes, Roles, type NeedMode } from '@dorkar/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  CheckField,
  CheckGroup,
  MoneyField,
  SelectField,
  TextField,
} from '../../components/forms/fields';
import { AlertIcon, NoteIcon } from '../../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { useCan } from '../../features/auth/permissions';
import { categoryOptions, useCategories } from '../../features/catalog/categories';
import {
  deskApi,
  PolicyActions,
  PolicyScopes,
  Requirements,
  type Policy,
  type PolicyAction,
  type PolicyInput,
  type PolicyScope,
  type Requirement,
} from '../../features/desk/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { asciiDigits, parseTaka, takaInput } from '../../lib/money';

type Kind = 'PHONE' | 'NID' | 'BUSINESS';

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export default function PoliciesRoute() {
  return (
    <StaffPage needs="policy:read" from="/desk/policies">
      <Policies />
    </StaffPage>
  );
}

function Policies() {
  const { t } = useI18n();
  const can = useCan();
  const writable = can('policy:write');
  const [editing, setEditing] = useState<Policy | 'new' | null>(null);
  const list = usePaged(['desk', 'policies'], (cursor) => deskApi.policies(cursor));

  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('pol.title')}</h1>
        <p className="desk__lede">{t('pol.lede')}</p>
        <div className="desk__meta">
          {writable ? (
            editing === null && (
              <button type="button" className="btn btn--small" onClick={() => setEditing('new')}>
                {t('pol.new')}
              </button>
            )
          ) : (
            <span className="muted">{t('pol.readOnly')}</span>
          )}
        </div>
      </header>
      {editing && (
        <PolicyForm
          key={editing === 'new' ? 'new' : editing.id}
          policy={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      )}
      <section aria-labelledby="pol-list">
        <div className="section-head">
          <h2 id="pol-list">{t('pol.title')}</h2>
        </div>
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('pol.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((p) => (
              <PolicyRow key={p.id} p={p} writable={writable} onEdit={() => setEditing(p)} />
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}

function useSelectorText() {
  const { t } = useI18n();
  const f = useFormat();
  const cats = useCategories();
  return (p: Pick<Policy, 'scope' | 'selector'>) => {
    const s = p.selector;
    switch (p.scope) {
      case 'ROLE':
        return str(s['role'], '');
      case 'CATEGORY':
        return cats.name(str(s['categoryId'], '')) || str(s['categoryId'], '');
      case 'MODE':
        return t(`mode.${str(s['mode']) as NeedMode}`);
      case 'VALUE_THRESHOLD':
        return typeof s['minAmount'] === 'number' ? f.taka(s['minAmount']) : '';
      default:
        return '';
    }
  };
}

function PolicyRow({ p, writable, onEdit }: { p: Policy; writable: boolean; onEdit: () => void }) {
  const { t, num } = useI18n();
  const qc = useQueryClient();
  const selector = useSelectorText();
  const off = useMutation({
    mutationFn: () => deskApi.deactivatePolicy(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['desk', 'policies'] }),
  });
  return (
    <li>
      <span className="ledger__art code">{num(p.priority)}</span>
      <div>
        <span className="ledger__title">{p.name}</span>
        <p className="ledger__meta">
          {[
            t(`pol.act.${p.action}`),
            `${t(`pol.scope.${p.scope}`)}${selector(p) ? `: ${selector(p)}` : ''}`,
            `${t(`pol.req.${p.requirement}`)}${p.kinds.length ? ` (${p.kinds.map((k) => t(`verify.kind.${k}`)).join(', ')})` : ''}`,
            !p.active && t('lend.inactive'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {writable && (
        <div className="ledger__btns">
          <button type="button" className="btn btn--outline btn--small" onClick={onEdit}>
            {t('common.edit')}
          </button>
          {p.active && (
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={off.isPending}
              onClick={() => off.mutate()}
            >
              {t('pol.deactivate')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PolicyForm({ policy, onDone }: { policy?: Policy | undefined; onDone: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const cats = useCategories();
  const [name, setName] = useState(policy?.name ?? '');
  const [action, setAction] = useState<PolicyAction>(policy?.action ?? 'OFFER_SUBMIT');
  const [scope, setScope] = useState<PolicyScope>(policy?.scope ?? 'GLOBAL');
  const [requirement, setRequirement] = useState<Requirement>(policy?.requirement ?? 'REQUIRED');
  const [kinds, setKinds] = useState<Kind[]>(policy?.kinds ?? ['NID']);
  const [priority, setPriority] = useState(String(policy?.priority ?? 0));
  const [active, setActive] = useState(policy?.active ?? true);
  const sel = policy?.selector ?? {};
  const [role, setRole] = useState(str(sel['role'], 'MEMBER'));
  const [categoryId, setCategoryId] = useState(str(sel['categoryId'], ''));
  const [mode, setMode] = useState(str(sel['mode'], 'BUY'));
  const [minAmount, setMinAmount] = useState(
    typeof sel['minAmount'] === 'number' ? takaInput(sel['minAmount']) : '',
  );
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (input: PolicyInput) =>
      policy
        ? deskApi.updatePolicy(policy.id, { ...input, version: policy.version })
        : deskApi.createPolicy(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['desk', 'policies'] });
      onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let selector: Record<string, unknown> = {};
    if (scope === 'ROLE') selector = { role };
    if (scope === 'CATEGORY') {
      if (!categoryId) return setError(t('common.required'));
      selector = { categoryId };
    }
    if (scope === 'MODE') selector = { mode };
    if (scope === 'VALUE_THRESHOLD') {
      const p = parseTaka(minAmount);
      if (p === null) return setError(t('common.badAmount'));
      selector = { minAmount: p };
    }
    if (name.trim().length < 2) return setError(t('common.required'));
    setError(undefined);
    save.mutate({
      name: name.trim(),
      action,
      scope,
      selector,
      requirement,
      kinds,
      active,
      priority: Number(asciiDigits(priority)) || 0,
    });
  };

  return (
    <form className="panel formsec" onSubmit={submit} noValidate aria-label={t('pol.new')}>
      <TextField label={t('pol.name')} value={name} onChange={setName} maxLength={120} />
      <div className="pair">
        <SelectField
          label={t('pol.action')}
          value={action}
          onChange={(v) => setAction(v as PolicyAction)}
          options={PolicyActions.map((a) => ({ value: a, label: t(`pol.act.${a}`) }))}
        />
        <SelectField
          label={t('pol.scope')}
          value={scope}
          onChange={(v) => setScope(v as PolicyScope)}
          options={PolicyScopes.map((s) => ({ value: s, label: t(`pol.scope.${s}`) }))}
        />
      </div>
      {scope === 'ROLE' && (
        <SelectField
          label={t('pol.selector.role')}
          value={role}
          onChange={setRole}
          options={Roles.map((r) => ({ value: r, label: r }))}
        />
      )}
      {scope === 'CATEGORY' && (
        <SelectField
          label={t('pol.selector.categoryId')}
          value={categoryId}
          onChange={setCategoryId}
          placeholder={t('needForm.categoryPick')}
          options={categoryOptions(cats.flat)}
        />
      )}
      {scope === 'MODE' && (
        <SelectField
          label={t('pol.selector.mode')}
          value={mode}
          onChange={setMode}
          options={NeedModes.map((m) => ({ value: m, label: t(`mode.${m}`) }))}
        />
      )}
      {scope === 'VALUE_THRESHOLD' && (
        <MoneyField label={t('pol.selector.minAmount')} value={minAmount} onChange={setMinAmount} />
      )}
      <div className="pair">
        <SelectField
          label={t('pol.requirement')}
          value={requirement}
          onChange={(v) => setRequirement(v as Requirement)}
          options={Requirements.map((r) => ({ value: r, label: t(`pol.req.${r}`) }))}
        />
        <TextField
          label={t('pol.priority')}
          inputMode="numeric"
          value={priority}
          onChange={setPriority}
        />
      </div>
      <CheckGroup<Kind>
        legend={t('pol.kinds')}
        options={(['PHONE', 'NID', 'BUSINESS'] as const).map((k) => ({
          value: k,
          label: t(`verify.kind.${k}`),
        }))}
        value={kinds}
        onChange={setKinds}
      />
      <CheckField label={t('pol.active')} checked={active} onChange={setActive} />
      {(error || save.isError) && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{error ?? errorMessage(save.error, t)}</span>
        </p>
      )}
      {save.isSuccess && (
        <p className="alert alert--note">
          <NoteIcon />
          <span>{t('staff.done')}</span>
        </p>
      )}
      <div className="formactions">
        <button type="submit" className="btn btn--small" disabled={save.isPending}>
          {t('pol.save')}
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
