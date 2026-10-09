/**
 * Windows of time: "Tuesdays 10:00–14:00", "every day 23:00–07:00", "today until 23:00".
 *
 * A weekly window starts on its days at `from` and ends at `to` of the same day, or of the next day when `to` is not
 * after `from` (the night). Unlike VOICE's evenings, a start in the morning belongs to the day named: "Tue 10:00" is
 * Tuesday. Wall-clock times are turned into instants with the speech package's calendar, so daylight-saving changes
 * neither lose nor double an hour.
 */
import { DAYS, addDays, dayOf, instantOf, isClock, localTime, minutesOf } from '@vionvision/speech';

import type { Day } from '@vionvision/speech';
import type { InstructionWhen, WeekWindow } from './types.js';

export interface Span {
  from: number;
  to: number;
}

/** The span of a weekly window that starts on the local date. */
function occurrence(window: WeekWindow, date: string, timeZone: string): Span {
  const endDate = minutesOf(window.to) <= minutesOf(window.from) ? addDays(date, 1) : date;
  return { from: instantOf(date, window.from, timeZone), to: instantOf(endDate, window.to, timeZone) };
}

/** The span of the windows the moment falls into (of today, or of yesterday's night), undefined outside all of them. */
export function activeSpan(windows: WeekWindow[], ms: number, timeZone: string): Span | undefined {
  const today = localTime(ms, timeZone).date;
  let found: Span | undefined;
  for (const window of windows) {
    if (!isClock(window.from) || !isClock(window.to)) continue;
    for (const date of [addDays(today, -1), today]) {
      if (!window.days.includes(dayOf(date))) continue;
      const span = occurrence(window, date, timeZone);
      if (ms >= span.from && ms < span.to && (!found || span.to > found.to)) found = span;
    }
  }
  return found;
}

/** The next start of one of the windows after the moment, within a week. */
export function nextStart(windows: WeekWindow[], ms: number, timeZone: string): number | undefined {
  const today = localTime(ms, timeZone).date;
  let best: number | undefined;
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, offset);
    for (const window of windows) {
      if (!isClock(window.from) || !isClock(window.to) || !window.days.includes(dayOf(date))) continue;
      const { from } = occurrence(window, date, timeZone);
      if (from > ms && (best === undefined || from < best)) best = from;
    }
  }
  return best;
}

/** Whether an instruction's time holds at the moment. */
export function instructionActive(when: InstructionWhen, ms: number, timeZone: string): boolean {
  if (when.kind === 'window') return ms >= when.from && ms < when.to;
  if (when.until !== undefined && ms >= when.until) return false;
  return activeSpan([when], ms, timeZone) !== undefined;
}

/** Whether an instruction can never hold again (its window passed, its repetition ended). */
export function instructionOver(when: InstructionWhen, ms: number): boolean {
  return when.kind === 'window' ? ms >= when.to : when.until !== undefined && ms >= when.until;
}

export const EVERY_DAY: Day[] = [...DAYS];

/** Minutes a window lasts, for checks (a window of 0 minutes is a mistake). */
export function windowMinutes(window: WeekWindow): number {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  return to > from ? to - from : 24 * 60 - from + to;
}
