/**
 * The "screen time" scenario: counts the time a child spends at the computer and decides when VOICE speaks.
 *
 * The engine is plain data and arithmetic: the plugin feeds it a look at the camera every few seconds and turns what it
 * returns into speech and notifications. It never reads the clock itself, so tests move time by hand, and its state is
 * plain JSON, so a restart in the middle of a session continues where it stopped.
 */
import { MINUTE, activeInterval, addDays, formatClock, instantOf, localTime, nextIntervalStart } from './time.js';

import type { PresenceSource } from './presence.js';
import type { WeeklyInterval } from './time.js';

export type Reason = 'break' | 'bedtime' | 'daily_limit';

export interface ScreenTimeConfig {
  id: string;
  enabled: boolean;
  childName: string;
  source: PresenceSource;
  sessionMinutes: number;
  breakMinutes: number;
  dailyMinutes?: number;
  bedtime: WeeklyInterval[];
  repeatMinutes: number;
  maxRepeats: number;
  /** Say how long the break still lasts when the child comes back too early. */
  breakReminder: boolean;
  answerQuestions: boolean;
  /** The microphone stays open and VOICE answers when the child calls it by name («ВиОН, сколько мне ещё отдыхать?»). */
  answerOnCall: boolean;
  minPresenceSeconds: number;
  gapSeconds: number;
}

export interface Escalation {
  reason: Reason;
  /** 1 soft, 2 firm, 3 the parents are told; later phrases repeat level 3. */
  level: number;
  at: number;
  repeats: number;
  /** When the first phrase of it came: where the parents' event in the recordings begins. */
  since?: number;
}

/** A session at the computer; `to` is missing while it runs. */
export interface LoggedSession {
  from: number;
  to?: number;
  /** The time away before it was the whole break to the rule (absences add up while the break is due). */
  rested?: true;
}

/**
 * A rule VOICE reminded the child of, and how far it went: 1 the first reminder, 2 the child went on after it (a firm
 * one), 3 the parents were told.
 */
export interface LoggedReminder {
  at: number;
  reason: Reason;
  level: number;
  /**
   * The steps said, so heard: a phrase never said (no speaker, the camera gone) is not a reminder the child let pass.
   * Missing in entries of before it was kept.
   */
  said?: number[];
  /** The parents' notice went (a parent who gave time meanwhile stops it). */
  told?: true;
}

/** A while VOICE saw nothing: the camera or its detector gone, the scenario off, VOICE or the server down. */
export interface LoggedUnseen {
  from: number;
  to: number;
}

/** What happened on a local date: what the parents ask about later («сколько отдыхал», «когда нарушил»). */
export interface DayLog {
  sessions: LoggedSession[];
  reminders: LoggedReminder[];
  unseen?: LoggedUnseen[];
  /** More came than a day keeps: the latest entries are missing. */
  capped?: true;
}

export interface ScreenTimeState {
  date: string;
  todayMs: number;
  /** Minutes at the computer by local date, the last 30 days. */
  history: Record<string, number>;
  /** A session is running: the child is at the computer or away shorter than the gap. */
  present: boolean;
  candidateSince?: number;
  lastSeen?: number;
  /** When the last session ended: the start of the break the child may be taking. */
  leftAt?: number;
  /** Time at the computer since the last full break. */
  workMs: number;
  /** Rest already taken toward the due break: the absences since it fell due, added up until the whole break. */
  restMs?: number;
  lastTick?: number;
  escalation?: Escalation;
  /** Limits are lifted until then: a parent gave more time. */
  grantUntil?: number;
  name?: string;
  /** The module attribute was seen "yes" in this session: kept over a restart like the name. */
  attributeYes?: boolean;
  /** VOICE has been blind since then (camera offline, no detector, boxes frozen). */
  blindSince?: number;
  /** The sessions and the reminders by local date (the date they began), the last 30 days like the history. */
  log?: Record<string, DayLog>;
  /** When the journal began: of the days before only the minutes are known. */
  logSince?: number;
}

export interface Facts {
  now: string;
  childName: string;
  language: string;
  reason: Reason;
  level: number;
  sessionMinutes: number;
  sessionLimit: number;
  todayMinutes: number;
  dailyLimit?: number;
  breakMinutes: number;
  /** The break ends then, if the child leaves now (or left already). */
  breakEndsAt?: string;
  /** Minutes of the break still to wait, when the child is back too early. */
  breakMinutesLeft?: number;
  bedtimeFrom?: string;
  wakeAt?: string;
  nextAllowedAt: string;
  /** 'today' or 'tomorrow': which day nextAllowedAt is on. */
  nextAllowedDay: 'today' | 'tomorrow';
}

export type ScreenTimeAction = { type: 'speak'; kind: 'nudge' | 'remaining'; facts: Facts } | { type: 'notify'; facts: Facts };

/** Where the child stands now, for an answer in minutes: what is allowed and for how long. */
export type Standing =
  /** May play this many minutes more, until the limit that comes first. */
  | { kind: 'play'; minutes: number; until: Reason }
  /** A parent gave time: this many minutes of it are left. */
  | { kind: 'granted'; minutes: number }
  /** Away on a break: this many minutes of it are left. */
  | { kind: 'break'; minutes: number }
  /** At the computer while a break is due: the whole break, counted from leaving. */
  | { kind: 'break_due'; minutes: number }
  /** Not until then: a time, not minutes (the next morning is hundreds of minutes away). */
  | { kind: 'bedtime' | 'daily_limit'; next: string; day: 'today' | 'tomorrow' };

export function freshState(date: string): ScreenTimeState {
  return { date, todayMs: 0, history: {}, present: false, workMs: 0 };
}

/** Longest step counted as continuous: after a restart or a stalled timer the time between is not presence. */
export const MAX_STEP_MS = MINUTE;
/** An absence this short is a look the detector missed, still time at the computer. */
const FLICKER_MS = 15_000;
export const HISTORY_DAYS = 30;
/** A pause in the looks this long ends a session (a restart is a minute or two; a scenario off for the night is not). */
const PAUSE_LIMIT_MS = 30 * MINUTE;
/** Entries of one day's log at most: a flickering detector must not grow the state without a bound. */
const LOG_DAY_ENTRIES = 300;
/**
 * Bedtime and the daily limit go on all evening: a child back this soon after the session ended goes on with the
 * reminders where they were. A classifier that said "no" for two minutes, or a child stepping out and back, started
 * them over, and the third step that tells the parents never came (2026-10-09: 22:30, 22:33, 22:36, then 22:42 again).
 */
export const ESCALATION_MEMORY_MS = 15 * MINUTE;
const LASTING: ReadonlySet<Reason> = new Set(['bedtime', 'daily_limit']);

export interface TickInput {
  now: number;
  /** undefined: the camera or its detector is not there, nothing is known of the child. */
  present: boolean | undefined;
  name?: string;
  attributeYes?: boolean;
  /** VOICE quiet hours: nothing is said except about bedtime. */
  quiet: boolean;
  timeZone: string;
  language: string;
}

export class ScreenTimeEngine {
  constructor(
    public config: ScreenTimeConfig,
    public state: ScreenTimeState,
  ) {}

  /** One look at the camera; returns what VOICE should do now. */
  tick(input: TickInput): ScreenTimeAction[] {
    const { now, timeZone } = input;
    const s = this.state;
    const previous = s.lastTick;
    // no look for longer than a step: the scenario was off, VOICE or the server down (endPause)
    const paused = previous !== undefined && now - previous > MAX_STEP_MS;
    const step = previous === undefined || paused ? 0 : Math.max(0, now - previous);
    s.lastTick = now;
    this.rollDate(now, timeZone);

    if (input.present === undefined) {
      // a camera that dropped (Wi-Fi, a crashed detector) keeps the last boxes of a still child for hours: they counted
      // as a night at the computer, the next day's limit was spent and the parents were told. While VOICE is blind
      // nothing is counted and nothing changes (no write per look); what the blindness meant is settled when sight
      // comes back.
      s.blindSince ??= previous ?? now;
      return [];
    }
    if (s.blindSince !== undefined) this.endBlindness(s.blindSince, paused ? now : (previous ?? now), timeZone);
    else if (paused) this.endPause(previous, now, timeZone);
    // after the pause: a session it ended is not one running when the journal begins
    this.startLog(now, timeZone);

    if (input.present) {
      s.lastSeen = now;
      s.candidateSince ??= now;
      if (input.name) s.name = input.name;
      if (input.attributeYes !== undefined) s.attributeYes = input.attributeYes;
    } else {
      s.candidateSince = undefined;
    }

    const actions: ScreenTimeAction[] = [];
    let returnedDuringBreak = false;
    if (s.present) {
      if (now - (s.lastSeen ?? now) < this.config.gapSeconds * 1000) {
        // a short absence keeps the session, but is not time at the computer: it was counted and never taken back.
        // A look or two the detector missed still is: a lost look cost every session 5 s.
        if (input.present || now - (s.lastSeen ?? now) <= FLICKER_MS) this.count(step, now, timeZone);
      } else {
        // away longer than the gap: the session is over, the break starts when the child was last seen
        s.present = false;
        s.leftAt = s.lastSeen;
        this.logSessionEnd(s.leftAt ?? now);
        if (!s.escalation || !LASTING.has(s.escalation.reason)) s.escalation = undefined;
        s.name = undefined;
        s.attributeYes = undefined;
      }
    } else if (s.candidateSince !== undefined && now - s.candidateSince >= this.config.minPresenceSeconds * 1000) {
      s.present = true;
      const away = s.leftAt === undefined ? Infinity : s.candidateSince - s.leftAt;
      if (s.escalation && away > ESCALATION_MEMORY_MS) s.escalation = undefined;
      // a due break is added up over the absences (the parents' choice): back early and away again, the child takes
      // only the rest of it; before it is due, only one absence as long as a break counts as one
      const due = s.workMs >= this.config.sessionMinutes * MINUTE;
      const rest = due ? (s.restMs ?? 0) + away : away;
      const rested = rest >= this.config.breakMinutes * MINUTE;
      if (rested) {
        s.workMs = 0;
        s.restMs = undefined;
      } else if (due) {
        s.restMs = rest;
        returnedDuringBreak = true;
      }
      // the first seconds of the session were already at the computer
      this.count(now - s.candidateSince, now, timeZone);
      this.logSessionStart(s.candidateSince, timeZone, rested && s.leftAt !== undefined);
    }

    if (!s.present) return actions;

    const reason = this.reason(now, timeZone);
    if (!reason || (input.quiet && reason !== 'bedtime')) {
      s.escalation = undefined;
      return actions;
    }

    // said only to a child seen in this look: a step due in the minute after the child got up (the session runs on
    // through the gap) went to an empty room and was reported as a reminder let pass
    if (!input.present) return actions;

    const repeatMs = this.config.repeatMinutes * MINUTE;
    const e = s.escalation;
    if (e?.reason !== reason) {
      s.escalation = { reason, level: 1, at: now, repeats: 0, since: now };
      this.logReminder(reason, now, timeZone);
      const remaining = returnedDuringBreak && reason === 'break' && this.config.breakReminder;
      actions.push({ type: 'speak', kind: remaining ? 'remaining' : 'nudge', facts: this.facts(now, input) });
      return actions;
    }
    if (now - e.at < repeatMs) return actions;
    if (e.level >= 3) {
      if (e.repeats >= this.config.maxRepeats) return actions;
      e.repeats++;
    } else {
      e.level++;
      this.logReminderLevel(e, timeZone);
    }
    e.at = now;
    actions.push({ type: 'speak', kind: 'nudge', facts: this.facts(now, input) });
    if (e.level === 3 && e.repeats === 0) actions.push({ type: 'notify', facts: this.facts(now, input) });
    return actions;
  }

  /** Why the child should not be at the computer now, the strongest reason first. */
  reason(now: number, timeZone: string): Reason | undefined {
    if (this.state.grantUntil !== undefined && now < this.state.grantUntil) return undefined;
    if (activeInterval(this.config.bedtime, now, timeZone)) return 'bedtime';
    if (this.config.dailyMinutes && this.state.todayMs >= this.config.dailyMinutes * MINUTE) return 'daily_limit';
    if (this.state.workMs >= this.config.sessionMinutes * MINUTE) return 'break';
    return undefined;
  }

  /** A parent gives more time: the limits wait that many minutes from now. */
  extend(minutes: number, now: number): void {
    this.state.grantUntil = Math.max(this.state.grantUntil ?? now, now) + minutes * MINUTE;
    this.state.escalation = undefined;
  }

  /** A parent lets the child skip the next break: the time since the last break starts over. */
  skipBreak(): void {
    this.state.workMs = 0;
    this.state.restMs = undefined;
    this.state.escalation = undefined;
  }

  /** What is left of the due break: the rest taken before and the absence running now are off it. */
  private breakLeft(now: number): number {
    const s = this.state;
    const away = !s.present && s.leftAt !== undefined ? Math.max(0, now - s.leftAt) : 0;
    return this.config.breakMinutes * MINUTE - (s.restMs ?? 0) - away;
  }

  facts(now: number, input: { timeZone: string; language: string }): Facts {
    const { timeZone } = input;
    const s = this.state;
    const c = this.config;
    const reason = this.reason(now, timeZone) ?? s.escalation?.reason ?? 'break';
    const bed = activeInterval(c.bedtime, now, timeZone);
    const nextBed = bed ? undefined : nextIntervalStart(c.bedtime, now, timeZone);
    // the reminder of the rest of the break, the status and the answer name the same end: when the child is away, or
    // if the child leaves now
    const left = Math.max(0, this.breakLeft(now));
    const breakEnds = now + left;

    let nextAllowed: number;
    if (reason === 'bedtime' && bed) nextAllowed = bed.to;
    else if (reason === 'daily_limit') {
      // the next day, or the end of the night if a bedtime runs over midnight
      const tomorrow = addDays(localTime(now, timeZone).date, 1);
      const midnight = activeInterval(c.bedtime, startOfDay(tomorrow, timeZone), timeZone);
      nextAllowed = midnight ? midnight.to : startOfDay(tomorrow, timeZone);
    } else nextAllowed = breakEnds;

    const today = localTime(now, timeZone).date;
    // part of the break taken (away now, or back early): what is left of it
    const taken = s.present ? (s.restMs ?? 0) > 0 : s.leftAt !== undefined;
    const remaining = reason === 'break' && taken ? left : undefined;
    return {
      now: formatClock(now, timeZone),
      childName: s.name && !c.childName ? s.name : c.childName,
      language: input.language,
      reason,
      level: s.escalation?.level ?? 1,
      sessionMinutes: Math.floor(s.workMs / MINUTE),
      sessionLimit: c.sessionMinutes,
      todayMinutes: Math.floor(s.todayMs / MINUTE),
      ...(c.dailyMinutes ? { dailyLimit: c.dailyMinutes } : {}),
      breakMinutes: c.breakMinutes,
      ...(reason === 'break' ? { breakEndsAt: formatClock(breakEnds, timeZone) } : {}),
      ...(remaining !== undefined && remaining > 0 ? { breakMinutesLeft: Math.ceil(remaining / MINUTE) } : {}),
      ...(bed ? { bedtimeFrom: formatClock(bed.from, timeZone), wakeAt: formatClock(bed.to, timeZone) } : {}),
      ...(nextBed !== undefined ? { bedtimeFrom: formatClock(nextBed, timeZone) } : {}),
      nextAllowedAt: formatClock(nextAllowed, timeZone),
      nextAllowedDay: localTime(nextAllowed, timeZone).date === today ? 'today' : 'tomorrow',
    };
  }

  /**
   * The answer to "how long": minutes of the break left, or minutes of play before the next limit. At the computer when
   * the break is due, what of it is left to take away from it, the minutes the reminder names. Minutes of play are
   * rounded down (0: less than a minute) and of a break up: the answer never promises more play than there is.
   */
  standing(now: number, timeZone: string): Standing {
    const s = this.state;
    const c = this.config;
    if (s.grantUntil !== undefined && now < s.grantUntil) return { kind: 'granted', minutes: Math.floor((s.grantUntil - now) / MINUTE) };
    const reason = this.reason(now, timeZone);
    if (reason === 'bedtime' || reason === 'daily_limit') {
      const facts = this.facts(now, { timeZone, language: '' });
      return { kind: reason, next: facts.nextAllowedAt, day: facts.nextAllowedDay };
    }
    const breakMs = c.breakMinutes * MINUTE;
    if (reason === 'break') {
      const left = this.breakLeft(now);
      if (left > 0) return { kind: s.present ? 'break_due' : 'break', minutes: Math.ceil(left / MINUTE) };
    }
    // the break is taken, or away for a whole break: the next session starts from nothing
    const workMs = reason === 'break' || (!s.present && s.leftAt !== undefined && now - s.leftAt >= breakMs) ? 0 : s.workMs;
    const limits: [number, Reason][] = [[c.sessionMinutes * MINUTE - workMs, 'break']];
    if (c.dailyMinutes) limits.push([c.dailyMinutes * MINUTE - s.todayMs, 'daily_limit']);
    const bed = nextIntervalStart(c.bedtime, now, timeZone);
    if (bed !== undefined) limits.push([bed - now, 'bedtime']);
    const [ms, until] = limits.reduce((first, limit) => (limit[0] < first[0] ? limit : first));
    return { kind: 'play', minutes: Math.max(0, Math.floor(ms / MINUTE)), until };
  }

  /** VOICE said this step of a reminder: the child heard it. */
  noteSaid(since: number, reason: Reason, level: number, timeZone: string): void {
    const entry = this.reminderOf(since, reason, timeZone);
    if (entry && !entry.said?.includes(level)) entry.said = [...(entry.said ?? []), level].sort();
  }

  /** The parents' notice of a reminder went. */
  noteTold(since: number, reason: Reason, timeZone: string): void {
    const entry = this.reminderOf(since, reason, timeZone);
    if (entry) entry.told = true;
  }

  /**
   * Sight is back after a blind while from `from` to `to`. Shorter than a break, the blindness is cut out of the clock:
   * the gap, the break and the reminders go on as if it never happened. As long as a break or longer, VOICE cannot
   * vouch that the child stayed: the session ended where sight was lost. Frozen without a bound, a break begun in the
   * evening and a camera off for the night said "the break is not over" in the morning and told the parents
   * yesterday's minutes.
   */
  private endBlindness(from: number, to: number, timeZone: string): void {
    const s = this.state;
    const blindMs = Math.max(0, to - from);
    s.blindSince = undefined;
    // the journal says the while was not watched: no play then is not "did not play"
    if (blindMs >= MINUTE) this.logUnseen(from, to, timeZone);
    if (blindMs < this.config.breakMinutes * MINUTE) {
      if (s.lastSeen !== undefined) s.lastSeen += blindMs;
      if (s.candidateSince !== undefined) s.candidateSince += blindMs;
      if (!s.present && s.leftAt !== undefined) s.leftAt += blindMs;
      if (s.escalation) s.escalation.at += blindMs;
      return;
    }
    this.loseSight();
  }

  /**
   * No look from `from` to `to`: the scenario off, VOICE or the server restarting. Nothing of it is known and nothing is
   * moved: the break or the session ran on, as they most likely did. Cut out of the clock like a blind camera, a
   * restart during a break moved its end, and the child back at the time VOICE had named was reminded and reported to
   * the parents. A pause longer than PAUSE_LIMIT_MS (and than a break) ends the session where the child was last seen:
   * two days off were kept as one evening of 2930 minutes.
   */
  private endPause(from: number, to: number, timeZone: string): void {
    if (to - from >= MINUTE) this.logUnseen(from, to, timeZone);
    if (to - from >= Math.max(this.config.breakMinutes * MINUTE, PAUSE_LIMIT_MS)) this.loseSight();
  }

  /** VOICE cannot vouch that the child stayed: the session ended where the child was last seen. */
  private loseSight(): void {
    const s = this.state;
    s.candidateSince = undefined;
    if (!s.present) return;
    s.present = false;
    s.leftAt = s.lastSeen;
    if (s.leftAt !== undefined) this.logSessionEnd(s.leftAt);
    s.escalation = undefined;
    s.name = undefined;
    s.attributeYes = undefined;
  }

  private count(ms: number, now: number, timeZone: string): void {
    if (ms <= 0) return;
    const s = this.state;
    s.workMs += ms;
    s.todayMs += ms;
    const date = localTime(now, timeZone).date;
    s.history[date] = Math.round(((s.history[date] ?? 0) * MINUTE + ms) / 1000) / 60;
  }

  private rollDate(now: number, timeZone: string): void {
    const s = this.state;
    const date = localTime(now, timeZone).date;
    if (date === s.date) return;
    s.date = date;
    s.todayMs = 0;
    const oldest = addDays(date, -HISTORY_DAYS);
    for (const key of Object.keys(s.history)) if (key < oldest) delete s.history[key];
    for (const key of Object.keys(s.log ?? {})) if (key < oldest) delete s.log![key];
  }

  /** The journal begins (VOICE 0.4.0 kept none): a session running then is in it from now. */
  private startLog(now: number, timeZone: string): void {
    const s = this.state;
    if (s.logSince !== undefined) return;
    s.logSince = now;
    if (s.present) this.logSessionStart(now, timeZone, false);
  }

  private dayLog(date: string): DayLog {
    const log = (this.state.log ??= {});
    return (log[date] ??= { sessions: [], reminders: [] });
  }

  /** A day keeps so many entries of a kind: a flickering detector must not grow the state, the report says it is capped. */
  private push<T>(day: DayLog, list: T[], entry: T): void {
    if (list.length < LOG_DAY_ENTRIES) list.push(entry);
    else day.capped = true;
  }

  private logSessionStart(at: number, timeZone: string, rested: boolean): void {
    const day = this.dayLog(localTime(at, timeZone).date);
    this.push(day, day.sessions, rested ? { from: at, rested: true as const } : { from: at });
  }

  /** Filed by the day it ended: one begun days ago (the scenario off) must not bring back a day the history let go. */
  private logUnseen(from: number, to: number, timeZone: string): void {
    const day = this.dayLog(localTime(to, timeZone).date);
    this.push(day, (day.unseen ??= []), { from, to });
  }

  /** The open session ends: the last one without an end, whatever the day it began. */
  private logSessionEnd(at: number): void {
    const days = Object.keys(this.state.log ?? {})
      .sort()
      .reverse();
    for (const date of days) {
      const open = [...this.state.log![date].sessions].reverse().find((session) => session.to === undefined);
      if (open) {
        open.to = Math.max(open.from, at);
        return;
      }
    }
  }

  private logReminder(reason: Reason, at: number, timeZone: string): void {
    const day = this.dayLog(localTime(at, timeZone).date);
    this.push(day, day.reminders, { at, reason, level: 1, said: [] });
  }

  /** The child went on after a reminder: its entry (found by when it began) takes the new step. */
  private logReminderLevel(e: Escalation, timeZone: string): void {
    if (e.since === undefined) return;
    const entry = this.reminderOf(e.since, e.reason, timeZone);
    if (entry) entry.level = e.level;
  }

  private reminderOf(since: number, reason: Reason, timeZone: string): LoggedReminder | undefined {
    return this.state.log?.[localTime(since, timeZone).date]?.reminders.find((r) => r.at === since && r.reason === reason);
  }
}

/**
 * Midnight of the local date; the day starts at 01:00 where the clocks jump at midnight. Stepping whole hours from the
 * present minute never met 00:00 unless the minute was :00, and the fallback was midnight UTC: "играть можно будет
 * завтра в 03:00" in Moscow.
 */
function startOfDay(date: string, timeZone: string): number {
  return instantOf(date, '00:00', timeZone);
}
