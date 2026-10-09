/**
 * Events other extensions report to the timeline in their own words: VOICE tells «Сыночка за компьютером во время сна»
 * with the reminders the child let pass. The NVR keeps them like detection events; this checks what comes over RPC.
 */

export interface ExternalEventInput {
  /** Who reports it, lowercase: the event's type in the timeline ("voice"). */
  source: string;
  title: string;
  description: string;
  tags?: string[];
  /** When what it tells of began (ms); now when absent, never later than now, at most a day back. */
  startTime?: number;
  /** How long it stays open from now, seconds: a camera that records by events records that long and the post-buffer. */
  recordSeconds?: number;
  /** The picture of the moment, JPEG. */
  snapshot?: Uint8Array;
}

export interface ExternalEventResult {
  eventId: string;
  startTime: number;
  /** When the event closes (ms): the recording of it is complete a segment after. */
  endTime: number;
}

export interface CheckedExternalEvent {
  source: string;
  title: string;
  description: string;
  tags: string[];
  startTime: number;
  recordSeconds: number;
  snapshot?: Uint8Array;
}

const SOURCE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS = 10;
const MAX_TAG = 40;
const MAX_RECORD_SECONDS = 300;
export const DEFAULT_RECORD_SECONDS = 30;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 3600_000;

/** What another extension sent, checked: an Error with the reason when it cannot be an event. */
export function checkExternalEvent(cameraId: unknown, input: unknown, now = Date.now()): CheckedExternalEvent {
  if (typeof cameraId !== 'string' || !cameraId.trim() || cameraId.length > 200) throw new Error('cameraId: the id of a camera');
  if (!input || typeof input !== 'object') throw new Error('the event: an object');
  const raw = input as Record<string, unknown>;
  if (typeof raw.source !== 'string' || !SOURCE.test(raw.source)) throw new Error('source: lowercase letters, digits, "-" or "_", up to 32');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > MAX_TITLE) throw new Error(`title: 1-${MAX_TITLE} characters`);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > MAX_DESCRIPTION) throw new Error(`description: at most ${MAX_DESCRIPTION} characters`);
  const tags = raw.tags === undefined ? [] : raw.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > MAX_TAG))
    throw new Error(`tags: up to ${MAX_TAGS} words of up to ${MAX_TAG} characters`);
  if (raw.startTime !== undefined && (typeof raw.startTime !== 'number' || !Number.isFinite(raw.startTime))) throw new Error('startTime: ms since 1970');
  const recordSeconds = raw.recordSeconds === undefined ? DEFAULT_RECORD_SECONDS : raw.recordSeconds;
  if (typeof recordSeconds !== 'number' || !Number.isFinite(recordSeconds) || recordSeconds < 0 || recordSeconds > MAX_RECORD_SECONDS)
    throw new Error(`recordSeconds: 0-${MAX_RECORD_SECONDS}`);
  const snapshot = raw.snapshot;
  if (snapshot !== undefined && (!(snapshot instanceof Uint8Array) || snapshot.length === 0 || snapshot.length > MAX_SNAPSHOT_BYTES))
    throw new Error('snapshot: a JPEG of at most 5 MB');
  // a start in the future would sort the event before everything; a week-old one is not what is happening now
  const startTime = Math.max(now - DAY_MS, Math.min(typeof raw.startTime === 'number' ? raw.startTime : now, now));
  return {
    source: raw.source,
    title,
    description,
    tags: (tags as string[]).map((tag) => tag.trim()),
    startTime,
    recordSeconds: Math.round(recordSeconds),
    ...(snapshot ? { snapshot: snapshot } : {}),
  };
}
