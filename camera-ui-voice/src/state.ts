import type { DayLog, ScreenTimeState } from './screenTime.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const REASONS = ['break', 'bedtime', 'daily_limit'];

/** A day of the journal as written by the engine; anything else is not trusted. */
function validDay(day: unknown): day is DayLog {
  if (!object(day) || !Array.isArray(day.sessions) || !Array.isArray(day.reminders)) return false;
  const step = (value: unknown, min: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= 3;
  const flag = (value: unknown) => value === undefined || value === true;
  const session = (s: unknown) => object(s) && counter(s.from) && (s.to === undefined || counter(s.to)) && flag(s.rested);
  const reminder = (r: unknown) =>
    object(r) && counter(r.at) && REASONS.includes(String(r.reason)) && step(r.level, 1) && (r.said === undefined || step(r.said, 0)) && flag(r.told);
  const unseen = (u: unknown) => object(u) && counter(u.from) && counter(u.to);
  return (
    day.sessions.every(session) &&
    day.reminders.every(reminder) &&
    (day.unseen === undefined || (Array.isArray(day.unseen) && day.unseen.every(unseen))) &&
    flag(day.capped)
  );
}

/** Persisted JSON is an input too: a damaged entry must not break every camera on startup. */
export function restoreScreenTime(value: unknown): Record<string, ScreenTimeState> {
  if (!object(value) || !object(value.screenTime)) return {};
  const valid = (state: unknown): state is ScreenTimeState => {
    if (!object(state) || typeof state.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.date)) return false;
    if (!counter(state.todayMs) || !counter(state.workMs) || typeof state.present !== 'boolean') return false;
    if (!object(state.history) || Object.values(state.history).some((minutes) => !counter(minutes))) return false;
    for (const key of ['candidateSince', 'lastSeen', 'leftAt', 'restMs', 'lastTick', 'grantUntil', 'blindSince', 'logSince']) {
      if (state[key] !== undefined && !counter(state[key])) return false;
    }
    if (state.name !== undefined && typeof state.name !== 'string') return false;
    // a damaged journal costs the journal, not the minutes and the state of the evening
    if (state.log !== undefined && (!object(state.log) || !Object.entries(state.log).every(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && validDay(day)))) {
      delete state.log;
    }
    if (state.attributeYes !== undefined && typeof state.attributeYes !== 'boolean') return false;
    const escalation = state.escalation;
    if (
      escalation !== undefined &&
      (!object(escalation) ||
        !['break', 'bedtime', 'daily_limit'].includes(String(escalation.reason)) ||
        !counter(escalation.at) ||
        !counter(escalation.level) ||
        !Number.isInteger(escalation.level) ||
        escalation.level < 1 ||
        escalation.level > 3 ||
        !counter(escalation.repeats) ||
        !Number.isInteger(escalation.repeats) ||
        (escalation.since !== undefined && !counter(escalation.since)))
    )
      return false;
    return true;
  };
  return Object.fromEntries(Object.entries(value.screenTime).filter((entry): entry is [string, ScreenTimeState] => valid(entry[1])));
}
