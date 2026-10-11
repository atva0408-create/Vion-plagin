/**
 * What a child did on past days, from the screen-time state: the minutes at the computer (the engine's own count), the
 * sessions and the breaks between them, the reminders and the ones the child went on after (violations), and the
 * whiles VOICE did not watch. Pure: the plugin and the tests give it the state, the clock and the zone.
 */
import { HISTORY_DAYS, MAX_STEP_MS } from './screenTime.js';
import { MINUTE, addDays, formatClock, instantOf, localTime } from './time.js';

import type { LoggedSession, LoggedUnseen, Reason, ScreenTimeState } from './screenTime.js';

interface Span {
  from: string;
  to: string;
  minutes: number;
}

export interface DayReport {
  date: string;
  /** VOICE's count, the same as the status and the daily limit use; by the day the minutes were played. */
  playedMinutes: number;
  /** false: no journal that day (before VOICE kept one, or older than it keeps it): only the minutes are known. */
  journal: boolean;
  /** The day the journal began: from this time on. */
  journalSince?: string;
  /** VOICE did not watch at all that day: no play is not "did not play". */
  watched?: false;
  /** The whiles VOICE did not watch (camera gone, scenario off, VOICE or the server down): what happened then is unknown. */
  unwatched?: { minutes: number; list: Span[] };
  /**
   * By the day they began. `ongoing`: the child is at the computer now. `lostSight`: VOICE stopped seeing the child
   * then; the session ends there for all it knows.
   */
  sessions: (Span & { ongoing?: true; lostSight?: true })[];
  /** The time away between two sessions of the day; `full`: the rule counted the whole break as taken (absences add up while it is due). */
  breaks: { count: number; minutes: number; full: number; list: Span[] };
  /** Reminders the child heard, the first step of each. */
  reminders: number;
  /** Reminders due that VOICE could not say (no speaker, the camera gone). */
  notSaid?: number;
  /**
   * A reminder the child heard and went on after: `level` 2 a firm one followed, 3 the parents were to be told;
   * `heard` the steps said, `parentsTold` the notice went.
   */
  violations: { at: string; reason: Reason; level: number; heard: number; parentsTold: boolean }[];
  /** More happened than a day keeps: the latest entries are missing. */
  capped?: true;
}

export interface ReportOptions {
  /** The last day, local date YYYY-MM-DD. */
  lastDate: string;
  days: number;
  now: number;
  timeZone: string;
  /** The scenario is on: VOICE looks at the camera, unless it is blind or its looks stopped. */
  watching: boolean;
}

const minutes = (ms: number) => Math.round(ms / MINUTE);

/** The spans within [from, to), overlapping ones joined. */
function clipped(spans: LoggedUnseen[], from: number, to: number): LoggedUnseen[] {
  const inside = spans
    .map((span) => ({ from: Math.max(span.from, from), to: Math.min(span.to, to) }))
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
  const joined: LoggedUnseen[] = [];
  for (const span of inside) {
    const last = joined[joined.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else joined.push({ ...span });
  }
  return joined;
}

export function dayReports(state: ScreenTimeState, options: ReportOptions): DayReport[] {
  const { lastDate, days, now, timeZone } = options;
  const span = (from: number, to: number): Span => ({ from: formatClock(from, timeZone), to: formatClock(to, timeZone), minutes: minutes(to - from) });
  // VOICE sees now: a session without an end runs until now. Blind, switched off or stalled, it ended where the child
  // was last seen for all VOICE knows: "ongoing" after the camera went offline at 20:30 said 12 hours at the computer
  const watchingNow = options.watching && state.blindSince === undefined && state.lastTick !== undefined && now - state.lastTick <= MAX_STEP_MS;
  const running = (session: LoggedSession) => session.to === undefined && watchingNow && state.present;
  const endOf = (session: LoggedSession) => session.to ?? (running(session) ? now : Math.max(session.from, state.lastSeen ?? session.from));
  // the whiles not watched, of every day (one may run over midnight), and the one going on now
  const unseen: LoggedUnseen[] = Object.values(state.log ?? {}).flatMap((day) => day.unseen ?? []);
  if (!watchingNow && state.lastTick !== undefined) unseen.push({ from: Math.min(state.blindSince ?? state.lastTick, state.lastTick), to: now });
  const since = state.logSince;
  const sinceDate = since === undefined ? undefined : localTime(since, timeZone).date;
  const oldest = addDays(localTime(now, timeZone).date, -HISTORY_DAYS);

  const out: DayReport[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = addDays(lastDate, -back);
    const dayStart = instantOf(date, '00:00', timeZone);
    const dayEnd = Math.min(instantOf(addDays(date, 1), '00:00', timeZone), now);
    const journal = since !== undefined && sinceDate !== undefined && date >= sinceDate && date >= oldest && dayStart < now;
    const base = { date, playedMinutes: Math.round(state.history[date] ?? 0) };
    if (!journal) {
      out.push({ ...base, journal: false, sessions: [], breaks: { count: 0, minutes: 0, full: 0, list: [] }, reminders: 0, violations: [] });
      continue;
    }
    const log = state.log?.[date];
    const sessions = [...(log?.sessions ?? [])].sort((a, b) => a.from - b.from);
    const list: Span[] = [];
    let full = 0;
    for (let i = 1; i < sessions.length; i++) {
      const from = endOf(sessions[i - 1]);
      const to = sessions[i].from;
      if (sessions[i].rested) full++;
      if (to - from >= MINUTE || sessions[i].rested) list.push(span(from, Math.max(from, to)));
    }
    const watchFrom = Math.max(dayStart, since);
    const notWatched = clipped(unseen, watchFrom, dayEnd);
    const notWatchedMs = notWatched.reduce((sum, s) => sum + (s.to - s.from), 0);
    const reminders = log?.reminders ?? [];
    // entries of before `said` was kept: the steps as the engine took them
    const heard = (r: (typeof reminders)[number]) => r.said ?? r.level;
    const notSaid = reminders.filter((r) => heard(r) === 0).length;
    out.push({
      ...base,
      journal: true,
      ...(date === sinceDate ? { journalSince: formatClock(since, timeZone) } : {}),
      ...(dayEnd > watchFrom && notWatchedMs >= dayEnd - watchFrom - MINUTE ? { watched: false as const } : {}),
      ...(notWatched.length ? { unwatched: { minutes: minutes(notWatchedMs), list: notWatched.map((s) => span(s.from, s.to)) } } : {}),
      sessions: sessions.map((s) => ({
        ...span(s.from, endOf(s)),
        ...(s.to === undefined ? (running(s) ? { ongoing: true as const } : { lostSight: true as const }) : {}),
      })),
      breaks: { count: list.length, minutes: list.reduce((sum, b) => sum + b.minutes, 0), full, list },
      reminders: reminders.length - notSaid,
      ...(notSaid ? { notSaid } : {}),
      violations: reminders
        .filter((r) => r.level >= 2 && heard(r) >= 1)
        .sort((a, b) => a.at - b.at)
        .map((r) => ({
          at: formatClock(r.at, timeZone),
          reason: r.reason,
          level: r.level,
          heard: heard(r),
          parentsTold: r.told === true || (r.said === undefined && r.level >= 3),
        })),
      ...(log?.capped ? { capped: true as const } : {}),
    });
  }
  return out;
}

/** Today in the zone, as the default last day of a report. */
export function today(now: number, timeZone: string): string {
  return localTime(now, timeZone).date;
}
