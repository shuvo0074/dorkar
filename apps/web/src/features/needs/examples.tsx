import type { ReactNode } from 'react';
import {
  AircoGlyph,
  BagGlyph,
  BicycleGlyph,
  BooksGlyph,
  BusGlyph,
  CameraGlyph,
  ChairsGlyph,
  CookerGlyph,
  DeskGlyph,
  FanGlyph,
  HangerGlyph,
  LadderGlyph,
  PhoneGlyph,
  SewingGlyph,
  ShirtGlyph,
} from '../../components/glyphs/glyphs';
import { modeLetter, type Mode } from './modes';

/**
 * Illustrative needs that show what a post looks like. Clearly labelled as examples in the UI:
 * no real users, prices or places are implied.
 */
export interface ExampleNeed {
  mode: Mode;
  n: number;
  glyph: ReactNode;
  circled?: boolean;
  en: { title: string; meta: string };
  bn: { title: string; meta: string };
}

export const exampleNeeds: ExampleNeed[] = [
  {
    mode: 'BUY',
    n: 1,
    glyph: <PhoneGlyph />,
    circled: true,
    en: { title: 'Used iPhone 15 Pro, 256GB', meta: 'Dhaka · up to ৳80,000' },
    bn: { title: 'পুরোনো iPhone 15 Pro, 256GB', meta: 'ঢাকা · ৳৮০,০০০ পর্যন্ত' },
  },
  {
    mode: 'RENT',
    n: 2,
    glyph: <BusGlyph />,
    en: { title: 'Microbus, 3 days', meta: 'Uttara → Cox’s Bazar' },
    bn: { title: 'মাইক্রোবাস, ৩ দিন', meta: 'উত্তরা → কক্সবাজার' },
  },
  {
    mode: 'HIRE',
    n: 3,
    glyph: <CameraGlyph />,
    en: { title: 'Wedding photographer', meta: 'Sylhet · 15 Dec' },
    bn: { title: 'বিয়ের ফটোগ্রাফার', meta: 'সিলেট · ১৫ ডিসেম্বর' },
  },
  {
    mode: 'BORROW',
    n: 4,
    glyph: <LadderGlyph />,
    en: { title: 'Tall ladder, one weekend', meta: 'Mirpur 10' },
    bn: { title: 'লম্বা মই, এক সপ্তাহান্ত', meta: 'মিরপুর ১০' },
  },
  {
    mode: 'SOURCE',
    n: 5,
    glyph: <BagGlyph />,
    circled: true,
    en: { title: '500 jute bags with logo', meta: 'Narayanganj · this month' },
    bn: { title: 'লোগোসহ ৫০০ পাটের ব্যাগ', meta: 'নারায়ণগঞ্জ · এই মাসে' },
  },
  {
    mode: 'BUY',
    n: 6,
    glyph: <DeskGlyph />,
    en: { title: 'Study table and chair', meta: 'Rajshahi · up to ৳12,000' },
    bn: { title: 'পড়ার টেবিল ও চেয়ার', meta: 'রাজশাহী · ৳১২,০০০ পর্যন্ত' },
  },
  {
    mode: 'HIRE',
    n: 7,
    glyph: <FanGlyph />,
    en: { title: 'Electrician, ceiling fan', meta: 'Uttara · tomorrow' },
    bn: { title: 'ইলেকট্রিশিয়ান, সিলিং ফ্যান', meta: 'উত্তরা · আগামীকাল' },
  },
  {
    mode: 'RENT',
    n: 8,
    glyph: <HangerGlyph />,
    en: { title: 'Sherwani for 3 days', meta: 'Chattogram' },
    bn: { title: 'শেরওয়ানি, ৩ দিনের জন্য', meta: 'চট্টগ্রাম' },
  },
  {
    mode: 'HIRE',
    n: 9,
    glyph: <BooksGlyph />,
    en: { title: 'Maths tutor, Class 9', meta: 'Khulna · 3 days a week' },
    bn: { title: 'গণিত শিক্ষক, নবম শ্রেণি', meta: 'খুলনা · সপ্তাহে ৩ দিন' },
  },
  {
    mode: 'BUY',
    n: 10,
    glyph: <BicycleGlyph />,
    en: { title: 'Kids’ bicycle, 20 inch', meta: 'Gazipur · up to ৳9,000' },
    bn: { title: 'বাচ্চাদের সাইকেল, ২০ ইঞ্চি', meta: 'গাজীপুর · ৳৯,০০০ পর্যন্ত' },
  },
  {
    mode: 'BORROW',
    n: 11,
    glyph: <SewingGlyph />,
    circled: true,
    en: { title: 'Sewing machine, 2 weeks', meta: 'Cumilla' },
    bn: { title: 'সেলাই মেশিন, ২ সপ্তাহ', meta: 'কুমিল্লা' },
  },
  {
    mode: 'RENT',
    n: 12,
    glyph: <ChairsGlyph />,
    en: { title: '100 chairs for a gaye holud', meta: 'Barishal · Friday' },
    bn: { title: 'গায়েহলুদের জন্য ১০০ চেয়ার', meta: 'বরিশাল · শুক্রবার' },
  },
  {
    mode: 'SOURCE',
    n: 13,
    glyph: <ShirtGlyph />,
    en: { title: '300 school uniforms', meta: 'Bogura · before term' },
    bn: { title: '৩০০টি স্কুল ইউনিফর্ম', meta: 'বগুড়া · টার্মের আগে' },
  },
  {
    mode: 'HIRE',
    n: 14,
    glyph: <AircoGlyph />,
    en: { title: 'AC servicing, 2 units', meta: 'Dhanmondi · this week' },
    bn: { title: 'এসি সার্ভিসিং, ২টি', meta: 'ধানমন্ডি · এই সপ্তাহে' },
  },
  {
    mode: 'BUY',
    n: 15,
    glyph: <CookerGlyph />,
    en: { title: 'Rice cooker, 2.8 litre', meta: 'Mymensingh · up to ৳4,500' },
    bn: { title: 'রাইস কুকার, ২.৮ লিটার', meta: 'ময়মনসিংহ · ৳৪,৫০০ পর্যন্ত' },
  },
];

export const exampleCode = (e: ExampleNeed) =>
  `${modeLetter[e.mode]}-${String(e.n).padStart(2, '0')}`;
