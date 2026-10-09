/**
 * Time of the server: local dates, wall-clock times and the week, in the server's time zone.
 *
 * Everything counts elapsed time in milliseconds and turns it into a local date or a wall-clock time only to compare
 * with the schedule. So a day with a daylight-saving change has 23 or 25 hours of accounting, never a lost or a
 * doubled hour.
 */

// the calendar and the clock are the speech package's: the intercom keeps its schedules with the same ones
import { addDays, dayOf, instantOf, localTime, minutesOf } from '@vionvision/speech';

import type { Day } from '@vionvision/speech';

export { DAYS, MINUTE, addDays, dayOf, formatClock, instantOf, isClock, localTime, serverTimeZone, systemClock, validTimeZone } from '@vionvision/speech';
export type { Clock, Day, LocalTime } from '@vionvision/speech';

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

/** A start before noon belongs to the night after the evening named in the rule: "evenings Sun-Thu, 00:30" is 00:30 on Mon-Fri. */
const NOON = 12 * 60;

/** The interval of a rule for the evening of `date`. */
function occurrence(rule: WeeklyInterval, date: string, timeZone: string): ActiveInterval {
  const startDate = minutesOf(rule.from) < NOON ? addDays(date, 1) : date;
  const endDate = minutesOf(rule.to) <= minutesOf(rule.from) ? addDays(startDate, 1) : startDate;
  return { from: instantOf(startDate, rule.from, timeZone), to: instantOf(endDate, rule.to, timeZone) };
}

/** The interval of the rules the moment falls into: of this evening, or of one of the two before (crossing midnight). */
export function activeInterval(rules: WeeklyInterval[], ms: number, timeZone: string): ActiveInterval | undefined {
  const today = localTime(ms, timeZone).date;
  let found: ActiveInterval | undefined;
  for (const rule of rules) {
    for (const date of [addDays(today, -2), addDays(today, -1), today]) {
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
  for (let offset = -1; offset <= 7; offset++) {
    const date = addDays(today, offset);
    for (const rule of rules) {
      if (!rule.days.includes(dayOf(date))) continue;
      const { from } = occurrence(rule, date, timeZone);
      if (from > ms && (best === undefined || from < best)) best = from;
    }
  }
  return best;
}
