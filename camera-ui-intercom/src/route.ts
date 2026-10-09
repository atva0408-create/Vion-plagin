/**
 * What a press does, decided when it comes: whom to ring, whether silently, when the agent answers, whether the house
 * hears a chime, and whether a rule opens without a ring at all.
 *
 * In order:
 * 1. a blocked person known strongly: no ring, the agent answers briefly;
 * 2. a person who may come in without a ring, known strongly, with a door open to them now: open, no ring;
 * 3. a panel silenced after rings with nobody there: no ring for a while;
 * 4. the mode: everyone, nobody, only family and the expected, silently, or the listed users;
 *    an instruction that says "call me" rings even when the mode would not.
 * The agent answers after the mode's delay, or at once when nobody is rung.
 */
import type { CurrentMode } from './modes.js';
import type { ModeSettings, Person, Strength } from './types.js';

export interface RouteInput {
  mode: CurrentMode;
  settings: ModeSettings;
  /** users of the panel, 'all' already resolved */
  recipients: string[];
  known?: { person: Person; strength: Strength };
  /** a door a rule opens for the known person now (only looked for when the person may come in without a ring) */
  autoOpenDoorId?: string;
  /** an instruction of the moment expects this visitor and was matched strongly at the press */
  expected: boolean;
  /** an instruction of the moment says to call the owner whatever the mode */
  forceCall: boolean;
  /** the panel rang with nobody there several times lately */
  silenced: boolean;
}

export interface Route {
  ring: string[];
  /** phones ring without sound (do not disturb) */
  silent: boolean;
  /** when the agent answers; null: it does not */
  agentAfterMs: number | null;
  chime: boolean;
  autoOpenDoorId?: string;
  blocked?: Person;
  reason: string;
}

export function route(input: RouteInput): Route {
  const { settings, known } = input;
  const agentAt = (ring: string[]) => (settings.agentAfterSeconds === null ? null : ring.length ? settings.agentAfterSeconds * 1000 : 0);

  if (known?.strength === 'strong' && known.person.role === 'blocked') {
    return { ring: [], silent: false, agentAfterMs: 0, chime: false, blocked: known.person, reason: `${known.person.name} is on the "do not open" list` };
  }
  if (known?.strength === 'strong' && known.person.openWithoutRing && input.autoOpenDoorId) {
    return { ring: [], silent: false, agentAfterMs: 0, chime: false, autoOpenDoorId: input.autoOpenDoorId, reason: `${known.person.name} comes in without a ring` };
  }
  if (input.silenced && !input.forceCall) {
    return { ring: [], silent: false, agentAfterMs: agentAt([]), chime: false, reason: 'rang with nobody there several times: silenced for a while' };
  }

  let ring: string[];
  let reason: string;
  switch (settings.ring) {
    case 'all':
      ring = input.recipients;
      reason = `mode ${input.mode.mode}: the panel's users`;
      break;
    case 'silent':
      ring = input.recipients;
      reason = `mode ${input.mode.mode}: phones without sound`;
      break;
    case 'listed':
      ring = settings.userIds;
      reason = `mode ${input.mode.mode}: the listed users`;
      break;
    case 'family_and_expected': {
      const family = known?.strength === 'strong' && known.person.role === 'family';
      ring = family || input.expected ? input.recipients : [];
      const who = family ? 'family' : input.expected ? 'an expected visitor' : 'the agent answers';
      reason = `mode ${input.mode.mode}: ${who}`;
      break;
    }
    case 'none':
      ring = [];
      reason = `mode ${input.mode.mode}: nobody is called`;
      break;
  }
  if (!ring.length && input.forceCall) {
    ring = input.recipients;
    reason = 'an instruction says to call';
  }
  return { ring, silent: settings.ring === 'silent', agentAfterMs: agentAt(ring), chime: settings.chime && ring.length > 0, reason };
}
