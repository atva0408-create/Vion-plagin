// A thing the person marked on a frame of a camera's recording («отметь вещь»), followed by its outline: when it went,
// and where it was carried. The outline is SAM 2's, of a detection plugin on the CPU (about 2 s a picture): asked only
// by the person, a question of minutes, never a task in the background. The place's keyframe looks (place.ts) find the
// moments the place changed cheaply; the outline tells at each whether the thing itself is there: the same outline,
// the same look inside it (a box drawn on an empty table is outlined too, as some part of the table: its look tells
// it from the thing). A look without it is confirmed by another a few seconds on (someone in front of it is no going).
// Where it went: from the last picture with it, twice a second, the thing is looked for near where it was and in the
// hands of the people the camera tracked there; who carried it is the one it was seen with most, and nobody when it
// was seen with nobody (a person standing by the place is not named for it).
// Reading the recording, asking the plugin and the events are given (index.ts), so this is tested on its own.

import { patchDiff, PATCH, SAME_LOOK, widened } from './gone.js';

import type { Place, Stretch } from './gone.js';

/** An outline as the plugin gives it: the box it covers (shares of the picture), the mask over that box (0-255). */
export interface Outline {
  box: Place;
  width: number;
  height: number;
  data: Uint8Array;
  /** its share of the picture */
  area: number;
}

export interface Outlined {
  /** the decoder's estimate of its outline */
  score: number;
  /** the model takes a thing to be there (not to be trusted alone: a box on an empty table is outlined too) */
  present: boolean;
  mask?: Outline;
}

export interface Prompt {
  box?: Place;
  points?: { x: number; y: number; label?: number }[];
}

/** How a thing looks inside its outline. */
export interface ThingLook {
  /** mean colour inside the outline, 0-255 */
  colour: [number, number, number];
  /** PATCH × PATCH gray of the outline's box, outside the outline at the mean inside it (patchDiff compares the thing) */
  patch: Uint8Array;
  /** the whole picture has no colour (the night one, infrared): colours are not compared */
  night: boolean;
}

export interface PersonThere {
  eventId: string;
  trackId: number;
  box: Place;
}

export interface ThingSources {
  /** the recorded stretches of the camera between the two times, in time order */
  recorded(fromMs: number, toMs: number): Stretch[];
  /** the whole picture of the recording at a time (JPEG), undefined where none can be read */
  frame(atMs: number): Promise<Uint8Array | undefined>;
  /** the outlines the prompts mark on a picture, or why there are none */
  outline(picture: Uint8Array, prompts: Prompt[]): Promise<Outlined[] | { problem: string }>;
  /** how the thing inside an outline looks; undefined where it cannot be read (an outline too thin to cut) */
  lookOf(picture: Uint8Array, outline: Outline): Promise<ThingLook | undefined>;
  /**
   * the moments a place stopped looking as at a time, from its keyframe looks, in time order (place.ts, gone); and
   * when the camera turned (the place is elsewhere in the picture after it: the thing is not looked for there)
   */
  changes(place: Place, atMs: number, toMs: number): Promise<{ changes: { beforeMs: number; afterMs: number }[]; turnedMs?: number }>;
  /** the people the camera tracked about a time, with their boxes */
  people(atMs: number): Promise<PersonThere[]>;
  /** the clock the time of a question is counted by (Date.now; tests give theirs) */
  now?(): number;
}

export interface ThingAnswer {
  /** cut: the time (or the pictures) of a question ran out before the thing was told there or gone */
  state: 'gone' | 'still-there' | 'not-outlined' | 'no-recording' | 'no-outliner' | 'failed' | 'cut';
  /** the moment marked, and the outline of the thing then */
  markedMs: number;
  outline?: Place;
  /** gone: the last moment the thing was seen there and the first it was not; still-there: the last look with it */
  lastThereMs?: number;
  goneMs?: number;
  /** nothing was recorded between the two: it went somewhen in that pause */
  gap?: boolean;
  /** the camera turned then: looked for until that moment only */
  turnedMs?: number;
  /** where it went, when asked */
  carried?: Carried;
  /** the pictures (whole frames, JPEG) the one who asked looks at: marked, the two moments, the last one followed */
  pictures: { marked?: Uint8Array; before?: Uint8Array; after?: Uint8Array; lastSeen?: Uint8Array };
  /** pictures outlined */
  looks: number;
  /** the time or the pictures of a question ran out: what was found by then is the answer */
  cut?: boolean;
  problem?: string;
}

export interface Carried {
  /** where the thing was seen after it left, in time order */
  track: { atMs: number; box: Place }[];
  /** the last time and place it was seen; it left the picture there when at its edge */
  lastSeenMs?: number;
  lastBox?: Place;
  leftPicture: boolean;
  /** the person it went with: the one whose box it was seen in most; nobody when it was seen in no one's */
  by?: { eventId: string; trackId: number; times: number };
}

/**
 * An outline at the mark is taken for the thing from this estimate of it: by the box drawn, else by the point at its
 * middle when that outline lies inside the box (a box drawn wider than a thing is outlined as itself, the thing and
 * what is around it). A box on an empty table was outlined at 0.67-0.74 as a part of it and the point at its middle
 * outlined nothing; things at 0.95-0.98.
 */
export const MARK_SCORE = 0.8;
/** An outline is the thing's when its box overlaps the marked one this much (intersection over union)… */
const SAME_PLACE = 0.4;
/** …its size is within this factor of it… */
const SAME_SIZE = 2.5;
/**
 * …and its hue is within this distance of the marked one's (0-1, of the chromaticity: the colour without its
 * brightness: a red cup 30 % darker at dusk is the same cup; compared as RGB it was 0.13 away and taken for gone).
 */
export const SAME_COLOUR = 0.08;
/** Darker than this (the sum of the mean R, G, B) a thing has no hue to tell: its pattern alone is compared. */
const DARK = 90;
/**
 * A look without the thing is confirmed this much later (earlier at the end of the time asked): with it there then,
 * someone stood in front at the first; with a person over its place then, the next (people stand by a table a while).
 */
export const CONFIRM_MS = [5_000, 15_000, 45_000];
/** The thing in hands looks turned and smaller or larger: its size within this factor, its look a little looser. */
const CARRIED_SIZE = 3;
const CARRIED_LOOK = SAME_LOOK * 1.4;
/** The moment it went is narrowed to this, in pictures at times (not keyframes). */
export const GONE_EXACT_MS = 1_000;
/** Where it went is followed this often and this long after the last picture with it. */
export const FOLLOW_STEP_MS = 500;
export const FOLLOW_MS = 20_000;
/** It is lost after this many pictures in a row without it. */
const LOST_AFTER = 4;
/** A box this close to the edge of the picture (a share of it) is leaving the picture. */
const EDGE = 0.03;
/** Pictures outlined at most for one question (about 2 s each on the CPU of a small server). */
export const LOOKS_MAX = 120;
/**
 * The time of one question: the assistant's call of it ends after 10 minutes. An outline took 2.4-2.8 s on the bench,
 * once 12 s while the live models were busy: past this what was found is the answer.
 */
export const BUDGET_MS = 8 * 60_000;

/** The overlap of two boxes: intersection over union. */
export function overlap(a: Place, b: Place): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * The distance of two hues: their chromaticities (each channel's share of the three), 0 the same, 1 a pure colour
 * against another; undefined when either is too dark to have one.
 */
export function colourDistance(a: [number, number, number], b: [number, number, number]): number | undefined {
  const sa = a[0] + a[1] + a[2];
  const sb = b[0] + b[1] + b[2];
  if (sa < DARK || sb < DARK) return undefined;
  return Math.hypot(a[0] / sa - b[0] / sb, a[1] / sa - b[1] / sb, a[2] / sa - b[2] / sb) / Math.SQRT2;
}

/**
 * How a thing looks, from the pixels of its outline's box (`rgb`: PATCH × PATCH RGB) and its mask over that box; `night`:
 * the whole picture has no colour (a thing of no colour by day is no night: a black phone, a white charger).
 */
export function thingLook(rgb: Uint8Array, outline: Pick<Outline, 'width' | 'height' | 'data'>, night: boolean): ThingLook | undefined {
  const n = PATCH * PATCH;
  if (rgb.length < n * 3 || !outline.width || !outline.height) return undefined;
  const inside = new Uint8Array(n);
  let count = 0;
  for (let y = 0; y < PATCH; y++) {
    const my = Math.min(outline.height - 1, Math.floor(((y + 0.5) * outline.height) / PATCH));
    for (let x = 0; x < PATCH; x++) {
      const mx = Math.min(outline.width - 1, Math.floor(((x + 0.5) * outline.width) / PATCH));
      if (outline.data[my * outline.width + mx] > 127) {
        inside[y * PATCH + x] = 1;
        count++;
      }
    }
  }
  if (!count) return undefined;
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    sum[0] += rgb[i * 3];
    sum[1] += rgb[i * 3 + 1];
    sum[2] += rgb[i * 3 + 2];
  }
  const colour: [number, number, number] = [sum[0] / count, sum[1] / count, sum[2] / count];
  const gray = (colour[0] + colour[1] + colour[2]) / 3;
  const patch = new Uint8Array(n);
  for (let i = 0; i < n; i++) patch[i] = inside[i] ? Math.round((rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3) : Math.round(gray);
  return { colour, patch, night };
}

/** Whether a look is the marked thing's: its pattern, and its hue unless a picture is the night one or a thing dark. */
export function sameThing(marked: ThingLook, look: ThingLook, looseness = 1): boolean {
  if (patchDiff(marked.patch, look.patch) >= SAME_LOOK * looseness) return false;
  if (marked.night || look.night) return true;
  const hue = colourDistance(marked.colour, look.colour);
  return hue === undefined || hue < SAME_COLOUR * looseness;
}

const centre = (box: Place) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (point: { x: number; y: number }, box: Place) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Points over a box, n × n, for looking for the thing around where it was. */
function grid(box: Place, n: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) points.push({ x: clamp(box.x + ((i + 0.5) * box.width) / n), y: clamp(box.y + ((j + 0.5) * box.height) / n) });
  return points;
}

export async function followThing(sources: ThingSources, query: { place: Place; atMs: number; toMs: number; carried: boolean; budgetMs?: number }): Promise<ThingAnswer> {
  const { atMs } = query;
  const clock = () => (sources.now ? sources.now() : Date.now());
  const started = clock();
  // what is left of the question's time (index.ts counts the wait in the queue)
  const budget = query.budgetMs ?? BUDGET_MS;
  const answer: ThingAnswer = { state: 'failed', markedMs: atMs, pictures: {}, looks: 0 };
  if (budget <= 0) return { ...answer, state: 'cut', cut: true };
  const recorded = sources.recorded(atMs, query.toMs);
  if (!recorded.length) return { ...answer, state: 'no-recording' };
  let toMs = Math.min(query.toMs, recorded[recorded.length - 1].endMs);

  let problem: string | undefined;
  /** the outlines of the prompts on the picture at a time; undefined where no picture or no outliner */
  const outlined = async (picture: Uint8Array, prompts: Prompt[]): Promise<Outlined[] | undefined> => {
    if (answer.looks >= LOOKS_MAX || clock() - started >= budget) {
      answer.cut = true;
      return undefined;
    }
    answer.looks++;
    const got = await sources.outline(picture, prompts);
    if (!Array.isArray(got)) {
      problem = got.problem;
      return undefined;
    }
    return got;
  };

  // the thing at the moment marked: what the box drawn shows most, with its look; a box on an empty place outlines a
  // part of it weakly, and the point at its middle nothing
  const marked = await sources.frame(atMs);
  if (!marked) return { ...answer, state: 'no-recording' };
  const first = await outlined(marked, [{ box: query.place }, { points: [centre(query.place)] }]);
  if (!first) return { ...answer, state: problem ? 'no-outliner' : answer.cut ? 'cut' : 'failed', problem };
  const [byBox, byPoint] = first;
  const within = (box: Place) => {
    const drawn = widened(query.place, 0.1);
    return box.x >= drawn.x && box.y >= drawn.y && box.x + box.width <= drawn.x + drawn.width && box.y + box.height <= drawn.y + drawn.height;
  };
  // an outline thinner than 2 px has no look to cut (ffmpeg was asked a crop of width 0 and failed the question)
  const cuttable = (outline: Outline | undefined) => (outline && outline.width >= 2 && outline.height >= 2 ? outline : undefined);
  const boxed = cuttable(byBox?.mask);
  const pointed = cuttable(byPoint?.mask);
  const mask = boxed && byBox.score >= MARK_SCORE ? boxed : pointed && byPoint.score >= MARK_SCORE && within(pointed.box) ? pointed : undefined;
  const look = mask ? await sources.lookOf(marked, mask) : undefined;
  if (!mask || !look) return { ...answer, state: 'not-outlined', pictures: { marked } };
  const thing = { box: mask.box, area: mask.area, look };
  answer.outline = mask.box;
  answer.pictures.marked = marked;

  /**
   * The thing's outline on a picture, `prompts` the places it is looked for at: null where it is not, undefined where
   * it could not be looked for (the outliner failed or the looks ran out: not to be taken for the thing gone).
   */
  const found = async (picture: Uint8Array, prompts: Prompt[], carried: boolean): Promise<Outline | null | undefined> => {
    const answers = await outlined(picture, prompts);
    if (!answers) return undefined;
    let best: { outline: Outline; diff: number } | undefined;
    for (const a of answers) {
      const mask = cuttable(a.mask);
      if (!mask) continue;
      const size = mask.area / thing.area;
      const limit = carried ? CARRIED_SIZE : SAME_SIZE;
      if (size > limit || size < 1 / limit) continue;
      if (!carried && overlap(mask.box, thing.box) < SAME_PLACE) continue;
      const seen = await sources.lookOf(picture, mask);
      if (!seen || !sameThing(thing.look, seen, carried ? CARRIED_LOOK / SAME_LOOK : 1)) continue;
      const diff = patchDiff(thing.look.patch, seen.patch);
      if (!best || diff < best.diff) best = { outline: mask, diff };
    }
    return best?.outline ?? null;
  };
  // at its place: the box of its outline, hardly wider, and a point at its middle. A box twice as wide was outlined as
  // the size of the box (the thing and what is around it) and the point alone as a part of the thing (a bag's pocket):
  // the real SAM found 8 of 15 things on the very picture they were marked on that way, all 15 by the box of the outline
  const atPlace = (): Prompt[] => [{ box: widened(thing.box, 0.1) }, { points: [centre(thing.box)] }];
  const pictures = new Map<number, Uint8Array | undefined>();
  const frame = async (t: number) => {
    if (!pictures.has(t)) pictures.set(t, await sources.frame(t));
    return pictures.get(t);
  };
  /** whether the thing is at its place at a time: true, false, or undefined where it cannot be told */
  const there = async (t: number): Promise<boolean | undefined> => {
    const picture = await frame(t);
    if (!picture) return undefined;
    const outline = await found(picture, atPlace(), false);
    return outline === undefined ? undefined : outline !== null;
  };
  /** someone the camera tracked over its place at a time */
  const covered = async (t: number) => (await sources.people(t)).some((p) => overlap(p.box, widened(thing.box, 0.3)) > 0);
  /**
   * Whether the thing is gone from its place at a time: not there then, and not there a few seconds later (earlier,
   * `back`, at the end of the time asked) with nobody over the place; there then, someone stood in front of it.
   */
  const absent = async (t: number, back = false): Promise<boolean | undefined> => {
    const now = await there(t);
    if (now !== false) return now === undefined ? undefined : false;
    for (const shift of CONFIRM_MS) {
      const again = back ? t - shift : t + shift;
      if (again <= atMs || again > toMs) break;
      const seen = await there(again);
      if (seen === undefined) return undefined;
      if (seen) return false;
      if (!(await covered(again))) return true;
    }
    return true;
  };

  // the moments its place changed after the mark, from the cheap keyframe looks; the outline says at which the thing went
  let lastThere = atMs;
  let firstGone: number | undefined;
  const place = await sources.changes(widened(thing.box, 0.25), atMs, toMs);
  if (place.turnedMs !== undefined && place.turnedMs < toMs) {
    answer.turnedMs = place.turnedMs;
    toMs = place.turnedMs;
  }
  for (const change of place.changes.filter((c) => c.afterMs <= toMs)) {
    const gone = await absent(change.afterMs);
    if (gone === undefined) break;
    if (!gone) {
      lastThere = change.afterMs;
      continue;
    }
    firstGone = change.afterMs;
    if ((await there(change.beforeMs)) === true) lastThere = Math.max(lastThere, change.beforeMs);
    break;
  }
  // no change of the place, or none it went at: is it there at the end? If not it went unseen by the looks: halved
  if (firstGone === undefined) {
    const goneAtEnd = await absent(toMs, true);
    if (goneAtEnd === undefined && problem) return { ...answer, state: 'no-outliner', problem };
    // the time ran out before the end was looked at: neither there nor gone can be said
    if (goneAtEnd === undefined && answer.cut) return { ...answer, state: 'cut', lastThereMs: lastThere };
    if (goneAtEnd !== true) return { ...answer, state: 'still-there', lastThereMs: goneAtEnd === false ? toMs : lastThere };
    firstGone = toMs;
  }
  // narrowed to a second between a picture with it and one without (looks that cannot be told end the narrowing)
  while (firstGone - lastThere > GONE_EXACT_MS && !answer.cut) {
    const middle = Math.round((lastThere + firstGone) / 2);
    const gone = await absent(middle);
    if (gone === undefined) break;
    if (gone) firstGone = middle;
    else lastThere = middle;
  }
  answer.state = 'gone';
  answer.lastThereMs = lastThere;
  answer.goneMs = firstGone;
  answer.gap = recorded.some((s, i) => i > 0 && s.startMs > lastThere && recorded[i - 1].endMs < firstGone);
  answer.pictures.before = await frame(lastThere);
  answer.pictures.after = await frame(firstGone);
  if (!query.carried) return { ...answer, problem };

  // where it went: from the last picture with it, near where it was and in the hands of the people there
  const carried: Carried = { track: [], leftPicture: false };
  const withWhom = new Map<string, { eventId: string; trackId: number; times: number }>();
  let last = thing.box;
  let misses = 0;
  for (let t = lastThere + FOLLOW_STEP_MS; t <= Math.min(toMs, lastThere + FOLLOW_MS) && !answer.cut; t += FOLLOW_STEP_MS) {
    const picture = await frame(t);
    if (!picture) continue;
    const near = widened(last, 2);
    const people = (await sources.people(t)).filter((p) => overlap(p.box, widened(last, 3)) > 0 || inside(centre(last), widened(p.box, 0.2)));
    const prompts: Prompt[] = [
      { box: widened(last, 0.2) },
      ...grid(near, 3).map((p) => ({ points: [p] })),
      // in hands: the lower middle of the person, where hands carry things
      ...people.flatMap((p) => [
        { points: [{ x: p.box.x + p.box.width * 0.3, y: p.box.y + p.box.height * 0.6 }] },
        { points: [{ x: p.box.x + p.box.width * 0.7, y: p.box.y + p.box.height * 0.6 }] },
      ]),
    ];
    const seen = await found(picture, prompts, true);
    // the outliner failed: what was followed so far is the answer
    if (seen === undefined) break;
    if (seen === null) {
      if (++misses >= LOST_AFTER) break;
      continue;
    }
    misses = 0;
    last = seen.box;
    carried.track.push({ atMs: t, box: seen.box });
    for (const p of people) {
      if (!inside(centre(seen.box), widened(p.box, 0.1))) continue;
      const key = `${p.eventId}:${p.trackId}`;
      const known = withWhom.get(key) ?? { eventId: p.eventId, trackId: p.trackId, times: 0 };
      known.times++;
      withWhom.set(key, known);
    }
  }
  const lastSeen = carried.track[carried.track.length - 1];
  if (lastSeen) {
    carried.lastSeenMs = lastSeen.atMs;
    carried.lastBox = lastSeen.box;
    const b = lastSeen.box;
    carried.leftPicture = b.x < EDGE || b.y < EDGE || b.x + b.width > 1 - EDGE || b.y + b.height > 1 - EDGE;
    answer.pictures.lastSeen = await frame(lastSeen.atMs);
  }
  carried.by = [...withWhom.values()].sort((a, b) => b.times - a.times)[0];
  answer.carried = carried;
  return { ...answer, problem };
}
