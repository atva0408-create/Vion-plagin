import type { ScreenTimeState } from './screenTime.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Persisted JSON is an input too: a damaged entry must not break every camera on startup. */
export function restoreScreenTime(value: unknown): Record<string, ScreenTimeState> {
  if (!object(value) || !object(value.screenTime)) return {};
  const valid = (state: unknown): state is ScreenTimeState => {
    if (!object(state) || typeof state.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.date)) return false;
    if (!counter(state.todayMs) || !counter(state.workMs) || typeof state.present !== 'boolean') return false;
    if (!object(state.history) || Object.values(state.history).some((minutes) => !counter(minutes))) return false;
    for (const key of ['candidateSince', 'lastSeen', 'leftAt', 'lastTick', 'grantUntil', 'blindSince']) {
      if (state[key] !== undefined && !counter(state[key])) return false;
    }
    if (state.name !== undefined && typeof state.name !== 'string') return false;
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
        !Number.isInteger(escalation.repeats))
    )
      return false;
    return true;
  };
  return Object.fromEntries(Object.entries(value.screenTime).filter((entry): entry is [string, ScreenTimeState] => valid(entry[1])));
}
