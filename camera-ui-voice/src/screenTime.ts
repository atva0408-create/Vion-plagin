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
const MAX_STEP_MS = MINUTE;
/** An absence this short is a look the detector missed, still time at the computer. */
const FLICKER_MS = 15_000;
const HISTORY_DAYS = 30;
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
    const step = previous === undefined ? 0 : Math.max(0, Math.min(now - previous, MAX_STEP_MS));
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
    if (s.blindSince !== undefined) this.endBlindness(Math.max(0, (previous ?? now) - s.blindSince));

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
      if (rest >= this.config.breakMinutes * MINUTE) {
        s.workMs = 0;
        s.restMs = undefined;
      } else if (due) {
        s.restMs = rest;
        returnedDuringBreak = true;
      }
      // the first seconds of the session were already at the computer
      this.count(now - s.candidateSince, now, timeZone);
    }

    if (!s.present) return actions;

    const reason = this.reason(now, timeZone);
    if (!reason || (input.quiet && reason !== 'bedtime')) {
      s.escalation = undefined;
      return actions;
    }

    const repeatMs = this.config.repeatMinutes * MINUTE;
    const e = s.escalation;
    if (e?.reason !== reason) {
      s.escalation = { reason, level: 1, at: now, repeats: 0, since: now };
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

  /**
   * Sight is back after `blindMs`. Shorter than a break, the blindness is cut out of the clock: the gap, the break and
   * the reminders go on as if it never happened. As long as a break or longer, VOICE cannot vouch that the child
   * stayed: the session ended where sight was lost. Frozen without a bound, a break begun in the evening and a camera
   * off for the night said "the break is not over" in the morning and told the parents yesterday's minutes.
   */
  private endBlindness(blindMs: number): void {
    const s = this.state;
    s.blindSince = undefined;
    if (blindMs < this.config.breakMinutes * MINUTE) {
      if (s.lastSeen !== undefined) s.lastSeen += blindMs;
      if (s.candidateSince !== undefined) s.candidateSince += blindMs;
      if (!s.present && s.leftAt !== undefined) s.leftAt += blindMs;
      if (s.escalation) s.escalation.at += blindMs;
      return;
    }
    s.candidateSince = undefined;
    if (!s.present) return;
    s.present = false;
    s.leftAt = s.lastSeen;
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
