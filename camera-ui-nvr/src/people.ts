// People who look alike ("похожие люди"): the server's person re-ID vectors (one per person track of a segment,
// averaged over up to three tight crops) are filed here and never in the event JSON, and compared by cosine within a
// time window. Re-ID describes clothes and build, not who someone is: it finds the same person the same day.
// No cache in memory, unlike the CLIP index: a search reads only the rows of its window, which keeps a small box
// (8 GB on the bench) out of trouble with many cameras and days.

import { dot, fromBlob, normalize, toBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';
import type { RecordedEvent } from './types.js';

/** What the server attaches to a segment when it ends (server/src/camera/decoder/nvr-sink.ts). */
export interface PersonEmbedding {
  trackId: number;
  embedding: number[];
  embeddingModel: string;
}

export interface PersonVector {
  trackId: number;
  model: string;
  vec: Float32Array;
}

export interface PersonHit {
  eventId: string;
  cameraId: string;
  seg: number;
  trackId: number;
  ts: number;
  /** raw cosine of the best query vector */
  score: number;
}

export interface PersonSearch {
  fromMs: number;
  toMs: number;
  cameraIds?: Set<string>;
  /** the moment the query came from: never a match of itself */
  exclude?: { eventId: string; seg: number };
  minScore: number;
  limit: number;
}

interface Row {
  event_id: string;
  seg: number;
  track_id: number;
  camera_id: string;
  ts: number;
  vec: Uint8Array;
}

/** The vectors of a segment as the server sends them: finite, non-empty, of a named model. */
export function personEmbeddings(segment: unknown): PersonEmbedding[] {
  const list = (segment as { personEmbeddings?: unknown } | undefined)?.personEmbeddings;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (p): p is PersonEmbedding =>
      !!p &&
      typeof p === 'object' &&
      Number.isInteger((p as PersonEmbedding).trackId) &&
      typeof (p as PersonEmbedding).embeddingModel === 'string' &&
      (p as PersonEmbedding).embeddingModel.length > 0 &&
      Array.isArray((p as PersonEmbedding).embedding) &&
      (p as PersonEmbedding).embedding.length > 0 &&
      (p as PersonEmbedding).embedding.every((v) => typeof v === 'number' && Number.isFinite(v)),
  );
}

export class PersonIndex {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_vectors (
        event_id TEXT NOT NULL,
        seg INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        camera_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (event_id, seg, track_id)
      );
      CREATE INDEX IF NOT EXISTS person_vectors_model_ts ON person_vectors (model, ts);
    `);
  }

  /** Files the person vectors the event's segments carry (idempotent per segment and track). */
  public ingest(event: RecordedEvent): number {
    let added = 0;
    const insert = this.db.prepare('INSERT OR REPLACE INTO person_vectors (event_id, seg, track_id, camera_id, ts, model, vec) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (event.segments ?? []).forEach((segment, seg) => {
      const ts = (segment as { firstSeen?: number }).firstSeen ?? event.startTime;
      for (const p of personEmbeddings(segment)) {
        insert.run(event.id, seg, p.trackId, event.cameraId, ts, p.embeddingModel, toBlob(normalize(p.embedding)));
        added++;
      }
    });
    return added;
  }

  /** The vectors of one moment: one person (`trackId`) or everyone in it. */
  public vectors(eventId: string, seg: number, trackId?: number): PersonVector[] {
    const rows = (
      trackId === undefined
        ? this.db.prepare('SELECT track_id, model, vec FROM person_vectors WHERE event_id = ? AND seg = ?').all(eventId, seg)
        : this.db.prepare('SELECT track_id, model, vec FROM person_vectors WHERE event_id = ? AND seg = ? AND track_id = ?').all(eventId, seg, trackId)
    ) as unknown as { track_id: number; model: string; vec: Uint8Array }[];
    return rows.map((r) => ({ trackId: r.track_id, model: r.model, vec: fromBlob(r.vec) }));
  }

  /**
   * The moments whose people look most like any query vector, best first; one hit per moment (its best person).
   * Vectors of another model are never compared.
   */
  public search(queries: { model: string; vec: Float32Array }[], o: PersonSearch): PersonHit[] {
    const best = new Map<string, PersonHit>();
    const byModel = new Map<string, Float32Array[]>();
    for (const q of queries) byModel.set(q.model, [...(byModel.get(q.model) ?? []), normalize(q.vec)]);
    const select = this.db.prepare('SELECT event_id, seg, track_id, camera_id, ts, vec FROM person_vectors WHERE model = ? AND ts BETWEEN ? AND ?');
    for (const [model, vecs] of byModel) {
      for (const row of select.iterate(model, o.fromMs, o.toMs) as Iterable<Row>) {
        if (o.cameraIds?.has(row.camera_id) === false) continue;
        if (o.exclude?.eventId === row.event_id && o.exclude.seg === row.seg) continue;
        const vec = fromBlob(row.vec);
        let score = -1;
        for (const q of vecs) score = Math.max(score, dot(q, vec));
        if (score < o.minScore) continue;
        const key = `${row.event_id}/${row.seg}`;
        const seen = best.get(key);
        if (!seen || score > seen.score)
          best.set(key, { eventId: row.event_id, cameraId: row.camera_id, seg: row.seg, trackId: row.track_id, ts: row.ts, score: Math.round(score * 1000) / 1000 });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, Math.max(0, o.limit));
  }

  public hasModel(model: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM person_vectors WHERE model = ? LIMIT 1').get(model);
  }

  /** When the oldest searchable moment was: nothing before it can be found. */
  public oldest(): number | undefined {
    const row = this.db.prepare('SELECT MIN(ts) AS ts FROM person_vectors').get() as { ts: number | null } | undefined;
    return row?.ts ?? undefined;
  }

  public count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM person_vectors').get() as { n: number }).n);
  }

  public deleteEvents(ids: string[]): void {
    if (!ids.length) return;
    const del = this.db.prepare('DELETE FROM person_vectors WHERE event_id = ?');
    for (const id of ids) del.run(id);
  }

  /** The people of moments older than `ms` (the setting's days, favourites included): the events stay. */
  public deleteBefore(ms: number): number {
    return Number(this.db.prepare('DELETE FROM person_vectors WHERE ts < ?').run(ms).changes);
  }

  public clear(): number {
    return Number(this.db.prepare('DELETE FROM person_vectors').run().changes);
  }
}
