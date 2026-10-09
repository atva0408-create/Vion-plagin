/**
 * Which instruction a visitor is: decided by code, never by the LLM. A face, a plate or a guest code of the
 * instruction is strong; the service, the name or the kind of visit the visitor said is weak. Strong beats weak, and
 * a more particular match beats a vaguer one; two instructions matching alike make the agent ask, not guess.
 */
import { findCompany, sameCompany } from './companies.js';
import { normalizePlate } from './identify.js';
import { instructionActive } from './schedule.js';

import type { Category, Identification, Instruction, Strength } from './types.js';

/** What the visitor said about themselves (the agent's LLM reads it out of their words). */
export interface Heard {
  name?: string | null;
  company?: string | null;
  category?: Category | null;
}

export type MatchBy = 'person' | 'plate' | 'code' | 'company' | 'name' | 'category' | 'anyone';

export interface Candidate {
  instruction: Instruction;
  strength: Strength;
  by: MatchBy;
  identification?: Identification;
}

const RANK: Record<MatchBy, number> = { person: 0, plate: 0, code: 0, company: 1, name: 2, category: 3, anyone: 4 };

/** Instructions of the panel that hold at the moment and are not done or cancelled. */
export function activeInstructions(all: Instruction[], panelId: string, now: number, timeZone: string): Instruction[] {
  return all.filter(
    (instruction) =>
      !instruction.cancelledAt &&
      !(instruction.once && instruction.doneAt) &&
      (instruction.panels === 'all' || instruction.panels.includes(panelId)) &&
      instructionActive(instruction.when, now, timeZone),
  );
}

const firstName = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}]+/u)
    .filter(Boolean)[0] ?? '';

/** How one instruction matches the visit, if it does. */
function matchOne(instruction: Instruction, ids: Identification[], heard: Heard): Candidate | undefined {
  const expect = instruction.expect;
  const found: Candidate[] = [];
  for (const id of ids) {
    if (id.personId && expect.personIds?.includes(id.personId)) found.push({ instruction, strength: id.strength, by: 'person', identification: id });
    if (id.kind === 'plate' && expect.plates?.some((plate) => normalizePlate(plate) === normalizePlate(id.value))) {
      found.push({ instruction, strength: id.strength, by: 'plate', identification: id });
    }
    if (id.kind === 'code' && expect.guestCodeId && id.value === expect.guestCodeId) found.push({ instruction, strength: 'strong', by: 'code', identification: id });
  }
  if (heard.company && expect.companies?.some((company) => sameCompany(company, heard.company!))) found.push({ instruction, strength: 'weak', by: 'company' });
  if (heard.name && expect.names?.some((name) => firstName(name) === firstName(heard.name!))) found.push({ instruction, strength: 'weak', by: 'name' });
  const heardCategory = heard.category ?? findCompany(heard.company)?.category;
  if (expect.category && heardCategory === expect.category && !expect.companies?.length && !expect.names?.length) {
    found.push({ instruction, strength: 'weak', by: 'category' });
  }
  if (expect.label === '*') found.push({ instruction, strength: 'weak', by: 'anyone' });
  return found.sort((a, b) => compare(a, b))[0];
}

function compare(a: Candidate, b: Candidate): number {
  if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
  return RANK[a.by] - RANK[b.by];
}

export interface MatchResult {
  best?: Candidate;
  /** instructions matching as well as the best one: the agent asks the visitor instead of choosing */
  ambiguous: Candidate[];
}

export function matchInstruction(active: Instruction[], ids: Identification[], heard: Heard): MatchResult {
  const candidates = active.map((instruction) => matchOne(instruction, ids, heard)).filter((c): c is Candidate => Boolean(c));
  candidates.sort(compare);
  const best = candidates[0];
  if (!best) return { ambiguous: [] };
  const ties = candidates.filter((c) => compare(c, best) === 0);
  if (ties.length > 1) return { ambiguous: ties };
  return { best, ambiguous: [] };
}

/** Whether a match is sure enough for what the instruction gives (its message, its doors). */
export function enough(candidate: Candidate): boolean {
  return candidate.instruction.minIdentification === 'weak' || candidate.strength === 'strong';
}

/** The kinds of visits instructions of the moment expect, without names or messages: what the agent may ask about. */
export function expectedKinds(active: Instruction[]): Category[] {
  const kinds = new Set<Category>();
  for (const instruction of active) {
    const category = instruction.expect.category ?? instruction.expect.companies?.map((c) => findCompany(c)?.category).find(Boolean);
    if (category) kinds.add(category);
  }
  return [...kinds];
}
