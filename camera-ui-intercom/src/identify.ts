/**
 * Who is at the door, and how sure: a face or a plate of the people directory seen twice is strong; once, or a name
 * the visitor said, or what the picture shows, is weak. Strong opens doors and lets the agent say private things;
 * weak only lets it pass an ordinary message (INTERCOM_SCENARIOS.md §0, rule 2).
 */
import type { Identification, Person } from './types.js';

/** The recorder's strict face threshold (camera-ui-nvr/src/faces.ts): below it a name is a guess. */
export const STRONG_FACE_SCORE = 0.55;
/** Sightings of the same face or plate within a visit that make it strong. */
export const STRONG_SIGHTINGS = 2;

export interface FaceSighting {
  name: string;
  score: number;
  at: number;
}

export interface PlateSighting {
  plate: string;
  score: number;
  at: number;
}

// Russian plates are read in either alphabet: А001АА and A001AA are the same plate
const CYRILLIC_TO_LATIN: Record<string, string> = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' };

/** A plate as compared: upper case, Latin look-alikes for Cyrillic letters, no spaces, dashes or dots. */
export function normalizePlate(text: string): string {
  return [...text.toUpperCase()]
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join('')
    .replace(/[\s\-.·]/g, '');
}

export function personOfFace(people: Person[], name: string): Person | undefined {
  const lower = name.toLowerCase();
  return people.find((person) => person.faceNames.some((face) => face.toLowerCase() === lower));
}

export function personOfPlate(people: Person[], plate: string): Person | undefined {
  const wanted = normalizePlate(plate);
  return people.find((person) => person.plates.some((p) => normalizePlate(p) === wanted));
}

/** Faces seen during the visit, one identification per name: strong when a known person was seen clearly twice. */
export function faceIdentifications(sightings: FaceSighting[], people: Person[]): Identification[] {
  const byName = new Map<string, FaceSighting[]>();
  for (const sighting of sightings) {
    if (!sighting.name || sighting.name === 'unknown') continue;
    const list = byName.get(sighting.name) ?? [];
    list.push(sighting);
    byName.set(sighting.name, list);
  }
  const out: Identification[] = [];
  for (const [name, list] of byName) {
    const clear = list.filter((s) => s.score >= STRONG_FACE_SCORE);
    const person = personOfFace(people, name);
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    out.push({
      kind: 'face',
      value: name,
      personId: person?.id,
      score: best.score,
      strength: person && clear.length >= STRONG_SIGHTINGS ? 'strong' : 'weak',
      at: (clear[STRONG_SIGHTINGS - 1] ?? best).at,
    });
  }
  return out;
}

/** Plates seen during the visit: strong when the same plate was read twice (a person's plate or one an instruction expects). */
export function plateIdentifications(sightings: PlateSighting[], people: Person[]): Identification[] {
  const byPlate = new Map<string, PlateSighting[]>();
  for (const sighting of sightings) {
    const plate = normalizePlate(sighting.plate);
    if (plate.length < 4) continue;
    const list = byPlate.get(plate) ?? [];
    list.push(sighting);
    byPlate.set(plate, list);
  }
  const out: Identification[] = [];
  for (const [plate, list] of byPlate) {
    const person = personOfPlate(people, plate);
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    out.push({
      kind: 'plate',
      value: plate,
      personId: person?.id,
      score: best.score,
      strength: list.length >= STRONG_SIGHTINGS ? 'strong' : 'weak',
      at: (list[STRONG_SIGHTINGS - 1] ?? best).at,
    });
  }
  return out;
}

/** The person the visit is about, by the strongest identification that names one. */
export function knownPerson(identifications: Identification[], people: Person[]): { person: Person; strength: 'weak' | 'strong' } | undefined {
  const ranked = [...identifications].filter((id) => id.personId).sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1));
  for (const id of ranked) {
    const person = people.find((p) => p.id === id.personId);
    if (person) return { person, strength: id.strength };
  }
  return undefined;
}

export function isStrong(identifications: Identification[], personId?: string): boolean {
  return identifications.some((id) => id.strength === 'strong' && (personId === undefined || id.personId === personId));
}
