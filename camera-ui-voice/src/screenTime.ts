/**
 * The "screen time" scenario: counts the time a child spends at the computer and decides when VOICE speaks.
 *
 * The engine is plain data and arithmetic: the plugin feeds it a look at the camera every few seconds and turns what it
 * returns into speech and notifications. It never reads the clock itself, so tests move time by hand, and its state is
 * plain JSON, so a restart in the middle of a session continues where it stopped.
 */
import { MINUTE, activeInterval, addDays, formatClock, localTime, nextIntervalStart } from './time.js';

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
  minPresenceSeconds: number;
  gapSeconds: number;
}

export interface Escalation {
  reason: Reason;
  /** 1 soft, 2 firm, 3 the parents are told; later phrases repeat level 3. */
  level: number;
  at: number;
  repeats: number;
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
  lastTick?: number;
  escalation?: Escalation;
  /** Limits are lifted until then: a parent gave more time. */
  grantUntil?: number;
  name?: string;
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

export function freshState(date: string): ScreenTimeState {
  return { date, todayMs: 0, history: {}, present: false, workMs: 0 };
}

/** Longest step counted as continuous: after a restart or a stalled timer the time between is not presence. */
const MAX_STEP_MS = MINUTE;
const HISTORY_DAYS = 30;

export interface TickInput {
  now: number;
  present: boolean;
  name?: string;
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
    const step = s.lastTick === undefined ? 0 : Math.max(0, Math.min(now - s.lastTick, MAX_STEP_MS));
    s.lastTick = now;
    this.rollDate(now, timeZone);

    if (input.present) {
      s.lastSeen = now;
      s.candidateSince ??= now;
      if (input.name) s.name = input.name;
    } else {
      s.candidateSince = undefined;
    }

    const actions: ScreenTimeAction[] = [];
    let returnedDuringBreak = false;
    if (s.present) {
      if (now - (s.lastSeen ?? now) < this.config.gapSeconds * 1000) {
        this.count(step, now, timeZone);
      } else {
        // away longer than the gap: the session is over, the break starts when the child was last seen
        s.present = false;
        s.leftAt = s.lastSeen;
        s.escalation = undefined;
        s.name = undefined;
      }
    } else if (s.candidateSince !== undefined && now - s.candidateSince >= this.config.minPresenceSeconds * 1000) {
      s.present = true;
      const away = s.leftAt === undefined ? Infinity : s.candidateSince - s.leftAt;
      if (away >= this.config.breakMinutes * MINUTE) s.workMs = 0;
      else returnedDuringBreak = s.workMs >= this.config.sessionMinutes * MINUTE;
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
      s.escalation = { reason, level: 1, at: now, repeats: 0 };
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
    this.state.escalation = undefined;
  }

  facts(now: number, input: { timeZone: string; language: string }): Facts {
    const { timeZone } = input;
    const s = this.state;
    const c = this.config;
    const reason = this.reason(now, timeZone) ?? s.escalation?.reason ?? 'break';
    const bed = activeInterval(c.bedtime, now, timeZone);
    const nextBed = bed ? undefined : nextIntervalStart(c.bedtime, now, timeZone);
    const breakFrom = s.present || s.leftAt === undefined ? now : s.leftAt;
    const breakEnds = breakFrom + c.breakMinutes * MINUTE;

    let nextAllowed: number;
    if (reason === 'bedtime' && bed) nextAllowed = bed.to;
    else if (reason === 'daily_limit') {
      // the next day, or the end of the night if a bedtime runs over midnight
      const tomorrow = addDays(localTime(now, timeZone).date, 1);
      const midnight = activeInterval(c.bedtime, startOfDay(tomorrow, now, timeZone), timeZone);
      nextAllowed = midnight ? midnight.to : startOfDay(tomorrow, now, timeZone);
    } else nextAllowed = breakEnds;

    const today = localTime(now, timeZone).date;
    // back before the break was over: what is left of it, counted from the moment the child left
    const remaining = reason === 'break' && s.leftAt !== undefined ? s.leftAt + c.breakMinutes * MINUTE - now : undefined;
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

function startOfDay(date: string, near: number, timeZone: string): number {
  // midnight of the local date; the day may start at 01:00 where the clocks jump at midnight
  for (let step = -48; step <= 48; step++) {
    const probe = near - (near % MINUTE) + step * 60 * MINUTE;
    const t = localTime(probe, timeZone);
    if (t.date === date && t.hour === 0 && t.minute === 0) return probe;
  }
  return Date.parse(`${date}T00:00:00Z`);
}
