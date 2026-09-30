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
  [key: string]: unknown;
}
