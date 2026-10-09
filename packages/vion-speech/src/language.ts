/** The languages ViON speaks and hears: a voice and a recognizer for each. */
export const LANGUAGES = ['ru', 'en', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = { ru: 'Russian', en: 'English', de: 'German' };

export function asLanguage(value: unknown, fallback: Language = 'ru'): Language {
  const short = typeof value === 'string' ? value.slice(0, 2).toLowerCase() : '';
  return (LANGUAGES as readonly string[]).includes(short) ? (short as Language) : fallback;
}
