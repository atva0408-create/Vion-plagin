// What became of a place in a camera's picture: the person marks it on a frame of the recording and asks when what lay
// there went, when it came, or what was there over a while. The place is watched, not the thing (the text finder does
// not know a car battery): its small gray patch at keyframes of the recording is compared with how it looked at the
// moment marked (gone.ts patchDiff). The rest of the picture tells the camera from the place: all of it changed for
// good is the camera turned (the place is elsewhere in the picture from then on: the looking stops there), a picture
// without colour is the night one (compared with night pictures only). A change seen once and gone at the next look
// is someone passing in front. Reading the recording is given (index.ts), so this is tested on its own.

import { awayMask, patchDiff, SAME_LOOK, timeline, TURN_LOOK } from './gone.js';

import type { Place, Stretch } from './gone.js';

/** A look at the recording: the keyframe at or before a time. */
export interface PlaceLook {
  /** the time of the keyframe */
  atMs: number;
  /** the place: PATCH × PATCH gray */
  patch: Uint8Array;
  /** the whole picture, small: OVERVIEW_W × OVERVIEW_H gray */
  overview: Uint8Array;
  /** how coloured the picture is (mean distance of its chroma from gray, 0-255): a night picture has none */
  colour: number;
}

export const OVERVIEW_W = 64;
export const OVERVIEW_H = 36;

export interface PlaceSources {
  /** the recorded stretches of the camera between the two times, in time order */
  recorded(fromMs: number, toMs: number): Stretch[];
  /** the look at the keyframe at or before a time; undefined where none can be read */
  look(atMs: number): Promise<PlaceLook | undefined>;
}

/** gone: from the moment on, when it stopped looking so; appeared: back from it, since when; history: all of a while. */
export type PlaceMode = 'gone' | 'appeared' | 'history';

export interface PlaceChange {
  /** changed: the place itself; turned: the whole picture (the camera looks elsewhere); light: the night picture came or went */
  kind: 'changed' | 'turned' | 'light';
  /** the last look as it was and the first as it became */
  beforeMs: number;
  afterMs: number;
  /** the two ends are neighbouring keyframes; else looks of the first pass, up to its step apart */
  exact: boolean;
  /** between the two the place was neither (someone stood in front of it): from the first such keyframe to the last */
  busy?: { fromMs: number; toMs: number };
  /** nothing was recorded somewhere between the two */
  gap?: boolean;
  /** after it the place looks as at the moment marked (history) */
  asMarked?: boolean;
}

export interface PlaceAnswer {
  state: 'ok' | 'no-recording' | 'unreadable';
  /** the look the others are compared with: the moment marked, at its keyframe */
  markedMs?: number;
  /** the time looked through: the one asked, cut where the camera turned or the looks ran out */
  fromMs?: number;
  toMs?: number;
  /** gone: the last moment the place looked as marked (still so at the end when no change follows) */
  lastSameMs?: number;
  /** appeared: the first moment the place looked as marked (so since the start when no change comes before) */
  firstSameMs?: number;
  changes: PlaceChange[];
  /** something in front of the place for a look or a few, the place as before after it: the looks' times */
  passes: { fromMs: number; toMs: number }[];
  /** the step of the first pass over the time asked */
  stepMs?: number;
  /** the looks ran out before the whole time was looked through */
  cut?: boolean;
  looks: number;
}

/** What the recorder answers (index.ts): the place asked and the pictures of the changes for the one who asked. */
export interface PlaceHistoryAnswer extends PlaceAnswer {
  place?: Place;
  /** by the index of a change in `changes`: around the place before and after it (whole pictures where the camera turned), and while someone stood in front */
  pictures: { change: number; before?: Uint8Array; after?: Uint8Array; busy?: Uint8Array }[];
  /** the place at the end of the time looked through (gone, appeared: no change found) */
  still?: Uint8Array;
  /** keyframes that could not be read, and why the first could not */
  unreadable?: number;
  problem?: string;
}

/** Below this colour a picture is the night one: infrared pictures are gray (chroma at 128). */
export const NIGHT_COLOUR = 3;
/** The first pass: the time asked in about this many looks, but not closer than MIN_STEP_MS. */
const FIRST_PASS_LOOKS = 160;
const MIN_STEP_MS = 10_000;
/** Looks at most for one question: a look is a keyframe decoded, 0.15-0.2 s on the bench. */
export const LOOKS_MAX = 420;
/** Changes of a history narrowed to their keyframes; the rest are said to the step of the first pass. */
const NARROWED_MAX = 10;

interface Seen {
  look: PlaceLook;
  night: boolean;
  /** the place looks as at the moment marked (by the light of this picture) */
  asMarked: boolean;
}

const same = (a: Uint8Array, b: Uint8Array) => patchDiff(a, b) < SAME_LOOK;

/** The smallest place, as a share of the picture's side: a 1080p frame's 10 px; less is a slip of the finger. */
export const PLACE_MIN = 0.01;

/** A place drawn by hand, inside the picture and not smaller than PLACE_MIN on a side (centred where it was drawn). */
export function insidePicture(place: Place): Place {
  const side = (start: number, length: number) => {
    const size = Math.min(1, Math.max(PLACE_MIN, Number.isFinite(length) ? Math.abs(length) : PLACE_MIN));
    const from = Number.isFinite(start) ? Math.min(start, start + (length < 0 ? length : 0)) : 0;
    const centre = from + Math.abs(Number.isFinite(length) ? length : 0) / 2;
    return { start: Math.max(0, Math.min(1 - size, centre - size / 2)), size };
  };
  const x = side(place.x, place.width);
  const y = side(place.y, place.height);
  return { x: x.start, y: y.start, width: x.size, height: y.size };
}

export async function placeHistory(sources: PlaceSources, query: { place: Place; atMs: number; fromMs: number; toMs: number; mode: PlaceMode }): Promise<PlaceAnswer> {
  const { place, mode } = query;
  const stretches = sources
    .recorded(query.fromMs, query.toMs)
    .map((s) => ({ startMs: Math.max(s.startMs, query.fromMs), endMs: Math.min(s.endMs, query.toMs) }))
    .filter((s) => s.endMs > s.startMs);
  if (!stretches.length) return { state: 'no-recording', changes: [], passes: [], looks: 0 };
  const { total, at, offsetOf } = timeline(stretches);
  const mask = awayMask(place, OVERVIEW_W, OVERVIEW_H);
  const away = (overview: Uint8Array) => Uint8Array.from(mask!, (i) => overview[i]);
  let looks = 0;
  let cut = false;
  const cache = new Map<number, PlaceLook | undefined>();

  const lookAt = async (atMs: number): Promise<PlaceLook | undefined> => {
    if (cache.has(atMs)) return cache.get(atMs);
    if (looks >= LOOKS_MAX) {
      cut = true;
      return undefined;
    }
    looks++;
    const look = await sources.look(atMs);
    cache.set(atMs, look);
    return look;
  };

  const first = await lookAt(Math.max(query.fromMs, Math.min(query.atMs, query.toMs)));
  if (!first) return { state: 'unreadable', changes: [], passes: [], looks };
  const marked: Seen = { look: first, night: first.colour < NIGHT_COLOUR, asMarked: true };
  const markedMs = first.atMs;

  // the first pass: the time asked in even steps of recorded time, the moment marked among them
  const step = Math.max(MIN_STEP_MS, total / FIRST_PASS_LOOKS);
  const times = new Set<number>();
  for (let offset = 0; offset < total; offset += step) times.add(at(offset));
  times.add(at(total));
  const markedOffset = offsetOf(markedMs);
  const forward = mode === 'appeared' ? [] : [...times].filter((t) => offsetOf(t) > markedOffset).sort((a, b) => a - b);
  const backward = mode === 'gone' ? [] : [...times].filter((t) => offsetOf(t) < markedOffset).sort((a, b) => b - a);
  const changes: PlaceChange[] = [];

  const gapOf = (a: PlaceLook, b: PlaceLook) => {
    const [from, to] = [Math.min(a.atMs, b.atMs), Math.max(a.atMs, b.atMs)];
    return stretches.some((s) => s.startMs <= from && s.endMs >= to) ? {} : { gap: true as const };
  };
  const edges = (a: PlaceLook, b: PlaceLook) => ({ beforeMs: Math.min(a.atMs, b.atMs), afterMs: Math.max(a.atMs, b.atMs), ...gapOf(a, b) });

  /**
   * Halved between a look that passes the test and one that does not (either side in time), keyframe by keyframe:
   * the one that passes next to the one that does not. Exact when they are neighbouring keyframes.
   */
  const narrow = async (yes: PlaceLook, no: PlaceLook, test: (look: PlaceLook) => boolean): Promise<{ yes: PlaceLook; no: PlaceLook; exact: boolean }> => {
    for (;;) {
      const lo = offsetOf(Math.min(yes.atMs, no.atMs));
      const hi = offsetOf(Math.max(yes.atMs, no.atMs));
      const between = (look: PlaceLook | undefined) => !!look && offsetOf(look.atMs) > lo && offsetOf(look.atMs) < hi;
      let look = await lookAt(at((lo + hi) / 2));
      // the keyframe before the middle may be the earlier end: the one just before the later end is between them
      if (look && !between(look)) look = await lookAt(at(hi) - 1);
      if (!look) return { yes, no, exact: false };
      if (!between(look)) return { yes, no, exact: true };
      if (test(look)) yes = look;
      else no = look;
    }
  };

  /**
   * The looks of one side, outward from the moment marked, until the camera turned for good (two looks in a row
   * unlike its view: one alone is someone close to the lens, or the camera turning there and back). The night picture
   * coming (or the day's) is a change of light: its first look is how the place looks by that light, and stands for
   * the place as marked only when the look before it, by the other light, did.
   */
  const side = async (order: number[]): Promise<Seen[]> => {
    const views = new Map<boolean, Uint8Array>([[marked.night, first.overview]]);
    const places = new Map<boolean, { patch: Uint8Array; asMarked: boolean }>([[marked.night, { patch: first.patch, asMarked: true }]]);
    const turned = (look: PlaceLook, night: boolean) => !!mask && patchDiff(away(look.overview), away(views.get(night) ?? look.overview)) > TURN_LOOK;
    const out: Seen[] = [];
    let previous = marked;
    for (let i = 0; i < order.length; i++) {
      const look = await lookAt(order[i]);
      if (!look) {
        if (cut) break;
        continue;
      }
      if (look.atMs === previous.look.atMs) continue;
      const night = look.colour < NIGHT_COLOUR;
      if (night !== previous.night) {
        if (!views.has(night)) {
          views.set(night, look.overview);
          places.set(night, { patch: look.patch, asMarked: previous.asMarked });
        }
        changes.push({ kind: 'light', ...edges(previous.look, look), exact: false });
      }
      if (turned(look, night)) {
        const next = i + 1 < order.length ? await lookAt(order[i + 1]) : undefined;
        if (!next || turned(next, next.colour < NIGHT_COLOUR)) {
          const n = await narrow(previous.look, look, (l) => !turned(l, l.colour < NIGHT_COLOUR));
          changes.push({ kind: 'turned', ...edges(n.yes, n.no), exact: n.exact });
          break;
        }
      }
      const reference = places.get(night)!;
      const seen: Seen = { look, night, asMarked: reference.asMarked && same(look.patch, reference.patch) };
      out.push(seen);
      previous = seen;
    }
    return out;
  };

  /**
   * The change between a look on one side of it (`anchor`) and one on the other (`other`), narrowed to keyframes
   * next to the anchor; when the first keyframe unlike the anchor is not yet as the other side settled (`settled`:
   * someone stood in front, took it, left), narrowed again from the settled look: the stretch between is busy.
   */
  const changeAt = async (anchor: PlaceLook, other: PlaceLook, settled: PlaceLook): Promise<PlaceChange> => {
    const near = await narrow(anchor, other, (l) => same(l.patch, anchor.patch));
    if (same(near.no.patch, settled.patch)) return { kind: 'changed', ...edges(near.yes, near.no), exact: near.exact };
    const far = await narrow(settled, near.no, (l) => same(l.patch, settled.patch));
    const busy = { fromMs: Math.min(near.no.atMs, far.no.atMs), toMs: Math.max(near.no.atMs, far.no.atMs) };
    return { kind: 'changed', ...edges(near.yes, far.yes), exact: near.exact && far.exact, busy };
  };

  /** Runs of looks unlike the marked one with looks like it on both sides: someone passing. */
  const passesOf = (line: Seen[]) => {
    const out: { fromMs: number; toMs: number }[] = [];
    let run: Seen[] = [];
    for (const s of line) {
      if (!s.asMarked) run.push(s);
      else if (run.length) {
        out.push({ fromMs: Math.min(...run.map((r) => r.look.atMs)), toMs: Math.max(...run.map((r) => r.look.atMs)) });
        run = [];
      }
    }
    return out.sort((a, b) => a.fromMs - b.fromMs);
  };

  const after = await side(forward);
  const before = await side(backward);
  const base = {
    state: 'ok' as const,
    markedMs,
    fromMs: before.length ? before[before.length - 1].look.atMs : markedMs,
    toMs: after.length ? after[after.length - 1].look.atMs : markedMs,
    stepMs: Math.round(step),
  };
  const done = (rest: Partial<PlaceAnswer> & { passes: PlaceAnswer['passes'] }, found: PlaceChange[] = []): PlaceAnswer => ({
    ...base,
    ...rest,
    changes: [...changes, ...found].sort((a, b) => a.beforeMs - b.beforeMs),
    ...(cut ? { cut } : {}),
    looks,
  });

  if (mode === 'gone') {
    // the last look as marked (someone in front for a while came back to it), then what came after it
    const line = [marked, ...after];
    let last = 0;
    line.forEach((s, i) => {
      if (s.asMarked) last = i;
    });
    const passes = passesOf(line.slice(0, last + 1));
    if (last === line.length - 1) return done({ lastSameMs: line[last].look.atMs, passes });
    const change = await changeAt(line[last].look, line[last + 1].look, (line[last + 2] ?? line[last + 1]).look);
    return done({ lastSameMs: change.beforeMs, passes }, [change]);
  }

  if (mode === 'appeared') {
    // back from the moment marked to two looks in a row unlike it (one alone is someone passing)
    const line = [marked, ...before];
    let firstSame = line.length - 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i].asMarked) continue;
      if (i + 1 < line.length && line[i + 1].asMarked) continue;
      firstSame = i - 1;
      break;
    }
    const passes = passesOf(line.slice(0, firstSame + 1));
    if (firstSame === line.length - 1) return done({ firstSameMs: line[firstSame].look.atMs, passes });
    const change = await changeAt(line[firstSame].look, line[firstSame + 1].look, (line[firstSame + 2] ?? line[firstSame + 1]).look);
    return done({ firstSameMs: change.afterMs, passes }, [change]);
  }

  // the history, look by look in time order: a look unlike the state before it that the next look agrees with is a
  // change, one the next does not agree with is someone passing; a change of light starts a state of its own
  const line = [...before.reverse(), marked, ...after];
  const passes: { fromMs: number; toMs: number }[] = [];
  const found: { was: PlaceLook; became: PlaceLook; settled: PlaceLook; asMarked: boolean }[] = [];
  let state = line[0];
  let lastLike = line[0];
  for (let i = 1; i < line.length; i++) {
    const seen = line[i];
    if (seen.night !== state.night || same(seen.look.patch, state.look.patch)) {
      if (seen.night !== state.night) state = seen;
      lastLike = seen;
      continue;
    }
    const next = line[i + 1];
    const nextAlike = next?.night === seen.night;
    if (nextAlike && same(next.look.patch, state.look.patch)) {
      passes.push({ fromMs: seen.look.atMs, toMs: seen.look.atMs });
      continue;
    }
    const settled = nextAlike ? next : seen;
    found.push({ was: lastLike.look, became: seen.look, settled: settled.look, asMarked: settled.asMarked });
    state = settled;
    lastLike = settled;
  }
  const narrowed: PlaceChange[] = [];
  for (const [k, f] of found.entries()) {
    const change = k < NARROWED_MAX ? await changeAt(f.was, f.became, f.settled) : { kind: 'changed' as const, ...edges(f.was, f.became), exact: false };
    narrowed.push(f.asMarked ? { ...change, asMarked: true } : change);
  }
  return done({ passes }, narrowed);
}
