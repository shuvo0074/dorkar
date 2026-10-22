import type { NeedMode } from '@dorkar/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { Money } from '../../lib/money';
import { modeIcon } from './ModeKey';
import { needCode } from './modes';

/** Until categories carry their own icons, each mode has one. */
export const modeGlyph: Record<NeedMode, () => ReactNode> = modeIcon;

export interface EntryNeed {
  id: string;
  mode: NeedMode;
  title: string;
  budget: { max: Money | null };
  location?: { district: string; area?: string | null };
  district?: string;
}

/** One need as a row: mode tile, code, headline, place and budget. */
export function NeedEntry({ need }: { need: EntryNeed }) {
  const { t } = useI18n();
  const f = useFormat();
  const ModeIcon = modeIcon[need.mode];
  const district = need.location?.district ?? need.district;
  const meta = [
    district && f.district(district),
    need.budget.max ? t('entry.budget', { amount: f.taka(need.budget.max) }) : t('entry.open'),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="entry">
      <Link to={`/needs/${need.id}`} className="entry__link">
        <div className="entry__art" data-mode={need.mode}>
          <ModeIcon />
        </div>
        <span className="entry__code code">{needCode(need)}</span>
        <span className="entry__title">{need.title}</span>
        <span className="entry__meta">{meta}</span>
      </Link>
    </li>
  );
}
