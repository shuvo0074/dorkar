import 'react-native-get-random-values';

/**
 * What Hermes lacks and the shared web helpers use: crypto.randomUUID (idempotency keys, chat
 * client ids) and Intl.RelativeTimeFormat ("in 3 days", "2 hours ago").
 */
const g = globalThis as unknown as { crypto: Crypto; Intl: typeof Intl };

if (!g.crypto.randomUUID) {
  g.crypto.randomUUID = () => {
    const b = g.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(
      20,
    )}` as ReturnType<Crypto['randomUUID']>;
  };
}

type Unit = 'second' | 'minute' | 'hour' | 'day';
const words: Record<'en' | 'bn', Record<Unit, string>> = {
  en: { second: 'second', minute: 'minute', hour: 'hour', day: 'day' },
  bn: { second: 'সেকেন্ড', minute: 'মিনিট', hour: 'ঘণ্টা', day: 'দিন' },
};

export class SimpleRelativeTimeFormat {
  private readonly lang: 'en' | 'bn';
  private readonly numbers: Intl.NumberFormat;
  constructor(locale: string) {
    this.lang = locale.startsWith('bn') ? 'bn' : 'en';
    this.numbers = new Intl.NumberFormat(locale);
  }
  format(value: number, unit: Unit): string {
    const n = Math.abs(value);
    const past = value < 0 || Object.is(value, -0);
    if (this.lang === 'bn') {
      if (unit === 'day' && n === 0) return 'আজ';
      if (unit === 'day' && n === 1) return past ? 'গতকাল' : 'আগামীকাল';
      if (unit === 'second' && n === 0) return 'এখন';
      const span = `${this.numbers.format(n)} ${words.bn[unit]}`;
      return past ? `${span} আগে` : `${span} পরে`;
    }
    if (unit === 'day' && n === 0) return 'today';
    if (unit === 'day' && n === 1) return past ? 'yesterday' : 'tomorrow';
    if (unit === 'second' && n === 0) return 'now';
    const span = `${this.numbers.format(n)} ${words.en[unit]}${n === 1 ? '' : 's'}`;
    return past ? `${span} ago` : `in ${span}`;
  }
}

if (!g.Intl.RelativeTimeFormat) {
  (g.Intl as unknown as { RelativeTimeFormat: unknown }).RelativeTimeFormat =
    SimpleRelativeTimeFormat;
}
