import { useMemo } from 'react';
import { useFormat as useBaseFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { BN_ACTIVITY } from './activity-labels';

export { addDays, dhakaDay, shortCode } from '../../lib/format';

/** The shared formatter plus activity labels in the page language. */
export function useFormat() {
  const base = useBaseFormat();
  const { lang } = useI18n();
  return useMemo(
    () => ({
      ...base,
      /** An activity label in the page language, or the server's English label. */
      activity: (action: string, label: string): { text: string; lang: 'bn' | 'en' } => {
        const bn = lang === 'bn' ? BN_ACTIVITY[action] : undefined;
        return bn ? { text: bn, lang: 'bn' } : { text: label, lang: 'en' };
      },
    }),
    [base, lang],
  );
}
