// Semantic search over recorded events: every CLIP image vector the server attaches to an event
// (one per object crop) lands in a SQLite table; a text query is encoded by a ClipDetection plugin
// and compared against the vectors of the same model. Brute force over unit vectors kept in memory
// per model: a few hundred thousand 512-d vectors scan in well under a second.

import { dot, fromBlob, normalize, toBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';
import type { RecordedEvent } from './types.js';

export interface ClipSearchResult {
  eventId: string;
  cameraId: string;
  score: number;
  timestamp: number;
  label: string;
}

export interface ClipReindexStatus {
  running: boolean;
  total: number;
  done: number;
  skipped: number;
  error?: string;
}

export interface TextEmbedding {
  embedding: number[];
  embeddingModel: string;
  scoreBand?: [number, number];
}

export interface ImageEmbedding {
  embeddings: { embedding: number[] }[];
  embeddingModel: string;
  scoreBand?: [number, number];
}

/** What the NVR needs from a ClipDetection plugin. */
export interface ClipEncoder {
  getTextEmbedding(text: string): Promise<TextEmbedding>;
  getTextEmbeddings?(text: string): Promise<TextEmbedding[]>;
  embedImages?(images: Uint8Array[], config?: Record<string, unknown>): Promise<(ImageEmbedding | undefined)[]>;
}

interface Entry {
  eventId: string;
  cameraId: string;
  ts: number;
  label: string;
  vec: Float32Array;
}

/** Whole-picture vectors from a re-index use this attribute slot. */
export const SCENE_ATTR = -1;
/** Raw cosine band used when a plugin reports none (CLIP ViT-B/32 text-image). */
const DEFAULT_BAND: [number, number] = [0.15, 0.38];

export class SemanticIndex {
  /** model → `${event}/${seg}/${attr}` → entry; filled from the table on the first search of a model */
  private cache = new Map<string, Map<string, Entry>>();
  private bands = new Map<string, [number, number]>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clip_vectors (
        event_id TEXT NOT NULL,
        seg INTEGER NOT NULL,
        attr INTEGER NOT NULL,
        camera_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        label TEXT NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (event_id, seg, attr)
      );
      CREATE INDEX IF NOT EXISTS clip_vectors_model ON clip_vectors (model);
    `);
  }

  /** Stores the CLIP vectors carried by the event's segments (idempotent per segment/attribute). */
  public ingest(event: RecordedEvent): number {
    let added = 0;
    const insert = this.db.prepare('INSERT OR REPLACE INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    event.segments.forEach((segment, seg) => {
      const primary = segment.detections?.[0] as { label?: string } | undefined;
      (segment.attributes ?? []).forEach((raw, attr) => {
        const a = raw as { type?: string; label?: string; clipEmbedding?: number[]; clipEmbeddingModel?: string; parentTrackId?: number };
        if (!Array.isArray(a.clipEmbedding) || !a.clipEmbedding.length || !a.clipEmbeddingModel) return;
        const parent = (segment.detections ?? []).find((d) => (d as { trackId?: number }).trackId === a.parentTrackId) as { label?: string } | undefined;
        const label = parent?.label ?? primary?.label ?? (a.type === 'clip' ? '' : (a.label ?? ''));
        const ts = (segment as { firstSeen?: number }).firstSeen ?? event.startTime;
        const vec = normalize(a.clipEmbedding);
        insert.run(event.id, seg, attr, event.cameraId, ts, label, a.clipEmbeddingModel, toBlob(vec));
        this.cache.get(a.clipEmbeddingModel)?.set(`${event.id}/${seg}/${attr}`, { eventId: event.id, cameraId: event.cameraId, ts, label, vec });
        added++;
      });
    });
    return added;
  }

  public addScene(event: { id: string; cameraId: string; startTime: number; label: string }, model: string, vector: number[]): void {
    const vec = normalize(vector);
    this.db
      .prepare('INSERT OR REPLACE INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
      .run(event.id, SCENE_ATTR, event.cameraId, event.startTime, event.label, model, toBlob(vec));
    this.cache.delete(model);
  }

  public hasVectors(eventId: string, model: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM clip_vectors WHERE event_id = ? AND model = ? LIMIT 1').get(eventId, model);
  }

  public deleteEvents(ids: string[]): void {
    if (!ids.length) return;
    const del = this.db.prepare('DELETE FROM clip_vectors WHERE event_id = ?');
    for (const id of ids) del.run(id);
    const gone = new Set(ids);
    for (const entries of this.cache.values()) for (const [key, e] of entries) if (gone.has(e.eventId)) entries.delete(key);
  }

  public count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM clip_vectors').get() as { n: number }).n);
  }

  /**
   * Ranks events by their best-matching vector for each query embedding (one per model the encoder
   * serves). Scores are mapped onto 0..1 with the model's band so a threshold means the same for all models.
   */
  public search(queries: TextEmbedding[], limit = 50, threshold = 0): ClipSearchResult[] {
    const best = new Map<string, ClipSearchResult>();
    for (const q of queries) {
      if (!q?.embedding?.length) continue;
      const band = q.scoreBand ?? this.bands.get(q.embeddingModel) ?? DEFAULT_BAND;
      this.bands.set(q.embeddingModel, band);
      const text = normalize(q.embedding);
      for (const e of this.entries(q.embeddingModel)) {
        const raw = dot(text, e.vec);
        const score = Math.max(0, Math.min(1, (raw - band[0]) / (band[1] - band[0] || 1)));
        if (score < threshold) continue;
        const prev = best.get(e.eventId);
        if (!prev || score > prev.score)
          best.set(e.eventId, { eventId: e.eventId, cameraId: e.cameraId, score: Math.round(score * 1000) / 1000, timestamp: e.ts, label: e.label });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || b.timestamp - a.timestamp).slice(0, limit);
  }

  private entries(model: string): Iterable<Entry> {
    let entries = this.cache.get(model);
    if (!entries) {
      const rows = this.db.prepare('SELECT event_id, seg, attr, camera_id, ts, label, vec FROM clip_vectors WHERE model = ?').all(model) as {
        event_id: string;
        seg: number;
        attr: number;
        camera_id: string;
        ts: number;
        label: string;
        vec: Uint8Array;
      }[];
      entries = new Map(
        rows.map((r) => [`${r.event_id}/${r.seg}/${r.attr}`, { eventId: r.event_id, cameraId: r.camera_id, ts: r.ts, label: r.label, vec: fromBlob(r.vec) }]),
      );
      this.cache.set(model, entries);
    }
    return entries.values();
  }
}
