// Tools the assistant can call on the NVR: the recorded events, a day's summary, search by description,
// the license plates read and an event's picture; whether the cameras recorded and how long the disk lasts; the faces.
// The server's skills and the daily recap already name them (nvr__query_events, nvr__summarize_day...); without them
// the assistant has no way into the archive.
// Reading tools run without asking, also in schedules. The ones that change something (name or forget a face, record
// by hand, delete recordings) declare `approval` and `adminOnly`: the server asks the person in the chat and offers
// them to admins only. Each also answers `__preview` (set only by the server, for the confirmation card) with what it
// would do, and does nothing.
// i18n-skip-file: the descriptions below are read by the model, not shown in the interface.

import type { AssistantToolContext, AssistantToolImage, AssistantToolReference, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';
import type { FaceProfile } from './faces.js';
import type { ClipSearchResult } from './semantic.js';
import type { GetEventsOptions, ManualRecording, RecordedEvent, RecordingSegment, StorageStats, SystemEvent } from './types.js';

/** An unknown face where it was seen: the event, the segment and the place among the segment's attributes. */
export interface UnknownSighting {
  id: string;
  eventId: string;
  seg: number;
  attr: number;
  cameraId: string;
  timestamp: number;
  clusterId?: string;
}

/** What the tools need from the NVR; kept narrow so they are testable without a running plugin. */
export interface AssistantHost {
  events(cameraIds: string[] | undefined, opts: GetEventsOptions, limit: number): { events: RecordedEvent[]; hasMore: boolean };
  event(eventId: string): RecordedEvent | undefined;
  cameras(): { id: string; name: string }[];
  search(text: string, limit: number): Promise<ClipSearchResult[]>;
  picture(event: RecordedEvent): Promise<Uint8Array | undefined>;
  /** Recorded time of a camera, any stream, joined where the gap is under 2 s. */
  coverage(cameraId: string, startMs: number, endMs: number): Promise<RecordingSegment[]>;
  /** Stream, storage and plan events since the plugin started (kept in memory only). */
  systemEvents(cameraIds: string[], startMs: number, endMs: number): Promise<SystemEvent[]>;
  storage(timezone: string): Promise<StorageStats>;
  /** The share of the disk the recorder keeps free: what it deletes the oldest recordings for. */
  minFreePercent(): number;
  knownFaces(): Promise<FaceProfile[]>;
  unknownFaces(): UnknownSighting[];
  faceCrop(eventId: string, seg: number, attr: number): Uint8Array | undefined;
  /** Gives a face of an event a name (learns it) or, with an empty name, puts it back among the unknown. */
  nameFace(eventId: string, seg: number, attr: number, oldName: string, newName: string): Promise<number>;
  ignoreFaces(sighting: UnknownSighting): Promise<void>;
  forgetFace(name: string): Promise<void>;
  manual(cameraId: string): Promise<ManualRecording>;
  startManual(cameraId: string, minutes: number): Promise<ManualRecording>;
  stopManual(cameraId: string): Promise<ManualRecording>;
  recordingMode(cameraId: string): string;
  /** What deleting a range would remove: the segments wholly inside it, past the protected last minutes. */
  deletable(cameraId: string, startMs: number, endMs: number): { segments: number; bytes: number };
  deleteRange(cameraId: string, startMs: number, endMs: number): Promise<{ startMs: number; endMs: number }>;
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
  {
    name: 'recording_health',
    description:
      'Whether cameras recorded through a period: per camera the share of the time recorded, every gap longer than 60 s (start, end, length) ' +
      'with its cause when the recorder logged one (stream lost, recording paused for disk space, plan limit), and the recording mode. ' +
      'A camera recording on events has gaps between events by design. Default: all cameras, the last 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        cameras: { type: 'array', items: { type: 'string' }, description: 'Camera names, all cameras when omitted' },
        from: { type: 'string', format: 'date-time', description: 'Start of the range, ISO 8601; default 24 hours before `to`' },
        to: { type: 'string', format: 'date-time', description: 'End of the range, ISO 8601; default now' },
      },
    },
  },
  {
    name: 'storage_forecast',
    description:
      'How long the archive lasts: the disk (total, used, free), the recorder quota and retention, per camera the days in the archive and the ' +
      'stream in MB/h, and how many days of recording the space holds at the current rate, or that the retention limits the archive first. ' +
      'Says first when recording is paused for lack of space.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_faces',
    description:
      'The faces the recorder knows: each known person with the number of pictures, and the groups of unknown faces (how many, on which ' +
      'cameras, when last seen, and an event id with that face for name_face or ignore_face).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'name_face',
    description:
      'Names the face in an event ("this is Masha, remember her", "that is not dad, it is Ivan"): an unknown face is learned under the name, ' +
      'a face recognized as someone else is corrected. The event id comes from query_events or list_faces. When the event shows several ' +
      'faces the answer lists them and `face` picks one.',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id' },
        name: { type: 'string', description: 'The name of the person' },
        face: { type: 'integer', minimum: 1, description: 'Which face of the event, 1-based, when it has several' },
      },
      required: ['eventId', 'name'],
    },
  },
  {
    name: 'ignore_face',
    description:
      'Stops offering an unknown face for naming: the group of unknown faces the face of the event belongs to is ignored (a passer-by, a ' +
      'poster). The event id comes from list_faces or query_events.',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id' },
        face: { type: 'integer', minimum: 1, description: 'Which face of the event, 1-based, when it has several' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'forget_face',
    description:
      'Forgets a known person: their pictures are deleted and new events no longer recognize them. Past events keep the name. ' +
      'Renaming a known person or joining two known people is only possible in the app (Faces page).',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name of the known person' } },
      required: ['name'],
    },
  },
  {
    name: 'manual_recording',
    description:
      'Starts recording a camera by hand for some minutes (1 to 120, default 5; starting again extends it) or stops it. For cameras that ' +
      'record on events or on demand; a camera in continuous recording records anyway.',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        camera: { type: 'string', description: 'Camera name' },
        action: { type: 'string', enum: ['start', 'stop'] },
        minutes: { type: 'integer', minimum: 1, maximum: 120, description: 'How long, for start; default 5' },
      },
      required: ['camera', 'action'],
    },
  },
  {
    name: 'delete_recordings',
    description:
      'Deletes the recordings of one camera in a range of at most 24 hours. Cannot be undone. Only whole recorded segments inside the ' +
      'range go, the last 3 minutes stay, events stay. Refuses when favorite events fall in the range, listing them; pass ' +
      '`includeFavorites: true` only when the user said in so many words that favorites go too.',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        camera: { type: 'string', description: 'Camera name' },
        from: { type: 'string', format: 'date-time', description: 'Start, ISO 8601' },
        to: { type: 'string', format: 'date-time', description: 'End, ISO 8601' },
        includeFavorites: { type: 'boolean', description: 'Delete also where favorite events are; only when the user said so' },
      },
      required: ['camera', 'from', 'to'],
    },
  },
];

type Input = Record<string, unknown>;

/** The tools that change something: asked for in the chat, admins only. */
const ACTING_TOOLS = new Set(ASSISTANT_TOOLS.filter((tool) => tool.approval).map((tool) => tool.name));

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
    case 'recording_health':
      return recordingHealth(host, input, ctx);
    case 'storage_forecast':
      return storageForecast(host, ctx);
    case 'list_faces':
      return listFaces(host, ctx);
    default:
      break;
  }
  if (!ACTING_TOOLS.has(name)) return { error: `Unknown tool ${name}` };
  // the server offers these to admins only; a call that gets here otherwise is refused here too
  if (ctx.role !== 'admin' && ctx.role !== 'master') return { error: 'Only an administrator can do this.' };
  const preview = input.__preview === true;
  switch (name) {
    case 'name_face':
      return nameFace(host, input, preview);
    case 'ignore_face':
      return ignoreFace(host, input, preview);
    case 'forget_face':
      return forgetFace(host, input, preview);
    case 'manual_recording':
      return manualRecording(host, input, preview);
    case 'delete_recordings':
      return deleteRecordings(host, input, preview);
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

// ------------------------------------------------------------------ recording health and the disk

/** A gap shorter than this is a camera reconnecting, not a hole worth reporting. */
const GAP_MS = 60_000;
/** A cause logged this long before a gap began still explains it: the recorder notices a lost stream late. */
const CAUSE_SLACK_MS = 2 * 60_000;
const MAX_GAPS = 20;

async function recordingHealth(host: AssistantHost, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const range = timeRange(input, DAY_MS);
  if ('error' in range) return range;
  const cameras = resolveCameras(host, input.cameras);
  if ('error' in cameras) return cameras;
  const to = Math.min(range.to, Date.now());
  const span = Math.max(1, to - range.from);
  const system = await host.systemEvents(
    cameras.map((c) => c.id),
    range.from - CAUSE_SLACK_MS,
    to,
  );

  const rows = [];
  for (const camera of cameras) {
    const mode = host.recordingMode(camera.id);
    const recorded = await host.coverage(camera.id, range.from, to);
    let covered = 0;
    for (const seg of recorded) covered += Math.max(0, Math.min(seg.endTime, to) - Math.max(seg.startTime, range.from));
    const gaps = gapsOf(recorded, range.from, to).map((gap) => {
      const cause = causeOf(system, camera.id, gap.start, gap.end);
      return { start: iso(gap.start), end: iso(gap.end), minutes: Math.round((gap.end - gap.start) / 60_000), ...(cause ? { cause } : {}) };
    });
    rows.push({
      camera: camera.name,
      mode,
      recordedPercent: Math.round((covered / span) * 1000) / 10,
      gaps: gaps.length,
      ...(gaps.length ? { longestGaps: gaps.sort((a, b) => b.minutes - a.minutes).slice(0, MAX_GAPS) } : {}),
      ...(mode === 'event' || mode === 'adhoc' ? { note: 'Records on events: time between events is not recorded by design, gaps are expected.' } : {}),
      ...(mode === 'off' ? { note: 'Recording is off for this camera.' } : {}),
    });
  }
  return {
    content: {
      from: iso(range.from),
      to: iso(to),
      timezone: ctx.timezone,
      cameras: rows,
      causes: 'Causes come from what the recorder logged since it last started; an older gap has no known cause.',
    },
  };
}

/** The stretches of [from, to] no segment covers, longer than GAP_MS. */
export function gapsOf(segments: RecordingSegment[], from: number, to: number): { start: number; end: number }[] {
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const gaps: { start: number; end: number }[] = [];
  let cursor = from;
  for (const seg of sorted) {
    if (seg.endTime <= cursor) continue;
    if (seg.startTime > cursor) gaps.push({ start: cursor, end: Math.min(seg.startTime, to) });
    cursor = Math.max(cursor, seg.endTime);
    if (cursor >= to) break;
  }
  if (to > cursor) gaps.push({ start: cursor, end: to });
  return gaps.filter((gap) => gap.end - gap.start > GAP_MS);
}

function causeOf(events: SystemEvent[], cameraId: string, start: number, end: number): string | undefined {
  // the camera's own event first (its stream), then one of the whole recorder (the disk, the plan)
  const near = events.filter((e) => e.severity !== 'success' && e.severity !== 'info' && e.timestamp >= start - CAUSE_SLACK_MS && e.timestamp <= end);
  const event = near.find((e) => e.cameraId === cameraId) ?? near.find((e) => !e.cameraId);
  return event ? `${event.type}: ${event.message}` : undefined;
}

async function storageForecast(host: AssistantHost, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const stats = await host.storage(ctx.timezone);
  const names = cameraNames(host);
  const cameras = Object.entries(stats.cameras).map(([id, cam]) => ({
    camera: names.get(id) ?? id,
    mode: cam.recordingMode,
    recording: cam.isRecording,
    usedGB: Math.round((cam.usedBytes / 1024 ** 3) * 100) / 100,
    daysInArchive: cam.daysCount,
    ...(cam.oldestDay ? { oldestDay: cam.oldestDay } : {}),
    streamMBh: cam.bandwidthMBh,
  }));
  return {
    content: {
      ...(stats.paused ? { paused: 'Recording is paused: there is not enough free disk space. Free space or lower the retention.' } : {}),
      disk: { totalGB: stats.diskTotalGB, usedGB: stats.diskUsedGB, freeGB: stats.diskFreeGB, freePercent: stats.diskFreePercent },
      archive: { usedGB: stats.nvrUsedGB, quotaGB: stats.nvrQuotaGB || 'none', retentionDays: stats.retentionDays },
      forecast: forecast(stats, host.minFreePercent()),
      cameras,
    },
  };
}

/**
 * How many days of recording the space holds at the current rate: what the archive may use (the quota, or the disk
 * past the share the recorder keeps free) over what the recording cameras write a day. The retention cuts first
 * when it is shorter.
 */
export function forecast(stats: StorageStats, minFreePercent: number): Record<string, unknown> {
  const mbPerDay = Object.values(stats.cameras)
    .filter((cam) => cam.isRecording)
    .reduce((sum, cam) => sum + cam.bandwidthMBh * 24, 0);
  const reserveGB = (stats.diskTotalGB * minFreePercent) / 100;
  const diskRoomGB = stats.nvrUsedGB + Math.max(0, stats.diskFreeGB - reserveGB);
  const roomGB = stats.nvrQuotaGB > 0 ? Math.min(stats.nvrQuotaGB, diskRoomGB) : diskRoomGB;
  if (mbPerDay <= 0) return { writingMBPerDay: 0, note: 'No camera is recording now: nothing fills the disk.' };
  const daysOfSpace = Math.floor((roomGB * 1024) / mbPerDay);
  const limitedBy =
    stats.retentionDays > 0 && stats.retentionDays <= daysOfSpace ? 'retention' : stats.nvrQuotaGB > 0 && stats.nvrQuotaGB <= diskRoomGB ? 'quota' : 'disk';
  return {
    writingGBPerDay: Math.round((mbPerDay / 1024) * 100) / 100,
    archiveRoomGB: Math.round(roomGB * 100) / 100,
    daysOfSpace,
    limitedBy,
    archiveDays: limitedBy === 'retention' ? stats.retentionDays : daysOfSpace,
    note:
      limitedBy === 'retention'
        ? `The retention of ${stats.retentionDays} days ends the archive before the space does: older recordings are deleted at ${stats.retentionDays} days.`
        : `At the current rate the space holds about ${daysOfSpace} days; then the oldest recordings are deleted to make room.`,
  };
}

// ------------------------------------------------------------------ faces

async function listFaces(host: AssistantHost, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const names = cameraNames(host);
  const known = await host.knownFaces();
  const groups = new Map<string, UnknownSighting[]>();
  const loose: UnknownSighting[] = [];
  for (const face of host.unknownFaces()) {
    if (!face.clusterId) loose.push(face);
    else groups.set(face.clusterId, [...(groups.get(face.clusterId) ?? []), face]);
  }
  const describe = (faces: UnknownSighting[]) => {
    const last = faces.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    return {
      faces: faces.length,
      cameras: [...new Set(faces.map((f) => names.get(f.cameraId) ?? f.cameraId))],
      lastSeen: iso(last.timestamp),
      eventId: last.eventId,
    };
  };
  return {
    content: {
      timezone: ctx.timezone,
      known: known.map((face) => ({ name: face.name, pictures: face.imageCount })),
      unknownGroups: [...groups.values()]
        .sort((a, b) => b.length - a.length)
        .slice(0, 20)
        .map(describe),
      ...(loose.length ? { unknownAlone: { faces: loose.length, latest: loose.slice(0, 5).map((f) => ({ eventId: f.eventId, seen: iso(f.timestamp) })) } } : {}),
    },
  };
}

interface EventFace {
  seg: number;
  attr: number;
  name: string;
}

/** The faces of an event in the order the recorder saw them; "unknown" for one nobody matched. */
function facesIn(ev: RecordedEvent): EventFace[] {
  const out: EventFace[] = [];
  (ev.segments ?? []).forEach((seg, segIndex) =>
    (seg?.attributes ?? []).forEach((a, attr) => {
      if (a?.type === 'face') out.push({ seg: segIndex, attr, name: typeof a.label === 'string' && a.label ? a.label : 'unknown' });
    }),
  );
  return out;
}

/** The one face of an event the call means, or why there is none. */
function pickFace(host: AssistantHost, input: Input): { event: RecordedEvent; face: EventFace } | { error: string } {
  const id = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  const event = id ? host.event(id) : undefined;
  if (!event) return { error: `No event with id "${id}". Take the id from query_events or list_faces.` };
  const faces = facesIn(event);
  if (!faces.length) return { error: 'This event has no face. Take an event with a face from list_faces or query_events.' };
  if (faces.length === 1) return { event, face: faces[0] };
  const which = Math.round(Number(input.face));
  if (Number.isInteger(which) && which >= 1 && which <= faces.length) return { event, face: faces[which - 1] };
  return {
    error: `The event shows ${faces.length} faces: ${faces.map((f, i) => `${i + 1}. ${f.name}`).join('; ')}. ` + 'Ask the user which one and call again with `face`.',
  };
}

function facePicture(host: AssistantHost, event: RecordedEvent, face: EventFace): AssistantToolImage[] {
  return jpeg(host.faceCrop(event.id, face.seg, face.attr), face.name);
}

function jpeg(data: Uint8Array | undefined, caption: string): AssistantToolImage[] {
  return data?.length ? [{ data: Buffer.from(data).toString('base64'), mimeType: 'image/jpeg', caption }] : [];
}

async function nameFace(host: AssistantHost, input: Input, preview: boolean): Promise<AssistantToolResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.toLowerCase() === 'unknown') return { error: 'name is required: the name of the person.' };
  const picked = pickFace(host, input);
  if ('error' in picked) return picked;
  const { event, face } = picked;
  const camera = cameraNames(host).get(event.cameraId) ?? event.cameraId;
  const current = face.name === 'unknown' ? undefined : face.name;
  if (current?.toLowerCase() === name.toLowerCase()) return { content: { done: false, reason: `This face is already recognized as ${current}.` } };
  if (preview)
    return {
      content: { preview: { action: 'name_face', camera, at: iso(event.startTime), name, ...(current ? { was: current } : {}) } },
      images: facePicture(host, event, face),
    };

  const changed = await host.nameFace(event.id, face.seg, face.attr, face.name, name);
  if (!changed) return { error: 'The face could not be named: the event changed meanwhile. Read it again with query_events.' };
  return { content: { done: true, name, ...(current ? { was: current } : {}), note: 'Learned: new events recognize this face under the name.' } };
}

async function ignoreFace(host: AssistantHost, input: Input, preview: boolean): Promise<AssistantToolResult> {
  const picked = pickFace(host, input);
  if ('error' in picked) return picked;
  const { event, face } = picked;
  if (face.name !== 'unknown') return { error: `This face is recognized as ${face.name}: forget_face forgets a known person, name_face corrects the name.` };
  const sighting = host.unknownFaces().find((f) => f.eventId === event.id && f.seg === face.seg && f.attr === face.attr);
  if (!sighting) return { error: 'This face is no longer among the unknown faces: it was named, ignored or removed.' };
  const group = sighting.clusterId ? host.unknownFaces().filter((f) => f.clusterId === sighting.clusterId).length : 1;
  const camera = cameraNames(host).get(event.cameraId) ?? event.cameraId;
  if (preview) return { content: { preview: { action: 'ignore_face', camera, at: iso(event.startTime), faces: group } }, images: facePicture(host, event, face) };
  await host.ignoreFaces(sighting);
  return { content: { done: true, ignored: group, note: 'These faces are no longer offered for naming; the Faces page lists them under ignored.' } };
}

async function forgetFace(host: AssistantHost, input: Input, preview: boolean): Promise<AssistantToolResult> {
  const wanted = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
  const known = await host.knownFaces();
  const face = known.find((f) => f.name.toLowerCase() === wanted);
  if (!face) return { error: `Nobody is known as "${String(input.name)}". Known: ${known.map((f) => f.name).join(', ') || 'nobody'}.` };
  if (preview) {
    return { content: { preview: { action: 'forget_face', name: face.name, pictures: face.imageCount } }, images: jpeg(face.thumbnail, face.name) };
  }
  await host.forgetFace(face.name);
  return { content: { done: true, forgotten: face.name, note: 'Past events keep the name; new events no longer recognize this person.' } };
}

// ------------------------------------------------------------------ recording by hand, deleting

async function manualRecording(host: AssistantHost, input: Input, preview: boolean): Promise<AssistantToolResult> {
  const camera = resolveOneCamera(host, input.camera);
  if ('error' in camera) return camera;
  const action = input.action === 'stop' ? 'stop' : input.action === 'start' ? 'start' : undefined;
  if (!action) return { error: 'action must be "start" or "stop".' };
  const minutes = clampInt(input.minutes, 1, 120, 5);
  const mode = host.recordingMode(camera.id);
  if (action === 'start' && mode === 'continuous') return { content: { done: false, reason: `${camera.name} records all the time: there is nothing to start.` } };
  if (preview)
    return { content: { preview: { action: 'manual_recording', camera: camera.name, start: action === 'start', ...(action === 'start' ? { minutes } : {}) } } };

  try {
    const state = action === 'start' ? await host.startManual(camera.id, minutes) : await host.stopManual(camera.id);
    if (action === 'stop') return { content: { done: true, camera: camera.name, recording: false } };
    if (state.reason === 'paused') return { content: { done: false, camera: camera.name, reason: 'Recording is paused: not enough free disk space.' } };
    if (!state.active) return { content: { done: false, reason: `${camera.name} records all the time: there is nothing to start.` } };
    return { content: { done: true, camera: camera.name, recording: true, until: iso(state.untilMs ?? Date.now() + minutes * 60_000) } };
  } catch (error) {
    // the recorder says why in its own words: recording off, no slot in the plan, paused
    return { error: `${camera.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const MAX_DELETE_MS = DAY_MS;

async function deleteRecordings(host: AssistantHost, input: Input, preview: boolean): Promise<AssistantToolResult> {
  const camera = resolveOneCamera(host, input.camera);
  if ('error' in camera) return camera;
  const from = parseTime(input.from);
  const to = parseTime(input.to);
  if (from === undefined || to === undefined) return { error: 'from and to are required, ISO 8601 date-times.' };
  if (to <= from) return { error: 'to must be after from.' };
  if (to - from > MAX_DELETE_MS) return { error: 'At most 24 hours of one camera per call. Deleting everything is not possible here.' };

  const favorites = host.events([camera.id], { startMs: from, endMs: to, favoritesOnly: true, limit: MAX_EVENTS }, MAX_EVENTS).events;
  if (favorites.length && input.includeFavorites !== true)
    return {
      error:
        `Favorite events fall in this range, their video would go too: ${favorites.map((ev) => `${titleOf(ev)} at ${iso(ev.startTime)}`).join('; ')}. ` +
        'Ask the user; only when they say favorites go too, call again with includeFavorites: true, or narrow the range.',
    };

  const size = host.deletable(camera.id, from, to);
  if (preview)
    return {
      content: {
        preview: {
          action: 'delete_recordings',
          camera: camera.name,
          from: iso(from),
          to: iso(to),
          segments: size.segments,
          bytes: size.bytes,
          favorites: favorites.length,
        },
      },
    };
  if (!size.segments) return { content: { deleted: false, reason: 'Nothing recorded lies wholly in this range (the last 3 minutes are never deleted).' } };

  const result = await host.deleteRange(camera.id, from, to);
  if (!result.endMs) return { content: { deleted: false, reason: 'Nothing was deleted.' } };
  return {
    content: {
      deleted: true,
      camera: camera.name,
      from: iso(result.startMs),
      to: iso(result.endMs),
      segments: size.segments,
      megabytes: Math.round(size.bytes / 1024 ** 2),
    },
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

/** Faces nobody was matched to: name_face names them. */
function unknownFacesOf(ev: RecordedEvent): number {
  return facesIn(ev).filter((face) => face.name.toLowerCase() === 'unknown').length;
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
    ...(unknownFacesOf(ev) ? { unknownFaces: unknownFacesOf(ev) } : {}),
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

/** One camera by its exact name (or id): an action must not land on the wrong one of two similar names. */
function resolveOneCamera(host: AssistantHost, value: unknown): { id: string; name: string } | { error: string } {
  const cameras = host.cameras();
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const match = cameras.find((c) => c.name.toLowerCase() === wanted || c.id === value);
  return match ?? { error: `Unknown camera "${String(value)}". Give its exact name: ${cameras.map((c) => c.name).join(', ') || 'none'}` };
}

/** Cameras by name, every camera when none is given. */
function resolveCameras(host: AssistantHost, value: unknown): { id: string; name: string }[] | { error: string } {
  const all = host.cameras();
  const wanted = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : [];
  if (!wanted.length) return all;
  const out: { id: string; name: string }[] = [];
  for (const name of wanted) {
    const found = resolveCamera(host, name);
    if ('error' in found) return found;
    for (const id of found.ids ?? []) if (!out.some((c) => c.id === id)) out.push(all.find((c) => c.id === id)!);
  }
  return out;
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
