import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { BorrowIcon, BuyIcon, HireIcon, RentIcon, SourceIcon } from '../../components/icons/icons';
import { useI18n } from '../../lib/i18n';
import { Modes, type Mode } from './modes';

export const modeIcon: Record<Mode, () => ReactNode> = {
  BUY: BuyIcon,
  RENT: RentIcon,
  BORROW: BorrowIcon,
  HIRE: HireIcon,
  SOURCE: SourceIcon,
};

/**
 * The mode picker as a row of service tiles. A radio group: arrow keys move the choice, and the
 * chosen tile fills with the accent.
 */
export function ModeKey({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (e: KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + Modes.length) % Modes.length;
    onChange(Modes[next]!);
    refs.current[next]?.focus();
  };

  return (
    <div className="modekey" role="radiogroup" aria-label={t('home.mode')}>
      {Modes.map((m, i) => {
        const checked = m === value;
        const ModeIcon = modeIcon[m];
        return (
          <button
            key={m}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="modekey__item"
            onClick={() => onChange(m)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="modekey__icon">
              <ModeIcon />
            </span>
            <span className="modekey__name">{t(`mode.${m}`)}</span>
          </button>
        );
      })}
    </div>
  );
}
