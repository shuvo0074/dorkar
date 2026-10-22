import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';

const phoneQuery = '(max-width: 899px)';

/**
 * A titled filter card. On phones the form starts folded behind a Show filters button so the
 * results are the first thing on screen; wider screens always show it.
 */
export function FilterPanel({
  titleId,
  title,
  children,
}: {
  titleId: string;
  title: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const [phone] = useState(() => window.matchMedia(phoneQuery).matches);
  const [open, setOpen] = useState(!phone);
  return (
    <section className="panel filters" aria-labelledby={titleId}>
      <div className="filters__bar">
        <h2 id={titleId} className="filters__title">
          {title}
        </h2>
        {phone && (
          <button
            type="button"
            className="btn btn--outline btn--small"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t('common.hideFilters') : t('common.showFilters')}
          </button>
        )}
      </div>
      <div id={bodyId} className="filters__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
