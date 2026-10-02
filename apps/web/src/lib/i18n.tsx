import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Two languages, one product. English is the default (product decision); Bangla is complete,
 * not a partial translation. Keys are typed from the English table, so a missing Bangla string
 * is a compile error.
 */
const en = {
  'brand.latin': 'Dorkar',
  'brand.bangla': 'দরকার',
  'brand.tagline': 'Tell us what you need. The market comes to you.',
  'nav.catalog': 'Catalog',
  'nav.post': 'Post a need',
  'nav.account': 'Account',
  'nav.signIn': 'Sign in',
  'nav.main': 'Main',
  'lang.other': 'বাংলা',
  'lang.switch': 'Switch to Bangla',
  skip: 'Skip to content',
  loading: 'Loading…',

  'home.title': 'What do you need?',
  'home.lede':
    'Describe it once. Sellers, shops and service providers who can help answer with offers. You compare and choose.',
  'home.mode': 'I want to',
  'home.field': 'Your need',
  'home.hint': 'What, where, when, and your budget.',
  'home.post': 'Post need',
  'home.browse': 'Browse listings',
  'home.soon': 'Soon',
  'home.signInToPost': 'Sign in with your mobile number to post. It takes a minute.',
  'home.draftSaved':
    'Posting opens with the next release. Your draft is saved on this device, so it will be waiting.',
  'home.empty': 'Write what you need first.',
  'mode.BUY': 'Buy',
  'mode.RENT': 'Rent',
  'mode.BORROW': 'Borrow',
  'mode.HIRE': 'Hire',
  'mode.SOURCE': 'Source',
  'mode.BUY.example': 'Used iPhone 15 Pro, 256GB, Dhaka, up to ৳80,000',
  'mode.RENT.example': 'Microbus for a 3-day Cox’s Bazar trip, from Uttara',
  'mode.BORROW.example': 'A tall ladder for this weekend, Mirpur 10',
  'mode.HIRE.example': 'Wedding photographer in Sylhet on 15 December',
  'mode.SOURCE.example': '500 jute bags with our logo, by end of month',
  'examples.title': 'What needs look like',
  'examples.note': 'Examples only. Real needs appear here when posting opens.',
  'key.title': 'Mode key',
  'how.title': 'How it works',
  'how.1.title': 'Post your need',
  'how.1.body': 'Say what you want, where, by when, and what you can spend.',
  'how.2.title': 'Offers come to you',
  'how.2.body': 'People who can help send a price and terms. You do not chase anyone.',
  'how.3.title': 'Choose, meet, review',
  'how.3.body': 'Compare, negotiate, pay cash on handover, then rate each other.',
  privacy: 'Your phone number stays private. People reach you through Dorkar.',

  'signin.title': 'Sign in',
  'signin.lede': 'No password. We send a 6-digit code to your phone by SMS.',
  'signin.phone': 'Mobile number',
  'signin.phoneHint': 'Any Bangladeshi mobile, e.g. 017XXXXXXXX',
  'signin.send': 'Send code',
  'signin.sending': 'Sending…',
  'signin.code': '6-digit code',
  'signin.sentTo': 'We sent a code to {phone}.',
  'signin.change': 'Change number',
  'signin.resendIn': 'New code in {s}s',
  'signin.resend': 'Send a new code',
  'signin.verify': 'Sign in',
  'signin.verifying': 'Checking…',
  'signin.done': 'Signed in',
  'signin.privacy': 'We only use your number to sign you in. Nobody else sees it.',

  'error.INVALID_PHONE': 'That isn’t a Bangladeshi mobile number. Check the digits and try again.',
  'error.OTP_INVALID': 'That code didn’t work or has expired. Check the SMS, or send a new code.',
  'error.RATE_LIMITED': 'Too many tries. Wait {s} seconds, then try again.',
  'error.ACCOUNT_SUSPENDED': 'This account is suspended. Contact Dorkar support to restore it.',
  'error.NETWORK': 'No connection. Check your internet and try again.',
  'error.UNAVAILABLE': 'Dorkar can’t send codes right now. Try again in a minute.',
  'error.generic': 'Something went wrong. Try again.',

  'account.title': 'Your account',
  'account.member': 'Member',
  'account.phone': 'Mobile',
  'account.status': 'Status',
  'account.status.ACTIVE': 'Active',
  'account.status.SUSPENDED': 'Suspended',
  'account.status.BANNED': 'Banned',
  'account.status.DELETED': 'Deleted',
  'account.joined': 'Joined',
  'account.roles': 'Roles',
  'account.welcome': 'Welcome to Dorkar. Your account is ready.',
  'sessions.title': 'Where you’re signed in',
  'sessions.current': 'This browser',
  'sessions.started': 'Signed in',
  'sessions.refreshed': 'Last active',
  'sessions.expires': 'Expires',
  'devices.title': 'Devices',
  'devices.current': 'This device',
  'devices.lastSeen': 'Last seen',
  'devices.trust.UNTRUSTED': 'New device',
  'devices.trust.TRUSTED': 'Trusted',
  'devices.trust.REVOKED': 'Signed out',
  'devices.revoke': 'Sign out',
  'devices.confirm': 'Sign out {name}? It will need a new code to sign in again.',
  'devices.confirmYes': 'Yes, sign it out',
  'devices.cancel': 'Keep it',
  'devices.empty': 'No devices.',
  'account.signOut': 'Sign out',
  'account.signOutAll': 'Sign out everywhere',
  'account.signOutAllHelp': 'Ends every session on every device, including this one.',
  'account.signOutAllConfirm': 'Sign out of all devices?',
  'account.error': 'Couldn’t load your account.',
  'account.retry': 'Try again',

  'notFound.title': 'Not in the catalog',
  'notFound.body': 'This page doesn’t exist, or it moved.',
  'notFound.back': 'Back to the catalog',
} as const;

export type MessageKey = keyof typeof en;
type Table = Record<MessageKey, string>;

const bn: Table = {
  'brand.latin': 'Dorkar',
  'brand.bangla': 'দরকার',
  'brand.tagline': 'কী দরকার, বলুন। বাজার নিজেই আসবে আপনার কাছে।',
  'nav.catalog': 'ক্যাটালগ',
  'nav.post': 'দরকার পোস্ট',
  'nav.account': 'অ্যাকাউন্ট',
  'nav.signIn': 'সাইন ইন',
  'nav.main': 'প্রধান',
  'lang.other': 'English',
  'lang.switch': 'ইংরেজিতে দেখুন',
  skip: 'মূল অংশে যান',
  loading: 'লোড হচ্ছে…',

  'home.title': 'কী দরকার?',
  'home.lede':
    'একবার লিখুন। যাঁরা দিতে পারবেন, সেই বিক্রেতা, দোকান আর সেবাদাতারা অফার পাঠাবেন। আপনি মিলিয়ে দেখে বেছে নেবেন।',
  'home.mode': 'আমি চাই',
  'home.field': 'আপনার দরকার',
  'home.hint': 'কী, কোথায়, কবে, আর আপনার বাজেট।',
  'home.post': 'পোস্ট করুন',
  'home.browse': 'লিস্টিং দেখুন',
  'home.soon': 'শিগগিরই',
  'home.signInToPost': 'পোস্ট করতে মোবাইল নম্বর দিয়ে সাইন ইন করুন। এক মিনিট লাগবে।',
  'home.draftSaved': 'পরের আপডেটে পোস্ট করা চালু হবে। আপনার খসড়া এই ডিভাইসে রাখা আছে।',
  'home.empty': 'আগে লিখুন, কী দরকার।',
  'mode.BUY': 'কিনব',
  'mode.RENT': 'ভাড়া নেব',
  'mode.BORROW': 'ধার নেব',
  'mode.HIRE': 'লোক লাগবে',
  'mode.SOURCE': 'সংগ্রহ',
  'mode.BUY.example': 'পুরোনো iPhone 15 Pro, 256GB, ঢাকা, ৳৮০,০০০-এর মধ্যে',
  'mode.RENT.example': 'কক্সবাজার যাওয়ার জন্য মাইক্রোবাস, ৩ দিন, উত্তরা থেকে',
  'mode.BORROW.example': 'এই সপ্তাহান্তের জন্য একটা লম্বা মই, মিরপুর ১০',
  'mode.HIRE.example': '১৫ ডিসেম্বর সিলেটে বিয়ের ফটোগ্রাফার',
  'mode.SOURCE.example': 'আমাদের লোগোসহ ৫০০টি পাটের ব্যাগ, মাসের শেষে',
  'examples.title': 'দরকারগুলো দেখতে যেমন',
  'examples.note': 'শুধু উদাহরণ। পোস্ট চালু হলে আসল দরকারগুলো এখানে দেখা যাবে।',
  'key.title': 'মোড',
  'how.title': 'কীভাবে কাজ করে',
  'how.1.title': 'দরকার পোস্ট করুন',
  'how.1.body': 'কী চান, কোথায়, কবের মধ্যে, আর কত খরচ করতে পারবেন।',
  'how.2.title': 'অফার আসবে আপনার কাছে',
  'how.2.body': 'যাঁরা পারবেন, তাঁরা দাম আর শর্ত পাঠাবেন। কাউকে খুঁজতে হবে না।',
  'how.3.title': 'বেছে নিন, দেখা করুন, রিভিউ দিন',
  'how.3.body': 'মিলিয়ে দেখুন, দরদাম করুন, হাতে পেয়ে নগদ দিন, তারপর রেটিং দিন।',
  privacy: 'আপনার ফোন নম্বর গোপন থাকে। সবাই Dorkar-এর মাধ্যমে যোগাযোগ করবেন।',

  'signin.title': 'সাইন ইন',
  'signin.lede': 'পাসওয়ার্ড লাগবে না। আপনার ফোনে এসএমএসে ৬ সংখ্যার কোড যাবে।',
  'signin.phone': 'মোবাইল নম্বর',
  'signin.phoneHint': 'যেকোনো বাংলাদেশি মোবাইল, যেমন ০১৭XXXXXXXX',
  'signin.send': 'কোড পাঠান',
  'signin.sending': 'পাঠানো হচ্ছে…',
  'signin.code': '৬ সংখ্যার কোড',
  'signin.sentTo': '{phone} নম্বরে কোড পাঠানো হয়েছে।',
  'signin.change': 'নম্বর বদলান',
  'signin.resendIn': '{s} সেকেন্ড পর নতুন কোড',
  'signin.resend': 'নতুন কোড পাঠান',
  'signin.verify': 'সাইন ইন',
  'signin.verifying': 'যাচাই হচ্ছে…',
  'signin.done': 'সাইন ইন হয়েছে',
  'signin.privacy': 'নম্বরটি শুধু সাইন ইনের জন্য। অন্য কেউ দেখতে পাবে না।',

  'error.INVALID_PHONE': 'এটি বাংলাদেশি মোবাইল নম্বর নয়। সংখ্যাগুলো দেখে আবার চেষ্টা করুন।',
  'error.OTP_INVALID': 'কোডটি মেলেনি বা মেয়াদ শেষ। এসএমএস দেখুন, অথবা নতুন কোড নিন।',
  'error.RATE_LIMITED': 'অনেকবার চেষ্টা হয়েছে। {s} সেকেন্ড পর আবার চেষ্টা করুন।',
  'error.ACCOUNT_SUSPENDED': 'এই অ্যাকাউন্ট স্থগিত। চালু করতে Dorkar সাপোর্টে যোগাযোগ করুন।',
  'error.NETWORK': 'ইন্টারনেট সংযোগ নেই। সংযোগ দেখে আবার চেষ্টা করুন।',
  'error.UNAVAILABLE': 'এই মুহূর্তে কোড পাঠানো যাচ্ছে না। এক মিনিট পর চেষ্টা করুন।',
  'error.generic': 'কিছু একটা গোলমাল হয়েছে। আবার চেষ্টা করুন।',

  'account.title': 'আপনার অ্যাকাউন্ট',
  'account.member': 'সদস্য',
  'account.phone': 'মোবাইল',
  'account.status': 'অবস্থা',
  'account.status.ACTIVE': 'সক্রিয়',
  'account.status.SUSPENDED': 'স্থগিত',
  'account.status.BANNED': 'নিষিদ্ধ',
  'account.status.DELETED': 'মুছে ফেলা',
  'account.joined': 'যোগ দিয়েছেন',
  'account.roles': 'ভূমিকা',
  'account.welcome': 'Dorkar-এ স্বাগতম। আপনার অ্যাকাউন্ট তৈরি।',
  'sessions.title': 'যেখানে সাইন ইন আছেন',
  'sessions.current': 'এই ব্রাউজার',
  'sessions.started': 'সাইন ইন',
  'sessions.refreshed': 'শেষ সক্রিয়',
  'sessions.expires': 'মেয়াদ',
  'devices.title': 'ডিভাইস',
  'devices.current': 'এই ডিভাইস',
  'devices.lastSeen': 'শেষ দেখা',
  'devices.trust.UNTRUSTED': 'নতুন ডিভাইস',
  'devices.trust.TRUSTED': 'বিশ্বস্ত',
  'devices.trust.REVOKED': 'সাইন আউট',
  'devices.revoke': 'সাইন আউট',
  'devices.confirm': '{name} সাইন আউট করবেন? আবার ঢুকতে নতুন কোড লাগবে।',
  'devices.confirmYes': 'হ্যাঁ, সাইন আউট',
  'devices.cancel': 'থাক',
  'devices.empty': 'কোনো ডিভাইস নেই।',
  'account.signOut': 'সাইন আউট',
  'account.signOutAll': 'সব জায়গা থেকে সাইন আউট',
  'account.signOutAllHelp': 'এই ডিভাইসসহ সব ডিভাইসের সব সেশন বন্ধ হবে।',
  'account.signOutAllConfirm': 'সব ডিভাইস থেকে সাইন আউট করবেন?',
  'account.error': 'অ্যাকাউন্ট লোড করা যায়নি।',
  'account.retry': 'আবার চেষ্টা করুন',

  'notFound.title': 'ক্যাটালগে নেই',
  'notFound.body': 'এই পাতাটি নেই, অথবা সরানো হয়েছে।',
  'notFound.back': 'ক্যাটালগে ফিরুন',
};

export type Lang = 'en' | 'bn';
const tables: Record<Lang, Table> = { en, bn };
const STORAGE_KEY = 'dorkar.lang';

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
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

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forced ?? initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const locale = lang === 'bn' ? 'bn-BD' : 'en-GB';
    const numberFmt = new Intl.NumberFormat(locale);
    return {
      lang,
      setLang,
      t: (key, vars) => {
        let s: string = tables[lang][key];
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, typeof v === 'number' ? numberFmt.format(v) : v);
          }
        }
        return s;
      },
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
