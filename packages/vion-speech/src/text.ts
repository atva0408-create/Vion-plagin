/**
 * Checks of what was said and heard: the camera's own phrase coming back through the microphone, numbers in an LLM
 * phrase that the facts do not have, and digits spoken as words (a code said at the door).
 */
import type { Language } from './language.js';

export const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * What the microphone heard is the camera's own phrase coming back, not the person: a run of three or more of the
 * phrase's words, in its order, makes most of what was heard. Shared words are not enough: "когда можно играть" after
 * "…играть можно будет завтра" is the child's question, and taken for an echo it went unanswered; nor two words in a
 * row: "ещё десять минут" after "…перерыв на десять минут" is the child asking for more time.
 */
export function isEcho(heard: string, said: string | undefined): boolean {
  if (!said) return false;
  const phrase = words(said);
  const got = words(heard);
  let longest = 0;
  for (let i = 0; i < got.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      let run = 0;
      while (i + run < got.length && j + run < phrase.length && got[i + run] === phrase[j + run]) run++;
      longest = Math.max(longest, run);
    }
  }
  return longest >= 3 && longest / got.length >= 0.6;
}

/** Number words an LLM phrase may hide an amount in, with their value. */
export const NUMBER_WORDS: Record<Language, Record<string, number>> = {
  ru: {
    один: 1,
    одна: 1,
    одну: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
    пятнадцать: 15,
    двадцать: 20,
    тридцать: 30,
    сорок: 40,
    пятьдесят: 50,
    шестьдесят: 60,
    полчаса: 30,
    полчасика: 30,
    полчасок: 30,
    час: 60,
    часа: 60,
    часик: 60,
    часок: 60,
    часика: 60,
    часочек: 60,
    полтора: 90,
  },
  en: {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    fifteen: 15,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    hour: 60,
    half: 30,
  },
  de: {
    eins: 1,
    eine: 1,
    einen: 1,
    zwei: 2,
    drei: 3,
    vier: 4,
    fünf: 5,
    sechs: 6,
    sieben: 7,
    acht: 8,
    neun: 9,
    zehn: 10,
    elf: 11,
    zwölf: 12,
    fünfzehn: 15,
    zwanzig: 20,
    dreißig: 30,
    vierzig: 40,
    fünfzig: 50,
    sechzig: 60,
    stunde: 60,
    halbe: 30,
  },
};

export interface AllowedValues {
  /** HH:MM */
  times: Set<string>;
  numbers: Set<number>;
}

/**
 * The first time (H:MM, HH.MM) or number in the phrase that is not allowed; undefined when the phrase is clean.
 * Number words count too unless `numberWords` is off (a door phrase says "одну секунду" without promising anything).
 */
export function foreignNumber(say: string, allowed: AllowedValues, language: Language, numberWords = true): string | undefined {
  let rest = say;
  for (const match of say.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)) {
    const time = `${match[1].padStart(2, '0')}:${match[2]}`;
    if (!allowed.times.has(time)) return match[0];
    rest = rest.replace(match[0], ' ');
  }
  for (const match of rest.matchAll(/\d+/g)) if (!allowed.numbers.has(Number(match[0]))) return match[0];
  if (!numberWords) return undefined;
  const known = NUMBER_WORDS[language];
  for (const word of rest.toLowerCase().split(/[^\p{L}]+/u)) {
    if (word in known && !allowed.numbers.has(known[word])) return word;
  }
  return undefined;
}

// ---- digits said as words: a code at the door ----

type Token = { kind: 'unit' | 'teen' | 'ten' | 'hundred'; value: number } | { kind: 'times100' } | { kind: 'digits'; text: string };

const SPOKEN: Record<Language, Record<string, Token>> = {
  ru: {},
  en: {},
  de: {},
};

function add(language: Language, kind: 'unit' | 'teen' | 'ten' | 'hundred', entries: [string[], number][]): void {
  for (const [names, value] of entries) for (const name of names) SPOKEN[language][name] = { kind, value };
}

add('ru', 'unit', [
  [['ноль', 'нуль'], 0],
  [['один', 'одна', 'одно', 'раз'], 1],
  [['два', 'две'], 2],
  [['три'], 3],
  [['четыре'], 4],
  [['пять'], 5],
  [['шесть'], 6],
  [['семь'], 7],
  [['восемь'], 8],
  [['девять'], 9],
]);
add('ru', 'teen', [
  [['десять'], 10],
  [['одиннадцать'], 11],
  [['двенадцать'], 12],
  [['тринадцать'], 13],
  [['четырнадцать'], 14],
  [['пятнадцать'], 15],
  [['шестнадцать'], 16],
  [['семнадцать'], 17],
  [['восемнадцать'], 18],
  [['девятнадцать'], 19],
]);
add('ru', 'ten', [
  [['двадцать'], 20],
  [['тридцать'], 30],
  [['сорок'], 40],
  [['пятьдесят'], 50],
  [['шестьдесят'], 60],
  [['семьдесят'], 70],
  [['восемьдесят'], 80],
  [['девяносто'], 90],
]);
add('ru', 'hundred', [
  [['сто'], 100],
  [['двести'], 200],
  [['триста'], 300],
  [['четыреста'], 400],
  [['пятьсот'], 500],
  [['шестьсот'], 600],
  [['семьсот'], 700],
  [['восемьсот'], 800],
  [['девятьсот'], 900],
]);
add('en', 'unit', [
  [['zero', 'oh', 'o'], 0],
  [['one'], 1],
  [['two'], 2],
  [['three'], 3],
  [['four'], 4],
  [['five'], 5],
  [['six'], 6],
  [['seven'], 7],
  [['eight'], 8],
  [['nine'], 9],
]);
add('en', 'teen', [
  [['ten'], 10],
  [['eleven'], 11],
  [['twelve'], 12],
  [['thirteen'], 13],
  [['fourteen'], 14],
  [['fifteen'], 15],
  [['sixteen'], 16],
  [['seventeen'], 17],
  [['eighteen'], 18],
  [['nineteen'], 19],
]);
add('en', 'ten', [
  [['twenty'], 20],
  [['thirty'], 30],
  [['forty'], 40],
  [['fifty'], 50],
  [['sixty'], 60],
  [['seventy'], 70],
  [['eighty'], 80],
  [['ninety'], 90],
]);
add('de', 'unit', [
  [['null'], 0],
  [['eins', 'ein', 'eine'], 1],
  [['zwei', 'zwo'], 2],
  [['drei'], 3],
  [['vier'], 4],
  [['fünf'], 5],
  [['sechs'], 6],
  [['sieben'], 7],
  [['acht'], 8],
  [['neun'], 9],
]);
add('de', 'teen', [
  [['zehn'], 10],
  [['elf'], 11],
  [['zwölf'], 12],
  [['dreizehn'], 13],
  [['vierzehn'], 14],
  [['fünfzehn'], 15],
  [['sechzehn'], 16],
  [['siebzehn'], 17],
  [['achtzehn'], 18],
  [['neunzehn'], 19],
]);
add('de', 'ten', [
  [['zwanzig'], 20],
  [['dreißig', 'dreissig'], 30],
  [['vierzig'], 40],
  [['fünfzig'], 50],
  [['sechzig'], 60],
  [['siebzig'], 70],
  [['achtzig'], 80],
  [['neunzig'], 90],
]);
SPOKEN.en.hundred = { kind: 'times100' };
SPOKEN.de.hundert = { kind: 'times100' };

/** German writes numbers as one word: "vierhundertzweiundachtzig" is vier · hundert · achtzig · zwei. */
function germanParts(word: string): string[] {
  if (word in SPOKEN.de) return [word];
  const hundred = word.indexOf('hundert');
  if (hundred >= 0) {
    const before = word.slice(0, hundred);
    const after = word.slice(hundred + 'hundert'.length);
    return [...(before ? germanParts(before) : ['ein']), 'hundert', ...(after ? germanParts(after) : [])];
  }
  const und = /^(.+?)und(.+)$/u.exec(word);
  if (und && und[1] in SPOKEN.de && und[2] in SPOKEN.de) return [und[2], und[1]];
  return [word];
}

function tokens(text: string, language: Language): Token[] {
  const out: Token[] = [];
  for (const raw of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    if (/^\d+$/.test(raw)) {
      out.push({ kind: 'digits', text: raw });
      continue;
    }
    for (const part of language === 'de' ? germanParts(raw) : [raw]) {
      const token = SPOKEN[language][part];
      if (token) out.push(token);
    }
  }
  return out;
}

/**
 * The digits a person said, as one string: "четыреста восемьдесят два девятьсот пятнадцать", "4 8 2 9 1 5" and "четыре
 * восемь два девять один пять" are all "482915". Words that are not numbers are skipped. Undefined when no number was said.
 *
 * Groups follow speech: a unit after a unit starts a new group ("четыре восемь" is 48), a unit after a ten joins it
 * ("двадцать пять" is 25), "ноль" is a digit of its own ("ноль семь" is 07).
 */
export function spokenDigits(text: string, language: Language): string | undefined {
  const groups: string[] = [];
  let hundreds = -1;
  let tens = -1;
  let units = -1;
  const flush = () => {
    if (hundreds < 0 && tens < 0 && units < 0) return;
    const value = Math.max(hundreds, 0) + Math.max(tens, 0) + Math.max(units, 0);
    groups.push(String(value));
    hundreds = tens = units = -1;
  };
  for (const token of tokens(text, language)) {
    if (token.kind === 'digits') {
      flush();
      groups.push(token.text);
    } else if (token.kind === 'times100') {
      // "four hundred": the unit before it becomes the hundreds
      const base = units >= 0 && tens < 0 && hundreds < 0 ? units : 1;
      if (!(units >= 0 && tens < 0 && hundreds < 0)) flush();
      hundreds = base * 100;
      units = -1;
    } else if (token.kind === 'hundred') {
      flush();
      hundreds = token.value;
    } else if (token.kind === 'ten') {
      if (tens >= 0 || units >= 0) flush();
      tens = token.value;
    } else if (token.kind === 'teen') {
      if (tens >= 0 || units >= 0) flush();
      tens = token.value;
      units = 0;
      // a teen closes its group: "пятнадцать два" is 15 and 2
      flush();
    } else {
      if (token.value === 0) {
        flush();
        groups.push('0');
      } else {
        if (units >= 0) flush();
        units = token.value;
      }
    }
  }
  flush();
  return groups.length ? groups.join('') : undefined;
}
