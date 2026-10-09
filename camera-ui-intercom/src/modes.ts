/**
 * The mode of the house decides who a panel calls and when the agent answers.
 *
 * - home: everyone of the panel, the agent after 25 s;
 * - away: nobody is called, the agent answers at once, the owners get what happened;
 * - night: only family (known by face), the visitors an instruction expects, and emergencies; the agent answers the
 *   rest at once;
 * - do not disturb: phones without sound, the agent after 5 s;
 * - child home alone: the listed parents' phones, not the house; the agent after 20 s.
 *
 * A mode set by hand may have an end ("away until Sunday 20:00"); the plugin brings back "home" then. The night comes
 * from a schedule and only replaces "home": a mode set by hand wins over it.
 */
import { activeSpan } from './schedule.js';

import type { ModeId, ModeSettings, ModeState, WeekWindow } from './types.js';

export const DEFAULT_MODE_SETTINGS: Record<ModeId, ModeSettings> = {
  home: { agentAfterSeconds: 25, ring: 'all', userIds: [], chime: true },
  away: { agentAfterSeconds: 0, ring: 'none', userIds: [], chime: false },
  night: { agentAfterSeconds: 0, ring: 'family_and_expected', userIds: [], chime: false },
  dnd: { agentAfterSeconds: 5, ring: 'silent', userIds: [], chime: false },
  child: { agentAfterSeconds: 20, ring: 'listed', userIds: [], chime: false },
};

export const DEFAULT_NIGHT: WeekWindow = { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '23:00', to: '07:00' };

export interface CurrentMode {
  mode: ModeId;
  /** where it comes from: set by hand (with its end), or the night schedule */
  source: 'set' | 'night' | 'default';
  until?: number;
}

/** The mode at the moment: a mode set by hand that has not ended, else the night when its schedule holds, else home. */
export function currentMode(state: ModeState, night: WeekWindow[], now: number, timeZone: string): CurrentMode {
  if (state.mode !== 'home' && (state.until === undefined || now < state.until)) return { mode: state.mode, source: 'set', until: state.until };
  const span = activeSpan(night, now, timeZone);
  if (span) return { mode: 'night', source: 'night', until: span.to };
  return { mode: 'home', source: 'default' };
}

/** A mode set by hand whose end has passed: the plugin turns it back to home and says so. */
export function expiredMode(state: ModeState, now: number): boolean {
  return state.mode !== 'home' && state.until !== undefined && now >= state.until;
}
