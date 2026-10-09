/**
 * Every phrase the LLM writes is checked before it is said (INTERCOM_SCENARIOS.md §0 and §11). It must not:
 * - say or hint that nobody is home, when the owners come back, who lives here;
 * - name a time or a number the facts do not have (the speech package's check, as VOICE does);
 * - carry what the agent was never told but could guess or make up (messages of other instructions, codes);
 * - be long.
 * A phrase that fails is not said: the agent says its template for the step instead, and the reason goes to the log.
 */
import { foreignNumber } from '@vionvision/speech';

import type { AllowedValues, Language } from '@vionvision/speech';

export const MAX_SAY_CHARS = 220;

const ABSENCE_RU = [
  'никого\\s+(нет|не\\s*будет)',
  'нет\\s+дома',
  'не\\s+дома',
  'дома\\s+никого',
  'уехал\\p{L}*',
  'в\\s+(отпуск|отъезд|командировк)\\p{L}*',
  'верн[уё]т\\p{L}*',
  'вернутся',
  '(придут|будут)\\s+(в|к|после|через|вечером|завтра|только)',
  'одн[аио]\\s+дома',
  'никто\\s+не\\s+(живет|живёт|откроет)',
];
const ABSENCE_EN = [
  "(nobody|no one)('s| is)? (home|in)",
  'not (at )?home',
  'away (on|for|until)',
  'on (holiday|vacation)',
  'out of town',
  'back (at|by|on|after|tomorrow|tonight|later)',
  'will return',
  'return(s|ing)? (at|on|by)',
  'alone at home',
  'home alone',
];
const ABSENCE_DE = [
  'niemand\\s+(zu\\s+hause|da)',
  'nicht\\s+(zu\\s+hause|da)',
  'verreist',
  'im\\s+urlaub',
  'zurück\\s+(um|am|ab|nach|morgen|heute)',
  'kommen?\\s+(um|am|erst)\\s',
  'allein\\s+zu\\s+hause',
];

const words = (parts: string[]) => new RegExp(`(?<!\\p{L})(${parts.join('|')})(?!\\p{L})`, 'iu');

/** Words that tell a visitor the house is empty or when it will not be (stems, from the start of a word). */
const ABSENCE: Record<Language, RegExp> = { ru: words(ABSENCE_RU), en: words(ABSENCE_EN), de: words(ABSENCE_DE) };

const fold = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

export interface SayRules {
  language: Language;
  allowed: AllowedValues;
  /** texts that must not appear: messages of instructions the visitor did not match, codes, names given in secret */
  forbidden: string[];
}

/** Why the phrase may not be said, or undefined when it may. */
export function sayProblem(say: string, rules: SayRules): string | undefined {
  if (!say.trim()) return 'empty';
  if (say.length > MAX_SAY_CHARS) return 'too long';
  if (ABSENCE[rules.language].test(say)) return 'tells that nobody is home or when they come back';
  const number = foreignNumber(say, rules.allowed, rules.language, false);
  if (number) return `names "${number}", which the facts do not have`;
  const folded = fold(say);
  for (const text of rules.forbidden) {
    const secret = fold(text).trim();
    if (secret.length >= 6 && folded.includes(secret)) return 'repeats something the visitor must not hear';
  }
  return undefined;
}

/** Times (HH:MM) and numbers of texts the agent may repeat: the time now, the visitor's own words, the facts given. */
export function allowedValues(texts: string[]): AllowedValues {
  const times = new Set<string>();
  const numbers = new Set<number>([112]);
  for (const text of texts) {
    for (const match of text.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)) {
      times.add(`${match[1].padStart(2, '0')}:${match[2]}`);
      numbers.add(Number(match[1]));
    }
    for (const match of text.matchAll(/\d+/g)) numbers.add(Number(match[0]));
  }
  return { times, numbers };
}
