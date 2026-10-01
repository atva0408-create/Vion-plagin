// Tools the assistant can call on the NVR: the recorded events, a day's summary, search by description,
// the license plates read and an event's picture. The server's skills and the daily recap already name
// them (nvr__query_events, nvr__summarize_day...); without them the assistant has no way into the archive.
// Everything here reads; nothing deletes or changes events.
// i18n-skip-file: the descriptions below are read by the model, not shown in the interface.

import type { AssistantToolContext, AssistantToolReference, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';
import type { ClipSearchResult } from './semantic.js';
import type { GetEventsOptions, RecordedEvent } from './types.js';

/** What the tools need from the NVR; kept narrow so they are testable without a running plugin. */
export interface AssistantHost {
  events(cameraIds: string[] | undefined, opts: GetEventsOptions, limit: number): { events: RecordedEvent[]; hasMore: boolean };
  event(eventId: string): RecordedEvent | undefined;
  cameras(): { id: string; name: string }[];
  search(text: string, limit: number): Promise<ClipSearchResult[]>;
  picture(event: RecordedEvent): Promise<Uint8Array | undefined>;
}

const DAY_MS = 24 * 3600_000;
const MAX_EVENTS = 50;
const DEFAULT_EVENTS = 20;
/** Events one summary may read: a busy day of six cameras stays well under it. */
const SUMMARY_SCAN = 5000;
const SUMMARY_HIGHLIGHTS = 12;
/** The chat offers at most a handful of buttons per result. */
const MAX_REFERENCES = 6;
/** A recap card shows its last 12 moments and the host keeps 12 references: one button per row of the card. */
const RECAP_REFERENCES = 12;

const LABELS = ['person', 'vehicle', 'animal'];

export const ASSISTANT_TOOLS: AssistantToolSpec[] = [
  {
    name: 'query_events',
    description:
      'Recorded events (detections) in a time range, newest first: camera, start and end, what was seen (person, vehicle, animal), ' +
      'license plates, recognized faces and the AI title. Filter by camera, label, plate text or face name. Default range: the last 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time', description: 'Start of the range, ISO 8601; default 24 hours before `to`' },
        to: { type: 'string', format: 'date-time', description: 'End of the range, ISO 8601; default now' },
        camera: { type: 'string', description: 'Camera name, all cameras when omitted' },
        labels: { type: 'array', items: { type: 'string', enum: LABELS }, description: 'Only events that saw one of these' },
        plate: { type: 'string', description: 'Only events with a license plate containing this text' },
        face: { type: 'string', description: 'Only events with this recognized person' },
        favorites: { type: 'boolean', description: 'Only events marked as favorite' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_EVENTS, description: `Events to return, default ${DEFAULT_EVENTS}` },
      },
    },
  },
  {
    name: 'summarize_day',
    description:
      'Summary of one day or several days of events: how many, per camera and per label, the plates and faces seen, and the notable events ' +
      '(with their AI titles) in time order. `date` is the last day in the user time zone (default today), `days` how many days back from it.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date', description: 'Last day, YYYY-MM-DD, in the user time zone; default today' },
        days: { type: 'integer', minimum: 1, maximum: 7, description: 'Days ending with `date`, default 1' },
        camera: { type: 'string', description: 'Camera name, all cameras when omitted' },
      },
    },
  },
  {
    name: 'search_events_by_text',
    description:
      'Find events by what the picture shows, described in words (any language), for example "a man with a bicycle" or "white van at the gate". ' +
      'Uses the image vectors and the AI descriptions; best matches first. Needs the CLIP/SigLIP search enabled on the cameras.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to look for' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Results, default 10' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_plates',
    description:
      'License plates read in a time range: each plate with how many events, first and last time seen and the cameras. ' +
      'The events of one plate come from query_events with `plate`. Default range: the last 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time', description: 'Start of the range, ISO 8601; default 7 days before `to`' },
        to: { type: 'string', format: 'date-time', description: 'End of the range, ISO 8601; default now' },
        camera: { type: 'string', description: 'Camera name, all cameras when omitted' },
      },
    },
  },
  {
    name: 'get_event_image',
    description: 'The picture of one event (the frame the event was recorded with), to look at what happened. Takes an event id from query_events or search.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'Event id' } },
      required: ['eventId'],
    },
  },
];

type Input = Record<string, unknown>;

export async function callAssistantTool(host: AssistantHost, name: string, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  switch (name) {
    case 'query_events':
      return queryEvents(host, input, ctx);
    case 'summarize_day':
      return summarizeDay(host, input, ctx);
    case 'search_events_by_text':
      return searchByText(host, input, ctx);
    case 'list_plates':
      return listPlates(host, input, ctx);
    case 'get_event_image':
      return eventImage(host, input, ctx);
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// ------------------------------------------------------------------ tools

function queryEvents(host: AssistantHost, input: Input, ctx: AssistantToolContext): AssistantToolResult {
  const range = timeRange(input, DAY_MS);
  if ('error' in range) return range;
  const camera = resolveCamera(host, input.camera);
  if ('error' in camera) return camera;
  const limit = clampInt(input.limit, 1, MAX_EVENTS, DEFAULT_EVENTS);
  const labels = stringList(input.labels).filter((l) => LABELS.includes(l));
  const plate = normalizePlate(input.plate);
  const face = typeof input.face === 'string' ? input.face.trim().toLowerCase() : '';

  // plate and face are matched here: the store filter knows attribute types, not their values
  const narrowed = !!plate || !!face;
  const { events, hasMore } = host.events(
    camera.ids,
    {
      startMs: range.from,
      endMs: range.to,
      types: labels.length ? labels : undefined,
      favoritesOnly: input.favorites === true || undefined,
      limit: narrowed ? SUMMARY_SCAN : limit,
    },
    narrowed ? SUMMARY_SCAN : limit,
  );
  const matching = events.filter(
    (ev) => (!plate || platesOf(ev).some((p) => normalizePlate(p).includes(plate))) && (!face || facesOf(ev).some((f) => f.toLowerCase() === face)),
  );
  const page = matching.slice(0, limit);
  const names = cameraNames(host);
  return {
    content: {
      from: iso(range.from),
      to: iso(range.to),
      timezone: ctx.timezone,
      count: page.length,
      more: matching.length > limit || hasMore,
      events: page.map((ev) => brief(ev, names)),
    },
    references: page.slice(0, MAX_REFERENCES).map((ev) => reference(ev, names, ctx)),
  };
}

function summarizeDay(host: AssistantHost, input: Input, ctx: AssistantToolContext): AssistantToolResult {
  const today = dateIn(Date.now(), ctx.timezone);
  const last = typeof input.date === 'string' && input.date.trim() ? input.date.trim() : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last) || Number.isNaN(Date.parse(`${last}T00:00:00Z`))) return { error: `date must be YYYY-MM-DD, got "${String(input.date)}"` };
  const count = clampInt(input.days, 1, 7, 1);
  const camera = resolveCamera(host, input.camera);
  if ('error' in camera) return camera;

  const names = cameraNames(host);
  const days: Record<string, unknown>[] = [];
  const highlights: RecordedEvent[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = shiftDate(last, -i);
    const from = startOfDay(date, ctx.timezone);
    const to = startOfDay(shiftDate(date, 1), ctx.timezone) - 1;
    const { events, hasMore } = host.events(camera.ids, { startMs: from, endMs: to, limit: SUMMARY_SCAN }, SUMMARY_SCAN);
    const byCamera: Record<string, number> = {};
    const byLabel: Record<string, number> = {};
    const plates = new Set<string>();
    const faces = new Set<string>();
    for (const ev of events) {
      const cam = names.get(ev.cameraId) ?? ev.cameraId;
      byCamera[cam] = (byCamera[cam] ?? 0) + 1;
      for (const label of labelsOf(ev)) byLabel[label] = (byLabel[label] ?? 0) + 1;
      for (const p of platesOf(ev)) plates.add(p);
      for (const f of facesOf(ev)) faces.add(f);
    }
    const notable = pickNotable(events, SUMMARY_HIGHLIGHTS);
    highlights.push(...notable);
    days.push({
      date,
      total: events.length,
      capped: hasMore,
      byCamera,
      byLabel,
      plates: [...plates],
      faces: [...faces],
      events: notable.map((ev) => ({ ...brief(ev, names), title: titleOf(ev) })),
    });
  }
  const content = count === 1 ? { ...days[0], timezone: ctx.timezone } : { from: shiftDate(last, -(count - 1)), to: last, timezone: ctx.timezone, days };
  return { content, references: highlights.slice(-RECAP_REFERENCES).map((ev) => reference(ev, names, ctx)) };
}

async function searchByText(host: AssistantHost, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return { error: 'text is required' };
  const limit = clampInt(input.limit, 1, 30, 10);
  const found = await host.search(text, limit);
  const names = cameraNames(host);
  const events = found.map((r) => ({ hit: r, event: host.event(r.eventId) }));
  return {
    content: {
      query: text,
      count: found.length,
      results: events.map(({ hit, event }) =>
        event
          ? { ...brief(event, names), score: round(hit.score) }
          : { id: hit.eventId, camera: names.get(hit.cameraId) ?? hit.cameraId, start: iso(hit.timestamp), score: round(hit.score) },
      ),
      ...(found.length
        ? {}
        : {
            hint:
              'Nothing matched. Search by description needs CLIP/SigLIP on the cameras; ' +
              'events recorded before it was enabled are indexed by "Reindex" on the recordings page.',
          }),
    },
    references: events
      .filter((e): e is { hit: ClipSearchResult; event: RecordedEvent } => !!e.event)
      .slice(0, MAX_REFERENCES)
      .map(({ event }) => reference(event, names, ctx)),
  };
}

function listPlates(host: AssistantHost, input: Input, ctx: AssistantToolContext): AssistantToolResult {
  const range = timeRange(input, 7 * DAY_MS);
  if ('error' in range) return range;
  const camera = resolveCamera(host, input.camera);
  if ('error' in camera) return camera;
  const names = cameraNames(host);
  const { events, hasMore } = host.events(camera.ids, { startMs: range.from, endMs: range.to, attributes: ['license_plate'], limit: SUMMARY_SCAN }, SUMMARY_SCAN);
  const plates = new Map<string, { plate: string; events: number; first: number; last: number; cameras: Set<string> }>();
  for (const ev of events) {
    for (const text of new Set(platesOf(ev).map(normalizePlate).filter(Boolean))) {
      const entry = plates.get(text) ?? { plate: text, events: 0, first: ev.startTime, last: ev.startTime, cameras: new Set<string>() };
      entry.events++;
      entry.first = Math.min(entry.first, ev.startTime);
      entry.last = Math.max(entry.last, ev.startTime);
      entry.cameras.add(names.get(ev.cameraId) ?? ev.cameraId);
      plates.set(text, entry);
    }
  }
  const list = [...plates.values()].sort((a, b) => b.last - a.last);
  return {
    content: {
      from: iso(range.from),
      to: iso(range.to),
      timezone: ctx.timezone,
      count: list.length,
      capped: hasMore,
      plates: list.map((p) => ({ plate: p.plate, events: p.events, firstSeen: iso(p.first), lastSeen: iso(p.last), cameras: [...p.cameras] })),
    },
  };
}

async function eventImage(host: AssistantHost, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const id = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  const event = id ? host.event(id) : undefined;
  if (!event) return { error: `No event with id "${id}". Take the id from query_events or search_events_by_text.` };
  const names = cameraNames(host);
  const picture = await host.picture(event);
  const info = brief(event, names);
  if (!picture?.length) return { content: { ...info, image: 'This event has no saved picture.' }, references: [reference(event, names, ctx)] };
  return {
    content: { ...info, image: 'attached' },
    images: [{ data: Buffer.from(picture).toString('base64'), mimeType: 'image/jpeg', caption: `${info.camera} · ${info.start}` }],
    references: [reference(event, names, ctx)],
  };
}

// ------------------------------------------------------------------ event fields

export function labelsOf(ev: RecordedEvent): string[] {
  const out = new Set<string>();
  for (const seg of ev.segments ?? []) for (const d of seg?.detections ?? []) if (typeof d.label === 'string' && d.label) out.add(d.label.toLowerCase());
  for (const t of ev.types ?? []) if (LABELS.includes(String(t).toLowerCase())) out.add(String(t).toLowerCase());
  return [...out];
}

export function platesOf(ev: RecordedEvent): string[] {
  return attributeLabels(ev, 'license_plate');
}

export function facesOf(ev: RecordedEvent): string[] {
  // an unrecognized face has no identity name; "unknown" is not a person to report
  return attributeLabels(ev, 'face').filter((name) => name && name.toLowerCase() !== 'unknown');
}

function attributeLabels(ev: RecordedEvent, type: string): string[] {
  const out = new Set<string>();
  for (const seg of ev.segments ?? []) for (const a of seg?.attributes ?? []) if (a?.type === type && typeof a.label === 'string' && a.label) out.add(a.label);
  return [...out];
}

function titleOf(ev: RecordedEvent): string {
  // the first non-empty of: AI title, what was seen, the event types
  const candidates = [ev.ai?.title?.trim() ?? '', [...labelsOf(ev), ...platesOf(ev), ...facesOf(ev)].join(', '), (ev.types ?? []).join(', ')];
  return candidates.find((text) => text.length > 0) ?? 'motion';
}

function brief(ev: RecordedEvent, names: Map<string, string>) {
  return {
    id: ev.id,
    camera: names.get(ev.cameraId) ?? ev.cameraId,
    start: iso(ev.startTime),
    ...(ev.endTime ? { end: iso(ev.endTime) } : { state: 'active' }),
    labels: labelsOf(ev),
    ...(platesOf(ev).length ? { plates: platesOf(ev) } : {}),
    ...(facesOf(ev).length ? { faces: facesOf(ev) } : {}),
    ...(ev.ai?.title ? { title: ev.ai.title } : {}),
    ...(ev.favorite ? { favorite: true } : {}),
  };
}

function reference(ev: RecordedEvent, names: Map<string, string>, ctx: AssistantToolContext): AssistantToolReference {
  const time = new Intl.DateTimeFormat(ctx.language || 'en', { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(
    ev.startTime,
  );
  return { kind: 'event', id: ev.id, cameraId: ev.cameraId, timestamp: ev.startTime, label: `${names.get(ev.cameraId) ?? ev.cameraId} · ${time}` };
}

/** The events worth naming in a summary: those with an AI title, a plate or a face first, then people and vehicles, in time order. */
function pickNotable(events: RecordedEvent[], max: number): RecordedEvent[] {
  const weight = (ev: RecordedEvent) =>
    (ev.ai?.title ? 8 : 0) +
    (platesOf(ev).length ? 4 : 0) +
    (facesOf(ev).length ? 4 : 0) +
    (labelsOf(ev).includes('person') ? 2 : 0) +
    (labelsOf(ev).includes('vehicle') ? 1 : 0) +
    (ev.favorite ? 8 : 0);
  return [...events]
    .sort((a, b) => weight(b) - weight(a) || b.startTime - a.startTime)
    .slice(0, max)
    .sort((a, b) => a.startTime - b.startTime);
}

// ------------------------------------------------------------------ input

function resolveCamera(host: AssistantHost, value: unknown): { ids: string[] | undefined } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { ids: undefined };
  const wanted = value.trim().toLowerCase();
  const cameras = host.cameras();
  const match = cameras.filter((c) => c.name.toLowerCase() === wanted || c.id === value.trim());
  if (match.length) return { ids: match.map((c) => c.id) };
  const partial = cameras.filter((c) => c.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { ids: [partial[0].id] };
  return { error: `Unknown camera "${value}". Cameras: ${cameras.map((c) => c.name).join(', ') || 'none'}` };
}

function timeRange(input: Input, span: number): { from: number; to: number } | { error: string } {
  const to = parseTime(input.to) ?? Date.now();
  const from = parseTime(input.from) ?? to - span;
  if (input.to !== undefined && parseTime(input.to) === undefined) return { error: `to is not a date-time: ${JSON.stringify(input.to)}` };
  if (input.from !== undefined && parseTime(input.from) === undefined) return { error: `from is not a date-time: ${JSON.stringify(input.from)}` };
  if (from > to) return { error: 'from is after to' };
  return { from, to };
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && value !== undefined && value !== null && value !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase());
  if (typeof value === 'string' && value.trim()) return [value.trim().toLowerCase()];
  return [];
}

/** Plates are compared without spaces, dashes and case: "А 123 ВС" and "a123bc" are the same plate. */
export function normalizePlate(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
}

function cameraNames(host: AssistantHost): Map<string, string> {
  return new Map(host.cameras().map((c) => [c.id, c.name]));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ------------------------------------------------------------------ days in the user time zone

/** YYYY-MM-DD of an instant in a time zone. */
export function dateIn(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(timezone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The instant a local day starts in a time zone (midnight, or the first moment after it on a DST jump). */
export function startOfDay(date: string, timezone: string): number {
  const zone = safeZone(timezone);
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  // two rounds: the offset at the guess can differ from the offset at the answer across a DST change
  let guess = utcMidnight - offsetAt(utcMidnight, zone);
  guess = utcMidnight - offsetAt(guess, zone);
  return guess;
}

function offsetAt(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
