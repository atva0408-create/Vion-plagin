/**
 * Whether a door may open for the visitor without a person pressing "Open". This is the only way the agent's
 * conversation opens anything: the LLM asks (`request_open`), this function decides, with no LLM in it.
 *
 * A door opens for:
 * - a person of the directory known strongly (face, plate, PIN) whose access holds for that door now;
 * - a guest code given for that door (checked usable when it was said);
 * - an instruction that names the door, matched strongly (or weakly when the owner agreed to that in its card).
 * It never opens for a blocked person, or while an instruction that matches says "never open".
 */
import { knownPerson } from './identify.js';
import { matchInstruction } from './instructions.js';
import { activeSpan } from './schedule.js';

import type { Candidate, Heard } from './instructions.js';
import type { GuestCode, Identification, Instruction, Person } from './types.js';

export type OpenRefusal = 'blocked' | 'never_open' | 'weak' | 'no_rule';

export type OpenDecision = { ok: true; by: string; identification?: Identification; reason: string } | { ok: false; refusal: OpenRefusal; reason: string };

export interface OpenQuestion {
  doorId: string;
  now: number;
  timeZone: string;
  identifications: Identification[];
  people: Person[];
  /** instructions of the panel that hold now */
  active: Instruction[];
  /** the instruction the visitor matched, if any */
  candidate?: Candidate;
  /** guest codes; a code said at the door is an identification whose value is the code's id */
  codes: GuestCode[];
  heard: Heard;
}

export function mayOpen(q: OpenQuestion): OpenDecision {
  const known = knownPerson(q.identifications, q.people);
  if (known?.person.role === 'blocked' && known.strength === 'strong') {
    return { ok: false, refusal: 'blocked', reason: `${known.person.name} is on the "do not open" list` };
  }
  const family = known?.strength === 'strong' && known.person.role === 'family';
  const forbidding = matchInstruction(
    q.active.filter((instruction) => instruction.neverOpen && !(instruction.exceptFamily && family)),
    q.identifications,
    q.heard,
  );
  const never = forbidding.best ?? forbidding.ambiguous[0];
  if (never) return { ok: false, refusal: 'never_open', reason: `instruction "${never.instruction.text}" says not to open` };

  if (known?.strength === 'strong') {
    const access = known.person.access.filter((window) => window.doors.includes(q.doorId));
    if (activeSpan(access, q.now, q.timeZone)) {
      const identification = q.identifications.find((id) => id.personId === known.person.id && id.strength === 'strong');
      return { ok: true, by: `rule:${known.person.id}`, identification, reason: `${known.person.name} may open this door now` };
    }
  }

  for (const id of q.identifications) {
    if (id.kind !== 'code') continue;
    const code = q.codes.find((c) => c.id === id.value);
    if (code?.doors.includes(q.doorId)) return { ok: true, by: `code:${code.id}`, identification: id, reason: `the guest code "${code.label}"` };
  }

  const candidate = q.candidate;
  if (candidate?.instruction.open?.includes(q.doorId)) {
    if (candidate.strength === 'strong' || candidate.instruction.openOnWeak) {
      return { ok: true, by: `instruction:${candidate.instruction.id}`, identification: candidate.identification, reason: `instruction "${candidate.instruction.text}"` };
    }
    return { ok: false, refusal: 'weak', reason: 'the instruction opens only for a visitor known by face, plate or code' };
  }
  return { ok: false, refusal: 'no_rule', reason: 'no person rule, code or instruction opens this door for this visitor' };
}
