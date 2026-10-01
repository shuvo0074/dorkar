import { useRef, type KeyboardEvent } from 'react';
import { Biro } from '../../components/ui/Biro';
import { useI18n } from '../../lib/i18n';
import { modeLetter, Modes, type Mode } from './modes';

/**
 * The mode picker drawn as the catalog's hall key. A radio group: arrow keys move the choice,
 * and the chosen key gets circled in ballpoint.
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
            <span className="modekey__letter" aria-hidden="true">
              {modeLetter[m]}
            </span>
            <span className="modekey__name">{t(`mode.${m}`)}</span>
            {checked && <Biro draw key={m} tilt={-2} />}
          </button>
        );
      })}
    </div>
  );
}
