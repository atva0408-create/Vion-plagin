/**
 * Time of the server: local dates, wall-clock times and the week, in the server's time zone.
 *
 * Everything counts elapsed time in milliseconds and turns it into a local date or a wall-clock time only to compare
 * with the schedule. So a day with a daylight-saving change has 23 or 25 hours of accounting, never a lost or a
 * doubled hour.
 */

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export const MINUTE = 60_000;

/** A timer the plugin waits with; tests replace it with a clock they move by hand. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  day: Day;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

function parts(ms: number, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

export function localTime(ms: number, timeZone: string): LocalTime {
  const p = parts(ms, timeZone);
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { date, hour: p.hour, minute: p.minute, day: dayOf(date) };
}

/** The day of the week of a local date. */
export function dayOf(date: string): Day {
  const [y, m, d] = date.split('-').map(Number);
  // 1970-01-01 was a Thursday
  const index = (Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) + 3) % 7;
  return DAYS[(index + 7) % 7];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isClock(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

/**
 * The instant a local date has the given wall-clock time. A time skipped by a spring-forward change gives the first
 * instant after the gap; a time repeated in autumn gives its first occurrence.
 */
export function instantOf(date: string, clock: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d) + minutesOf(clock) * MINUTE;
  // the offset of the zone near that moment; two passes settle it on both sides of a change
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, timeZone);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const next = guess + (wanted - shownAsUtc);
    if (next === guess) break;
    guess = next;
  }
  const shown = localTime(guess, timeZone);
  if (shown.date === date && shown.hour * 60 + shown.minute === minutesOf(clock)) {
    // autumn: the hour before may show the same wall-clock time
    const earlier = guess - 60 * MINUTE;
    const before = localTime(earlier, timeZone);
    return before.date === date && before.hour * 60 + before.minute === minutesOf(clock) ? earlier : guess;
  }
  // spring: the wall-clock time does not exist, the day jumps over it
  for (let step = 0; step <= 120; step++) {
    const probe = guess - 60 * MINUTE + step * MINUTE;
    const t = localTime(probe, timeZone);
    if (t.date === date && t.hour * 60 + t.minute > minutesOf(clock)) return probe - (probe % MINUTE);
  }
  return guess;
}

/** Evenings that start an interval, with its start and end time; `to` before `from` ends it the next morning. */
export interface WeeklyInterval {
  days: Day[];
  from: string;
  to: string;
}

export interface ActiveInterval {
  from: number;
  to: number;
}

function occurrence(rule: WeeklyInterval, date: string, timeZone: string): ActiveInterval {
  const from = instantOf(date, rule.from, timeZone);
  const endDate = minutesOf(rule.to) <= minutesOf(rule.from) ? addDays(date, 1) : date;
  return { from, to: instantOf(endDate, rule.to, timeZone) };
}

/** The interval of the rules the moment falls into: one started today or, crossing midnight, yesterday. */
export function activeInterval(rules: WeeklyInterval[], ms: number, timeZone: string): ActiveInterval | undefined {
  const today = localTime(ms, timeZone).date;
  let found: ActiveInterval | undefined;
  for (const rule of rules) {
    for (const date of [addDays(today, -1), today]) {
      if (!rule.days.includes(dayOf(date))) continue;
      const span = occurrence(rule, date, timeZone);
      if (ms >= span.from && ms < span.to && (!found || span.to > found.to)) found = span;
    }
  }
  return found;
}

/** The next start of an interval of the rules after the moment, within a week. */
export function nextIntervalStart(rules: WeeklyInterval[], ms: number, timeZone: string): number | undefined {
  const today = localTime(ms, timeZone).date;
  let best: number | undefined;
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, offset);
    for (const rule of rules) {
      if (!rule.days.includes(dayOf(date))) continue;
      const from = instantOf(date, rule.from, timeZone);
      if (from > ms && (best === undefined || from < best)) best = from;
    }
  }
  return best;
}

export function formatClock(ms: number, timeZone: string): string {
  const t = localTime(ms, timeZone);
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}
