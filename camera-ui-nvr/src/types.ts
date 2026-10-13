import type { DetectionEvent, DetectionEventType } from '@camera.ui/sdk';
import type { RecordedEpisode } from './episodes.js';

/** Wire shapes of the NVR RPC interface the ViON UI consumes. */

export interface RecordedSegment {
  firstSeen: number;
  lastSeen: number;
  zones?: string[];
  detections: Record<string, unknown>[];
  attributes: Record<string, unknown>[];
  thumbnailAt?: number;
  /** How many people of the segment can be searched for (their vectors are in person_vectors, never here). */
  personVectors?: number;
  [key: string]: unknown;
}

export interface RecordedEvent extends Omit<DetectionEvent, 'segments'> {
  segments: RecordedSegment[];
  thumbnailAt?: number;
  hasRecording?: boolean;
  episodeIds?: string[];
  favorite?: boolean;
  /** Description by the assistant model (AI descriptions setting). */
  ai?: { title: string; description: string; tags: string[]; model?: string; at: number };
}

export interface EventAttachments {
  scene?: Uint8Array;
  strip?: Uint8Array;
  card?: Uint8Array;
  /** One crop per attribute of the current segment (server), or crops keyed by thumbnail key. */
  attributes?: (Uint8Array | null | undefined)[] | Record<string, Uint8Array>;
  /** Detection trace ticks since the previous message (server's frame worker). */
  trace?: TraceTick[];
  [key: string]: unknown;
}

/** One frame of the detection trace; the NVR stores it as is and only reads `tMs`/`src`. */
export interface TraceTick {
  tMs: number;
  rtp?: number;
  src?: string;
  [key: string]: unknown;
}

export interface EventTrace {
  eventId: string;
  /** Zones and thresholds of the camera when the event was recorded. */
  config?: { zones: unknown; objectConfidences?: Record<string, number> };
  offset: number;
  total: number;
  exact: boolean;
  ticks: TraceTick[];
}

export interface TraceFrameTarget {
  tMs: number;
  rtp?: number;
  src?: string;
}

export interface TraceChain {
  role: string;
  videoCodec: string;
  codecString?: string;
  width?: number;
  height?: number;
  /** Decodable in order: every chain starts with a keyframe. */
  frames: NvrFrame[];
  /** Which decoded frame shows which target. */
  keep: { index: number; target: number; exact: boolean }[];
}

/** Optional features of this NVR, so the UI offers only what works. */
export interface NvrFeatures {
  /** Cross-camera episodes (Записи → Показать → Эпизоды). */
  episodes: boolean;
  /** Export honours «Качество» (best/smallest stream). */
  exportQuality: boolean;
  /** Recording can be started and stopped by hand (`nvrStartRecording`), for «По запросу» and «По событию» cameras. */
  manualRecording: boolean;
  /** People who look alike can be searched for (`searchSimilarQuery`). */
  personSearch: boolean;
}

/**
 * The people search: upstream's searchSimilarQuery shape, plus a recorded moment or a picture to start from (the
 * interface has no vectors of its own).
 */
export interface SimilarQuery {
  label?: string;
  person?: number[];
  personModel?: string;
  /** the people of a recorded moment (their vectors are stored), or one of them */
  event?: { eventId: string; segment: number; trackId?: number };
  /** a tight picture of one person, made into a vector by a PersonEmbedding plugin; never stored */
  image?: Uint8Array;
}

export interface SimilarOptions {
  limit?: number;
  startMs?: number;
  endMs?: number;
  cameraIds?: string[];
  /** the least raw cosine a match needs; never below the bottom of the score band */
  minScore?: number;
  filter?: GetEventsOptions;
}

export interface SimilarMatch {
  eventId: string;
  cameraId: string;
  segment: number;
  trackId?: number;
  time: number;
  score: number;
  kind?: 'person';
}

export type SimilarReason = 'no-vectors' | 'no-embedder' | 'no-person' | 'model-mismatch' | 'unsupported';

/** One stay of a person on a camera along a route: from, to, and the moment to show (the asked one on its own stay). */
export interface PersonRouteVisit {
  cameraId: string;
  from: number;
  to: number;
  eventId: string;
  segment: number;
  trackId: number;
  /** raw cosine with the person asked about; 1 for the moment asked from; for a hop the least cosine of its links */
  score: number;
  origin?: true;
  /** reached by hops (camera to camera within minutes, `hopScore`), not alike to the person asked about over the window */
  hop?: true;
}

/** Where a person went, camera after camera, around a moment (personRoute). */
export interface PersonRouteResult {
  mode: 'person' | 'none';
  reason?: SimilarReason;
  origin?: { eventId: string; segment: number; cameraId: string; time: number; people: number };
  visits: PersonRouteVisit[];
  /** the events of the stays, as the event list gives them (favourite, recording), for their cards */
  events: RecordedEvent[];
  /** before and after the moment */
  windowMs: number;
  minScore: number;
  /** the least cosine of a hop: the next camera within minutes of a stay */
  hopScore: number;
  scoreBand: [number, number];
  /** the cameras that filed people in the window: one not listed has no person re-ID and cannot be on the route */
  camerasWithPeople: string[];
  indexedSince?: number;
  /** more moments looked alike than a route takes (the most alike are): stays of people less alike may be missing */
  capped?: boolean;
}

/** A box of a thing found by its words in a picture, as shares of the picture, with how sure the finder is (0..1). */
export interface FoundBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** What the words of a search are in one event's picture (findInEvents). */
export interface FoundInEvent {
  eventId: string;
  /** the best boxes, best first; none when nothing like it is there or the event has no picture */
  boxes: FoundBox[];
  /** the best box is taken for the thing (from `foundScore`) */
  found: boolean;
  /** the found thing with some of what is around it, JPEG */
  crop?: Uint8Array;
}

/** Where the words of a search are in the pictures of events (findInEvents). */
export interface FindInEventsResult {
  query: string;
  /** the query as the finder took it: in English, which it understands */
  english?: string;
  foundScore?: number;
  results: FoundInEvent[];
  /** the events asked for still looked at: ask again for them */
  pending?: string[];
  /** no plugin finds words in pictures (ONNX 1.7.0 does), or it failed (`error`) */
  reason?: 'no-finder' | 'failed';
  error?: string;
}

export interface SimilarResult {
  mode: 'person' | 'none';
  label?: string;
  matches: SimilarMatch[];
  events: RecordedEvent[];
  reason?: SimilarReason;
  /** the oldest moment with a person vector: nothing older can be found */
  indexedSince?: number;
  /** raw cosine band: below it nobody alike, above it about sure */
  scoreBand?: [number, number];
}

/** A recording started by hand; `untilMs` is when it ends by itself. */
export interface ManualRecording {
  cameraId: string;
  active: boolean;
  startedAt?: number;
  untilMs?: number;
  /**
   * Why a recording that was started is not active: `paused`, the disk is full and recording is paused. It keeps
   * `startedAt` and `untilMs` and is active again when there is room before `untilMs`.
   */
  reason?: 'paused';
}

export interface GetEventsOptions {
  types?: string[];
  /** Sensor/trigger types (motion, audio, contact, doorbell…). */
  triggers?: string[];
  /** Audio labels of audio triggers (doorbell, glass_break…). */
  triggerLabels?: string[];
  /** Attribute types (face, license_plate…). */
  attributes?: string[];
  /** Joins the trigger group with the type group (default «or»). */
  filterLogicTriggers?: 'and' | 'or';
  /** Joins the previous groups with the attribute group (default «or»). */
  filterLogicAttributes?: 'and' | 'or';
  /** Per camera: types whose events are hidden when nothing else was seen. */
  hiddenTypes?: Record<string, string[]>;
  state?: 'active' | 'ended';
  search?: string;
  hasDetections?: boolean;
  minConfidence?: number;
  hasRecording?: boolean;
  withRecordingInfo?: boolean;
  favoritesOnly?: boolean;
  startMs?: number;
  endMs?: number;
  startedSinceMs?: number;
  limit?: number;
  before?: number;
  [key: string]: unknown;
}

export interface DetectionEventMessage {
  type: DetectionEventType | 'episode';
  data: RecordedEvent;
  /** With type 'episode': the episode that changed; `data` is the event that changed it. */
  episode?: RecordedEpisode;
}

export interface RecordingSegment {
  startTime: number;
  endTime: number;
  cameraId?: string;
  liveTip?: boolean;
}

export interface RecordingState {
  cameraId: string;
  state: 'recording' | 'stopped';
  timestamp: number;
}

export interface RecordingsDeletedEvent {
  cameraId: string;
  startMs: number;
  endMs: number;
}

export interface SystemEvent {
  id: string;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  cameraId?: string;
  timestamp: number;
  duration?: number;
  message: string;
}

export interface NvrFrame {
  frame: Uint8Array;
  ts: number;
  keyframe: boolean;
}

export interface NvrPlaybackCallbacks {
  onReady(payload: { sessionId: string; videoCodec: string; codecString: string; width: number; height: number; role?: string; audio?: boolean }): void;
  onVideo(payload: { frame: Uint8Array; ts: number; keyframe?: boolean }): void;
  onBatch?(payload: { items: { frame: Uint8Array; ts: number; audio?: boolean }[] }): void;
  onAudio?(payload: { frame: Uint8Array; ts: number }): void;
  onNoData(payload: { ts: number }): void;
}

export interface StorageStats {
  diskTotalGB: number;
  diskUsedGB: number;
  diskFreeGB: number;
  diskFreePercent: number;
  nvrUsedGB: number;
  nvrQuotaGB: number;
  retentionDays: number;
  smallVolume: boolean;
  paused: boolean;
  cameras: Record<
    string,
    {
      usedBytes: number;
      segmentCount: number;
      oldestDay: string;
      newestDay: string;
      daysCount: number;
      bandwidthMBh: number;
      recordingMode: string;
      isRecording: boolean;
    }
  >;
}

export interface PluginStorageValues {
  retentionDays: number;
  quotaGB: number;
  minFreePercent: number;
  segmentSeconds: number;
  postBufferSeconds: number;
  /** a person's route: the least cosine of a hop between cameras at the middle precision, its minutes, how many in a row */
  routeHopScore?: number;
  routeHopMinutes?: number;
  routeHops?: number;
  [key: string]: unknown;
}
/** One crossing of a line as the NVR keeps it (ingestCrossings): `way` in or out when the line has a way in. */
export interface StoredCrossing {
  cameraId: string;
  line: string;
  direction: 'a-to-b' | 'b-to-a';
  way?: 'in' | 'out';
  label: string;
  trackId: number;
  at: number;
}
