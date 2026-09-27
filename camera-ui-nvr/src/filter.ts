import { DETECTION_ATTRIBUTES, DETECTION_LABELS, EVENT_TRIGGER_TYPES } from '@camera.ui/sdk';

import type { GetEventsOptions, RecordedEvent } from './types.js';

/** Filter value of the «Другое» chip: an object or attribute type the filter bar does not name. */
export const EVENT_TYPE_OTHER = '__other__';

/** Everything the filter bar offers as its own chip (labels, attributes, sensor triggers). */
const NAMED_TYPES = new Set<string>([...DETECTION_LABELS, ...DETECTION_ATTRIBUTES, ...EVENT_TRIGGER_TYPES].map((t) => t.toLowerCase()));

/** Pseudo-types that say nothing about what was seen. */
const NON_OBJECT_TYPES = new Set(['motion', 'audio']);

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/** Event types plus the labels of its detections, lower-cased. */
export function eventTypes(ev: RecordedEvent): Set<string> {
  const out = new Set<string>();
  for (const t of ev.types ?? []) out.add(lower(t));
  for (const seg of ev.segments ?? []) for (const d of seg?.detections ?? []) if (d.label) out.add(lower(d.label));
  return out;
}

/** Best detection score of the event (0 when nothing was scored). */
export function bestScore(ev: RecordedEvent): number {
  let best = 0;
  for (const seg of ev.segments ?? []) for (const d of seg?.detections ?? []) best = Math.max(best, Number(d.score ?? 0) || 0);
  return best;
}

/**
 * Per-camera hidden types: the event is hidden when everything it saw (besides motion/audio) is
 * hidden. Motion-only events stay visible.
 */
function hiddenByCamera(types: Set<string>, hidden: string[] | undefined): boolean {
  if (!hidden?.length) return false;
  const set = new Set(hidden.map(lower));
  let any = false;
  for (const t of types) {
    if (NON_OBJECT_TYPES.has(t)) continue;
    any = true;
    if (!set.has(t)) return false;
  }
  return any;
}

/**
 * The content filter of the recordings page: three groups (triggers, event types, attributes), each
 * true when the event has any selected value. `filterLogicTriggers` joins triggers with types,
 * `filterLogicAttributes` joins what came before with attributes (default «ИЛИ»). «И» binds tighter
 * than «ИЛИ», so `triggers OR types AND attributes` is `triggers OR (types AND attributes)`.
 */
export function matchesContent(ev: RecordedEvent, opts: GetEventsOptions): boolean {
  const hasTriggers = (opts.triggers?.length ?? 0) > 0 || (opts.triggerLabels?.length ?? 0) > 0;
  const hasTypes = !!opts.types?.length;
  const hasAttributes = !!opts.attributes?.length;
  if (!hasTriggers && !hasTypes && !hasAttributes) return true;

  const results: boolean[] = [];
  const ops: ('and' | 'or')[] = [];
  if (hasTriggers) {
    const triggers = ev.triggers ?? [];
    const types = new Set((opts.triggers ?? []).map(lower));
    const labels = new Set((opts.triggerLabels ?? []).map(lower));
    const byType = types.size > 0 && triggers.some((t) => types.has(lower(t.type)));
    const byLabel = labels.size > 0 && triggers.some((t) => t.label != null && labels.has(lower(t.label)));
    results.push(byType || byLabel);
  }
  if (hasTypes) {
    const types = eventTypes(ev);
    results.push(opts.types!.some((wanted) => (wanted === EVENT_TYPE_OTHER ? [...types].some((t) => !NAMED_TYPES.has(t)) : types.has(lower(wanted)))));
    if (hasTriggers) ops.push(opts.filterLogicTriggers === 'and' ? 'and' : 'or');
  }
  if (hasAttributes) {
    const wanted = new Set(opts.attributes!.map(lower));
    results.push((ev.segments ?? []).some((seg) => (seg?.attributes ?? []).some((a) => wanted.has(lower(a.type)))));
    if (hasTriggers || hasTypes) ops.push(opts.filterLogicAttributes === 'and' ? 'and' : 'or');
  }

  const groups = [results[0]];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === 'and') groups[groups.length - 1] = groups[groups.length - 1] && results[i + 1];
    else groups.push(results[i + 1]);
  }
  return groups.some(Boolean);
}

/** All filters of an event query that do not need the recording index (see `hasRecording`). */
export function matchesEvent(ev: RecordedEvent, opts: GetEventsOptions): boolean {
  if (opts.startedSinceMs !== undefined && ev.startTime < opts.startedSinceMs) return false;
  if (opts.hasDetections && !(ev.segments ?? []).some((s) => s?.detections?.length)) return false;
  if (opts.minConfidence) {
    // events without scored detections (sensor triggers, motion) are not ruled out by confidence
    const best = bestScore(ev);
    if (best > 0 && best < opts.minConfidence) return false;
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    const hay = [
      ...(ev.types ?? []),
      ...(ev.segments ?? []).flatMap((s) => [...(s.detections ?? []).map((d) => String(d.label)), ...(s.attributes ?? []).map((a) => String(a.label))]),
      ...(ev.ai ? [ev.ai.title, ev.ai.description, ...ev.ai.tags] : []),
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (hiddenByCamera(eventTypes(ev), opts.hiddenTypes?.[ev.cameraId])) return false;
  return matchesContent(ev, opts);
}
