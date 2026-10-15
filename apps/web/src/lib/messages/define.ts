/**
 * One area's strings in both languages. The Bangla table is typed from the English keys, so a
 * missing translation is a compile error, exactly as for the core table in i18n.tsx.
 */
export function defineMessages<const E extends Record<string, string>>(
  en: E,
  bn: { [K in keyof E]: string },
) {
  return { en, bn };
}
