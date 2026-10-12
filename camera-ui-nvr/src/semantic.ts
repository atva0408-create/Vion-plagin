// Semantic search over recorded events: every CLIP image vector the server attaches to an event
// (one per object crop) lands in a SQLite table; a text query is encoded by a ClipDetection plugin
// and compared against the vectors of the same model. The vectors of a model are held by a compact
// index (vector-index.ts, their signs only), which picks the candidates the table then scores exactly.

import { loadIndexes, VectorIndex } from './vector-index.js';
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
  /** Where the words are in each picture (camera-ui-onnx textfind.py, ONNX 1.7.0). */
  findInPictures?(text: string, images: Uint8Array[], config?: Record<string, unknown>): Promise<TextFindAnswer>;
}

export interface TextFindAnswer {
  query: string;
  foundScore?: number;
  pictures: { boxes: { x: number; y: number; width: number; height: number; score: number }[]; crop?: Uint8Array }[];
}

/** Whole-picture vectors from a re-index use this attribute slot. */
export const SCENE_ATTR = -1;
/** Raw cosine band used when a plugin reports none (CLIP ViT-B/32 text-image). */
const DEFAULT_BAND: [number, number] = [0.15, 0.38];
/**
 * The vectors scored exactly for one query: every vector up to this many, beyond it those whose signs agree most with
 * the query's (spec/vector-index.spec.ts: the 50 best of a full scan of clustered vectors are among them).
 */
const CANDIDATES = 2000;

export class SemanticIndex {
  /** model → its vectors' index; read from the table in the background (warm), then kept in step */
  private indexes = new Map<string, VectorIndex>();
  private warming?: Promise<void>;
  private warmed = false;
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
        const index = this.indexFor(a.clipEmbeddingModel, vec.length);
        // the row replaced gets a new rowid: the old one leaves the index
        const old = index ? this.rowidOf(event.id, seg, attr) : undefined;
        const { lastInsertRowid } = insert.run(event.id, seg, attr, event.cameraId, ts, label, a.clipEmbeddingModel, toBlob(vec));
        if (index) {
          if (old !== undefined) index.remove(old);
          index.add(Number(lastInsertRowid), vec, ts, event.cameraId);
        }
        added++;
      });
    });
    return added;
  }

  public addScene(event: { id: string; cameraId: string; startTime: number; label: string }, model: string, vector: number[]): void {
    const vec = normalize(vector);
    const index = this.indexFor(model, vec.length);
    const old = index ? this.rowidOf(event.id, 0, SCENE_ATTR) : undefined;
    const { lastInsertRowid } = this.db
      .prepare('INSERT OR REPLACE INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
      .run(event.id, SCENE_ATTR, event.cameraId, event.startTime, event.label, model, toBlob(vec));
    // the motion-only events are indexed by the hundred: the index is kept in step, not read again each time
    if (index) {
      if (old !== undefined) index.remove(old);
      index.add(Number(lastInsertRowid), vec, event.startTime, event.cameraId);
    }
  }

  /**
   * Reads the vectors into their indexes in the background, once; the searches wait for it. A failed read is tried
   * again by the next search.
   */
  public warm(): Promise<void> {
    this.warming ??= loadIndexes(this.db, 'clip_vectors', this.indexes).then(
      () => {
        this.warmed = true;
      },
      (error: unknown) => {
        this.warming = undefined;
        throw error;
      },
    );
    return this.warming;
  }

  /** The index a new vector of a model goes to; none while a model's vectors are still to be read (they will be). */
  private indexFor(model: string, dim: number): VectorIndex | undefined {
    let index = this.indexes.get(model);
    if (!index && this.warmed) {
      index = new VectorIndex(dim);
      this.indexes.set(model, index);
    }
    return index;
  }

  private rowidOf(eventId: string, seg: number, attr: number): number | undefined {
    const row = this.db.prepare('SELECT rowid AS id FROM clip_vectors WHERE event_id = ? AND seg = ? AND attr = ?').get(eventId, seg, attr) as
      | { id: number | bigint }
      | undefined;
    return row ? Number(row.id) : undefined;
  }

  public hasVectors(eventId: string, model: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM clip_vectors WHERE event_id = ? AND model = ? LIMIT 1').get(eventId, model);
  }

  /** Ids of the ended events that have no vector of `model` yet, newest first: what the search cannot find. */
  public unindexed(model: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM events
         WHERE state = 'ended' AND NOT EXISTS (SELECT 1 FROM clip_vectors v WHERE v.event_id = events.id AND v.model = ?)
         ORDER BY start_ms DESC LIMIT ?`,
      )
      .all(model, limit) as unknown as { id: string }[];
    return rows.map((row) => row.id);
  }

  public deleteEvents(ids: string[]): void {
    if (!ids.length) return;
    const del = this.db.prepare('DELETE FROM clip_vectors WHERE event_id = ?');
    const rows = this.indexes.size ? this.db.prepare('SELECT rowid AS id, model FROM clip_vectors WHERE event_id = ?') : undefined;
    for (const id of ids) {
      for (const row of (rows?.all(id) ?? []) as { id: number | bigint; model: string }[]) this.indexes.get(row.model)?.remove(Number(row.id));
      del.run(id);
    }
  }

  public count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM clip_vectors').get() as { n: number }).n);
  }

  /**
   * Ranks events by their best-matching vector for each query embedding (one per model the encoder
   * serves). Scores are mapped onto 0..1 with the model's band so a threshold means the same for all models.
   */
  public async search(queries: TextEmbedding[], limit = 50, threshold = 0): Promise<ClipSearchResult[]> {
    await this.warm();
    const best = new Map<string, ClipSearchResult>();
    for (const q of queries) {
      if (!q?.embedding?.length) continue;
      const band = q.scoreBand ?? this.bands.get(q.embeddingModel) ?? DEFAULT_BAND;
      this.bands.set(q.embeddingModel, band);
      const text = normalize(q.embedding);
      for (const e of this.scored(q.embeddingModel, text)) {
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

  /** The candidates of the model's index for a query, with what the table holds of them. */
  private *scored(model: string, query: Float32Array): Iterable<{ eventId: string; cameraId: string; ts: number; label: string; vec: Float32Array }> {
    const index = this.indexes.get(model);
    if (!index) return;
    const row = this.db.prepare('SELECT event_id, camera_id, ts, label, vec FROM clip_vectors WHERE rowid = ?');
    for (const id of index.candidates(query, CANDIDATES)) {
      const r = row.get(id) as { event_id: string; camera_id: string; ts: number; label: string; vec: Uint8Array } | undefined;
      if (r) yield { eventId: r.event_id, cameraId: r.camera_id, ts: r.ts, label: r.label, vec: fromBlob(r.vec) };
    }
  }
}
