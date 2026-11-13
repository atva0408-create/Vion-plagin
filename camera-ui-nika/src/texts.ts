// i18n-skip-file: what NIKA says and what the parents read in a notification, in the language NIKA speaks; the
// settings page is translated by i18n/<lang>.json as in every plugin.

export type Lang = 'ru' | 'en' | 'de';

/** The language of NIKA's replies (she says it in her hello); Georgian and others get Russian, NIKA's first one. */
export function langOf(value: string | undefined): Lang {
  const short = (value ?? '').toLowerCase().slice(0, 2);
  return short === 'en' || short === 'de' ? short : 'ru';
}

interface Texts {
  extend(child: string, minutes: number): string;
  skipBreak(child: string): string;
  until(child: string, clock: string): string;
  askTitle: string;
  askBody(nika: string, what: string, speaker?: string): string;
  asked(what: string): string;
  approved(what: string): string;
  declined(what: string): string;
  expired(what: string, minutes: number): string;
  doneTitle: string;
  doneBody(nika: string, what: string, speaker?: string): string;
  commandOff: string;
  unknownCommand(name: string): string;
  noVoice: string;
  noScenario: string;
  done(what: string): string;
  failed(what: string, why: string): string;
  minutesRange: string;
  untilFormat: string;
  untilTooFar: string;
  untilNow: string;
  childRequired: string;
}

/** «1 минута», «2 минуты», «5 минут», «21 минута»: NIKA says it, an abbreviation would be read out letter by letter. */
export function ruMinutes(count: number): string {
  const ten = count % 10;
  const hundred = count % 100;
  const word = ten === 1 && hundred !== 11 ? 'минута' : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? 'минуты' : 'минут';
  return `${count} ${word}`;
}

const RU: Texts = {
  extend: (child, minutes) => `${child}: ещё ${ruMinutes(minutes)}`,
  skipBreak: (child) => `${child}: без следующего перерыва`,
  until: (child, clock) => `${child}: можно до ${clock}`,
  askTitle: 'NIKA: нужно ваше разрешение',
  askBody: (nika, what, speaker) =>
    `${nika}${speaker ? ` (просит ${speaker})` : ''}: ${what}. Ответьте в VION: Плагины → NIKA → «Ответить на запрос», или в чате ассистента.`,
  asked: (what) => `Попросила разрешения в VION: ${what}. Скажу, когда ответят.`,
  approved: (what) => `Разрешили: ${what}.`,
  declined: (what) => `Не разрешили: ${what}.`,
  expired: (what, minutes) => `Разрешение не пришло за ${minutes} минут: ${what}. Ничего не меняю.`,
  doneTitle: 'NIKA дала разрешение',
  doneBody: (nika, what, speaker) => `${nika}${speaker ? ` (попросил ${speaker})` : ''}: ${what}.`,
  commandOff: 'Эта команда выключена для NIKA в VION.',
  unknownCommand: (name) => `VION не знает команды ${name}.`,
  noVoice: 'Расширение VOICE в VION не установлено или не запущено: экранное время ведёт оно.',
  noScenario: 'В VOICE нет сценария экранного времени для этого ребёнка.',
  done: (what) => `Готово: ${what}.`,
  failed: (what, why) => `Не получилось (${what}): ${why}`,
  minutesRange: 'минуты: от 1 до 240',
  untilFormat: 'время: ЧЧ:ММ, например 23:00',
  untilTooFar: 'не больше 4 часов от текущего времени',
  untilNow: 'это время уже наступило',
  childRequired: 'нужно имя ребёнка',
};

const EN: Texts = {
  extend: (child, minutes) => `${child}: ${minutes} more minute${minutes === 1 ? '' : 's'}`,
  skipBreak: (child) => `${child}: no next break`,
  until: (child, clock) => `${child}: allowed until ${clock}`,
  askTitle: 'NIKA: your permission is needed',
  askBody: (nika, what, speaker) =>
    `${nika}${speaker ? ` (asked by ${speaker})` : ''}: ${what}. Answer in VION: Plugins → NIKA → «Answer a request», or in the assistant chat.`,
  asked: (what) => `I asked VION for permission: ${what}. I will tell you when they answer.`,
  approved: (what) => `Allowed: ${what}.`,
  declined: (what) => `Not allowed: ${what}.`,
  expired: (what, minutes) => `No permission came in ${minutes} minutes: ${what}. Nothing changes.`,
  doneTitle: 'NIKA gave a permission',
  doneBody: (nika, what, speaker) => `${nika}${speaker ? ` (asked by ${speaker})` : ''}: ${what}.`,
  commandOff: 'This command is off for NIKA in VION.',
  unknownCommand: (name) => `VION does not know the command ${name}.`,
  noVoice: 'The VOICE extension of VION is not installed or not running: it keeps the screen time.',
  noScenario: 'VOICE has no screen-time scenario for this child.',
  done: (what) => `Done: ${what}.`,
  failed: (what, why) => `It did not work (${what}): ${why}`,
  minutesRange: 'minutes: from 1 to 240',
  untilFormat: 'time: HH:MM, for example 23:00',
  untilTooFar: 'at most 4 hours from now',
  untilNow: 'that time has come already',
  childRequired: 'the name of the child is needed',
};

const DE: Texts = {
  extend: (child, minutes) => `${child}: noch ${minutes} Minute${minutes === 1 ? '' : 'n'}`,
  skipBreak: (child) => `${child}: ohne nächste Pause`,
  until: (child, clock) => `${child}: erlaubt bis ${clock}`,
  askTitle: 'NIKA: Ihre Erlaubnis wird gebraucht',
  askBody: (nika, what, speaker) =>
    `${nika}${speaker ? ` (gefragt von ${speaker})` : ''}: ${what}. Antworten Sie in VION: Plugins → NIKA → «Anfrage beantworten», oder im Chat des Assistenten.`,
  asked: (what) => `Ich habe VION um Erlaubnis gebeten: ${what}. Ich sage Bescheid, wenn geantwortet wird.`,
  approved: (what) => `Erlaubt: ${what}.`,
  declined: (what) => `Nicht erlaubt: ${what}.`,
  expired: (what, minutes) => `In ${minutes} Minuten kam keine Erlaubnis: ${what}. Es bleibt, wie es ist.`,
  doneTitle: 'NIKA hat etwas erlaubt',
  doneBody: (nika, what, speaker) => `${nika}${speaker ? ` (gefragt von ${speaker})` : ''}: ${what}.`,
  commandOff: 'Dieser Befehl ist für NIKA in VION ausgeschaltet.',
  unknownCommand: (name) => `VION kennt den Befehl ${name} nicht.`,
  noVoice: 'Die Erweiterung VOICE ist in VION nicht installiert oder läuft nicht: sie führt die Bildschirmzeit.',
  noScenario: 'VOICE hat für dieses Kind kein Bildschirmzeit-Szenario.',
  done: (what) => `Erledigt: ${what}.`,
  failed: (what, why) => `Hat nicht geklappt (${what}): ${why}`,
  minutesRange: 'Minuten: von 1 bis 240',
  untilFormat: 'Uhrzeit: HH:MM, zum Beispiel 23:00',
  untilTooFar: 'höchstens 4 Stunden ab jetzt',
  untilNow: 'diese Uhrzeit ist schon vorbei',
  childRequired: 'der Name des Kindes fehlt',
};

export function texts(lang: Lang): Texts {
  return lang === 'en' ? EN : lang === 'de' ? DE : RU;
}
