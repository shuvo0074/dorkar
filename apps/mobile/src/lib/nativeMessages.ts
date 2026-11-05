/** Words only the app needs, on top of the web's tables (same keys in both, typed in i18n.tsx). */
export const nativeEn = {
  'common.done': 'Done',
  'sessions.current': 'This phone',
  'common.filter': 'Type to filter',
  'common.back': 'Back',
  'photo.library': 'Choose from library',
  'photo.camera': 'Take a photo',
  'desk.useWeb': 'Staff tools are on the website.',
};

export const nativeBn: Record<keyof typeof nativeEn, string> = {
  'common.done': 'হয়ে গেছে',
  'sessions.current': 'এই ফোন',
  'common.filter': 'খুঁজতে লিখুন',
  'common.back': 'পেছনে',
  'photo.library': 'গ্যালারি থেকে নিন',
  'photo.camera': 'ছবি তুলুন',
  'desk.useWeb': 'স্টাফ টুল ওয়েবসাইটে আছে।',
};
