import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './messages';

/**
 * Two languages, one product. English is the default (product decision); Bangla is complete,
 * not a partial translation. Keys are typed from the English tables in messages/, so a missing
 * Bangla string is a compile error. Bangla loads on first use: English readers never pay for it.
 */
export type MessageKey = keyof typeof en;
type Table = Record<MessageKey, string>;

let bangla: Table | null = null;
let loading: Promise<Table> | null = null;
function loadBangla(): Promise<Table> {
  loading ??= import('./messages/bn').then((m) => (bangla = m.bn));
  return loading;
}

export type Lang = 'en' | 'bn';
const STORAGE_KEY = 'dorkar.lang';

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Whether a dynamic key (e.g. `state.${status}`) has a translation. */
  has: (key: string) => key is MessageKey;
  /** Locale-aware number (Bengali digits in Bangla). */
  num: (n: number) => string;
  date: (d: string | Date, style?: 'short' | 'long') => string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'bn') return saved;
  } catch {
    // storage unavailable: default
  }
  return 'en';
}

// A returning Bangla reader: start fetching the tables before the first render asks for them.
if (typeof window !== 'undefined' && initialLang() === 'bn') void loadBangla();

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forced ?? initialLang);
  const [bn, setBn] = useState<Table | null>(bangla);

  useEffect(() => {
    if (lang === 'bn' && !bn) void loadBangla().then(setBn);
  }, [lang, bn]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    const apply = () => {
      setLangState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // per-viewer convenience only
      }
    };
    // Switch only once Bangla has arrived, so the page never blanks or loses what was typed.
    if (next === 'bn' && !bangla)
      void loadBangla().then((table) => {
        setBn(table);
        apply();
      });
    else apply();
  }, []);

  const table: Table | null = lang === 'bn' ? bn : en;
  const value = useMemo<I18n | null>(() => {
    if (!table) return null;
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
  }, [lang, setLang, table]);

  // A returning Bangla reader waits for one small request rather than seeing English first.
  if (!value) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
