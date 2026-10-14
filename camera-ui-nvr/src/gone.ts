// When a thing that lay in the picture of a camera went: «на камере в прихожей лежал телефон — когда он исчез». The words
// are found in a picture of the recording by the text finder of a detection plugin (the place of the thing); then the
// recording is halved, a look at a time telling whether the thing is still where it lay; then the last minute is looked
// at twice a second, the place compared with how it was: the thing went after the last moment the place looked as it
// did. A person standing over the thing for a while is not its going: the place looks as it was again after them.
// What reads the recording and asks the finder is given (index.ts), so the halving is tested on its own.

/** A place in a picture, as shares of it (the finder's boxes). */
export interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Stretch {
  startMs: number;
  endMs: number;
}

export type FinderAnswer = { english: string; foundScore: number; boxes: (Place & { score: number })[] } | { problem: string };

export interface GoneSources {
  /** the recorded stretches of the camera between the two times, in time order */
  recorded(fromMs: number, toMs: number): Stretch[];
  /** the whole picture of the recording at a time (JPEG), undefined where none can be read */
  frame(atMs: number): Promise<Uint8Array | undefined>;
  /** the places of the words in a picture */
  find(picture: Uint8Array): Promise<FinderAnswer>;
  /** the patch of a region of a picture: PATCH × PATCH gray pixels */
  patchOf(picture: Uint8Array, region: Place): Promise<Uint8Array | undefined>;
  /** the patches of a region in the recording from one time to another, one every `stepMs` of recorded time */
  patches(fromMs: number, toMs: number, region: Place, stepMs: number): Promise<{ atMs: number; pixels: Uint8Array }[]>;
}

export interface GoneAnswer {
  state: 'gone' | 'still-there' | 'never-seen' | 'no-recording' | 'no-finder' | 'failed';
  /** the words as the finder took them (in English) */
  english?: string;
  /** where the thing lay */
  place?: Place;
  /** when it was first seen in the time asked */
  seenMs?: number;
  /** the last moment the place looked as it did, and the first it did not (gone); still-there: the last look */
  lastSeenMs?: number;
  goneMs?: number;
  /** no recording between the two: it went somewhen in that pause */
  gap?: boolean;
  /** the pictures of those two moments, for the one who asked to look at */
  before?: Uint8Array;
  after?: Uint8Array;
  /** how many pictures were asked of the finder */
  looks: number;
  problem?: string;
}

/** The side of a patch, in pixels. */
export const PATCH = 32;
/** A place this much wider and taller on each side: the thing is about half of its patch, the rest is around it. */
export const MARGIN = 0.25;
/** The places of a thing found in two pictures overlap this much (intersection over union) when it is the same one. */
const SAME_PLACE = 0.3;
/** Below this difference of patches (patchDiff) a place looks as it did; two unrelated patches differ by about 1.1. */
export const SAME_LOOK = 0.45;
/** The halving ends when this much recorded time is left between a look with the thing and one without. */
const COARSE_MS = 60_000;
/** The last stretch is looked at this often, and this far past the first look without the thing. */
export const FINE_MS = 500;
const FINE_AFTER_MS = 120_000;
/** Where the thing is first looked for, besides the start: the time asked cut in this many parts. */
const FIRST_LOOKS = 8;
/** A look that cannot be read is tried this much aside, by turns before and after (the end of a file has no picture). */
const UNREADABLE_SHIFTS_MS = [0, -1_000, 2_000, -3_000];
const LOOKS_MAX = 60;
/** Looks after the moment found, spread over the rest of the time asked: where the thing is there again, it had not gone. */
const LATER_LOOKS = 3;
const ROUNDS = 3;

/**
 * How unlike two patches are: each made of its own mean and spread (a lamp turned on brightens a place, it does not
 * change what lies there), then the mean distance of their pixels. 0 for the same look; two unrelated looks ≈ 1.1. A
 * flat patch (an empty table) keeps a floor of spread: its noise is not made into a pattern.
 */
export function patchDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return Number.POSITIVE_INFINITY;
  const stats = (p: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += p[i];
    const mean = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i++) sq += (p[i] - mean) ** 2;
    return { mean, spread: Math.max(Math.sqrt(sq / n), 6) };
  };
  const sa = stats(a);
  const sb = stats(b);
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.abs((a[i] - sa.mean) / sa.spread - (b[i] - sb.mean) / sb.spread);
  return total / n;
}

function overlap(a: Place, b: Place): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** The place with its margin, inside the picture. */
export function widened(place: Place, margin = MARGIN): Place {
  const x = Math.max(0, place.x - place.width * margin);
  const y = Math.max(0, place.y - place.height * margin);
  return {
    x,
    y,
    width: Math.min(1, place.x + place.width * (1 + margin)) - x,
    height: Math.min(1, place.y + place.height * (1 + margin)) - y,
  };
}

/** The recorded time as one line: an offset in it is a time of the recording, pauses left out. */
function timeline(stretches: Stretch[]) {
  const total = stretches.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const at = (offset: number): number => {
    let left = Math.max(0, Math.min(offset, total));
    for (const s of stretches) {
      const length = s.endMs - s.startMs;
      if (left <= length) return s.startMs + left;
      left -= length;
    }
    return stretches[stretches.length - 1].endMs;
  };
  /** The offset of a recorded time. */
  const offsetOf = (atMs: number): number => {
    let offset = 0;
    for (const s of stretches) {
      if (atMs <= s.endMs) return offset + Math.max(0, atMs - s.startMs);
      offset += s.endMs - s.startMs;
    }
    return total;
  };
  return { total, at, offsetOf };
}

export async function whenGone(sources: GoneSources, fromMs: number, toMs: number): Promise<GoneAnswer> {
  const stretches = sources
    .recorded(fromMs, toMs)
    .map((s) => ({ startMs: Math.max(s.startMs, fromMs), endMs: Math.min(s.endMs, toMs) }))
    .filter((s) => s.endMs > s.startMs);
  if (!stretches.length) return { state: 'no-recording', looks: 0 };
  const { total, at, offsetOf } = timeline(stretches);
  let looks = 0;
  let english: string | undefined;

  type Look = { atMs: number; picture: Uint8Array } & ({ problem: string } | { sure: (Place & { score: number })[] });
  /** A picture at a time (a little aside where it cannot be read) and what the finder makes of it. */
  const look = async (offset: number): Promise<Look | undefined> => {
    for (const shift of UNREADABLE_SHIFTS_MS) {
      if (looks >= LOOKS_MAX) break;
      const atMs = at(Math.max(0, Math.min(total, offset + shift)));
      const picture = await sources.frame(atMs);
      if (!picture) continue;
      looks++;
      const found = await sources.find(picture);
      if ('problem' in found) return { atMs, picture, problem: found.problem };
      english = found.english;
      const sure = found.boxes.filter((box) => box.score >= found.foundScore).sort((a, b) => b.score - a.score);
      return { atMs, picture, sure };
    }
    return undefined;
  };

  // where it lay: at the start of the time asked, else the first of a few looks spread over it
  let first: { atMs: number; picture: Uint8Array; offset: number; place: Place } | undefined;
  for (let k = 0; k < FIRST_LOOKS && !first; k++) {
    const offset = (total * k) / FIRST_LOOKS;
    const seen = await look(offset);
    if (seen && 'problem' in seen) return { state: seen.problem === NO_FINDER ? 'no-finder' : 'failed', problem: seen.problem, looks };
    if (seen && seen.sure.length) first = { atMs: seen.atMs, picture: seen.picture, offset, place: seen.sure[0] };
  }
  if (!first) return { state: 'never-seen', looks, ...(english ? { english } : {}) };
  const place = first.place;
  // the place with what is around it: the thing about half of the patch, so that its going changes the patch
  const region = widened(place);
  const reference = await sources.patchOf(first.picture, region);
  if (!reference) return { state: 'failed', problem: 'the place could not be read in the picture', looks };

  /** The thing is still there: found where it lay, or the place looks as it did (the finder missed it this time). */
  const there = async (offset: number): Promise<{ yes: boolean; atMs: number; picture?: Uint8Array } | { problem: string }> => {
    const seen = await look(offset);
    if (!seen) return { yes: false, atMs: at(offset) };
    if ('problem' in seen) return { problem: seen.problem };
    if (seen.sure.some((box) => overlap(box, place) >= SAME_PLACE)) return { yes: true, atMs: seen.atMs, picture: seen.picture };
    const patch = await sources.patchOf(seen.picture, region);
    return { yes: !!patch && patchDiff(patch, reference) < SAME_LOOK, atMs: seen.atMs, picture: seen.picture };
  };

  const end = await there(total);
  if ('problem' in end) return { state: 'failed', problem: end.problem, looks, place };
  const base = { ...(english ? { english } : {}), place, seenMs: first.atMs };
  if (end.yes) return { state: 'still-there', ...base, lastSeenMs: end.atMs, looks };

  // halved over the recorded time between the last look with it and the first without; then the last stretch twice a
  // second, it went after the last moment the place looked as it did. A look that fell while someone stood over the
  // thing took that for its going: looks after the moment found, where it is there again, start the halving anew
  let lo = first.offset;
  let hi = total;
  let lastSeenMs = at(lo);
  let goneMs = at(hi);
  for (let round = 0; round < ROUNDS; round++) {
    while (hi - lo > COARSE_MS && looks < LOOKS_MAX) {
      const mid = (lo + hi) / 2;
      const seen = await there(mid);
      if ('problem' in seen) return { state: 'failed', problem: seen.problem, looks, place };
      if (seen.yes) lo = mid;
      else hi = mid;
    }
    // on past the first look without it: one that fell while someone stood over the thing ended the halving there,
    // and the thing seen again right after they left is the last moment it lay
    const samples = await sources.patches(at(lo), at(Math.min(total, hi + FINE_AFTER_MS)), region, FINE_MS);
    let last = -1;
    samples.forEach((sample, i) => {
      if (patchDiff(sample.pixels, reference) < SAME_LOOK) last = i;
    });
    lastSeenMs = last >= 0 ? samples[last].atMs : at(lo);
    goneMs = last + 1 < samples.length ? samples[last + 1].atMs : at(Math.min(total, hi + FINE_AFTER_MS));
    if (last >= 0) hi = Math.max(hi, offsetOf(lastSeenMs));
    let again: number | undefined;
    for (let k = 1; k <= LATER_LOOKS && total - hi > COARSE_MS && again === undefined; k++) {
      const offset = hi + ((total - hi) * k) / (LATER_LOOKS + 1);
      const seen = await there(offset);
      if ('problem' in seen) return { state: 'failed', problem: seen.problem, looks, place };
      if (seen.yes) again = offset;
    }
    if (again === undefined) break;
    lo = again;
    hi = total;
  }
  const gap = goneMs - lastSeenMs > FINE_MS * 4;
  const [before, after] = await Promise.all([sources.frame(lastSeenMs), sources.frame(goneMs)]);
  return {
    state: 'gone',
    ...base,
    lastSeenMs,
    goneMs,
    ...(gap ? { gap } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    looks,
  };
}

/** The problem a finder answers with when no plugin has one (index.ts NO_FINDER). */
export const NO_FINDER = '\u0000no-finder';
