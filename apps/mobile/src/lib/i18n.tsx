import { en } from '@web/lib/messages';
import { bn } from '@web/lib/messages/bn';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { nativeBn, nativeEn } from './nativeMessages';
import { kv } from './storage';

/**
 * The native twin of apps/web/src/lib/i18n.tsx, over the same message tables. Bangla is bundled
 * rather than loaded on demand; the choice is kept on the device.
 */
const enTable = { ...en, ...nativeEn };
const bnTable = { ...bn, ...nativeBn };
export type MessageKey = keyof typeof enTable;
type Table = Record<MessageKey, string>;
export type Lang = 'en' | 'bn';

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  has: (key: string) => key is MessageKey;
  num: (n: number) => string;
  date: (d: string | Date, style?: 'short' | 'long') => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(
    () => forced ?? (kv.get('dorkar.lang') === 'bn' ? 'bn' : 'en'),
  );
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    kv.set('dorkar.lang', next);
  }, []);

  const value = useMemo<I18n>(() => {
    const table: Table = lang === 'bn' ? (bnTable as Table) : enTable;
    const locale = lang === 'bn' ? 'bn-BD' : 'en-GB';
    const numberFmt = new Intl.NumberFormat(locale);
    return {
      lang,
      setLang,
      t: (key, vars) => {
        let s: string = table[key];
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, typeof v === 'number' ? numberFmt.format(v) : v);
          }
        }
        return s;
      },
      has: (key): key is MessageKey => key in table,
      num: (n) => numberFmt.format(n),
      date: (d, style = 'long') =>
        new Intl.DateTimeFormat(locale, {
          dateStyle: style === 'long' ? 'medium' : 'short',
          ...(style === 'long' ? { timeStyle: 'short' } : {}),
        }).format(typeof d === 'string' ? new Date(d) : d),
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
