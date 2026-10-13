// People who look alike ("похожие люди"): the server's person re-ID vectors (one per person track of a segment,
// averaged over up to three tight crops) are filed here and never in the event JSON, and compared by cosine within a
// time window. Re-ID describes clothes and build, not who someone is: it finds the same person the same day.
// The vectors of a model are held by a compact index (vector-index.ts: signs only, 32 bytes a 256-d vector), which
// picks the candidates of the window and the cameras; the table scores them exactly. Reading every row of the window
// for each search took 3.5-6 s over 90 days of 400 000 vectors (spec/bench-vectors.ts).

import { loadIndexes, VectorIndex } from './vector-index.js';
import { dot, fromBlob, normalize, toBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';
import type { PersonRouteVisit, RecordedEvent } from './types.js';

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
  /** reached by a route's hops: `score` is the least cosine of its links (index.ts routeHops) */
  hop?: true;
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

/** The vectors a search scores exactly for each query vector, at least: every one of its window up to this many. */
const CANDIDATES = 2000;

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

/**
 * The route of a person: the moments that look like them in time order, one stay on a camera while its moments are less
 * than `gapMs` apart and no other camera saw them in between. The stay of the moment asked from shows that moment; the
 * others their best match, a moment alike to the asked one before a hop. Re-ID describes clothes and build: two people
 * dressed alike on one camera read as one stay.
 */
export function routeOf(origin: PersonHit, hits: PersonHit[], gapMs: number): PersonRouteVisit[] {
  const moments = [{ ...origin, origin: true }, ...hits.map((hit) => ({ ...hit, origin: false }))].sort((a, b) => a.ts - b.ts);
  const visits: PersonRouteVisit[] = [];
  const show = (visit: PersonRouteVisit, moment: (typeof moments)[number]) => {
    Object.assign(visit, { eventId: moment.eventId, segment: moment.seg, trackId: moment.trackId, score: moment.score });
    if (moment.origin) visit.origin = true;
    if (moment.hop && !moment.origin) visit.hop = true;
    else delete visit.hop;
  };
  for (const moment of moments) {
    const last = visits.at(-1);
    if (last?.cameraId === moment.cameraId && moment.ts - last.to <= gapMs) {
      last.to = Math.max(last.to, moment.ts);
      // the scores of hops and of matches are of different things: a match is shown before any hop
      const better = !!last.hop === !!moment.hop ? moment.score > last.score : !moment.hop;
      if (moment.origin || (!last.origin && better)) show(last, moment);
      continue;
    }
    const visit = { cameraId: moment.cameraId, from: moment.ts, to: moment.ts } as PersonRouteVisit;
    show(visit, moment);
    visits.push(visit);
  }
  return visits;
}

export class PersonIndex {
  /** model → its vectors' index; read from the table in the background (warm), then kept in step */
  private indexes = new Map<string, VectorIndex>();
  private warming?: Promise<void>;
  private warmed = false;

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
        const vec = normalize(p.embedding);
        const index = this.indexFor(p.embeddingModel, vec.length);
        // the row replaced gets a new rowid: the old one leaves the index
        const old = index ? this.rowidOf(event.id, seg, p.trackId) : undefined;
        const { lastInsertRowid } = insert.run(event.id, seg, p.trackId, event.cameraId, ts, p.embeddingModel, toBlob(vec));
        if (index) {
          if (old !== undefined) index.remove(old);
          index.add(Number(lastInsertRowid), vec, ts, event.cameraId);
        }
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
  public async search(queries: { model: string; vec: Float32Array }[], o: PersonSearch): Promise<PersonHit[]> {
    await this.warm();
    const best = new Map<string, PersonHit>();
    const byModel = new Map<string, Float32Array[]>();
    for (const q of queries) byModel.set(q.model, [...(byModel.get(q.model) ?? []), normalize(q.vec)]);
    const select = this.db.prepare('SELECT event_id, seg, track_id, camera_id, ts, vec FROM person_vectors WHERE rowid = ?');
    const k = Math.max(CANDIDATES, o.limit * 4);
    for (const [model, vecs] of byModel) {
      const index = this.indexes.get(model);
      if (!index) continue;
      const ids = new Set<number>();
      for (const q of vecs) for (const id of await index.candidates(q, k, { fromMs: o.fromMs, toMs: o.toMs, cameraIds: o.cameraIds })) ids.add(id);
      for (const id of ids) {
        const row = select.get(id) as Row | undefined;
        if (!row) continue;
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

  /**
   * Reads the vectors into their indexes in the background, once; the searches wait for it. A failed read is tried
   * again by the next search.
   */
  public warm(): Promise<void> {
    this.warming ??= loadIndexes(this.db, 'person_vectors', this.indexes).then(
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

  private rowidOf(eventId: string, seg: number, trackId: number): number | undefined {
    const row = this.db.prepare('SELECT rowid AS id FROM person_vectors WHERE event_id = ? AND seg = ? AND track_id = ?').get(eventId, seg, trackId) as
      | { id: number | bigint }
      | undefined;
    return row ? Number(row.id) : undefined;
  }

  /** The segments of an event with people to find, in order. */
  public segmentsOf(eventId: string): number[] {
    return (this.db.prepare('SELECT DISTINCT seg FROM person_vectors WHERE event_id = ? ORDER BY seg').all(eventId) as { seg: number }[]).map((r) => r.seg);
  }

  /** The cameras that filed people in a while: a camera that filed none cannot be on a route. */
  public camerasBetween(fromMs: number, toMs: number): string[] {
    return (this.db.prepare('SELECT DISTINCT camera_id FROM person_vectors WHERE ts BETWEEN ? AND ?').all(fromMs, toMs) as { camera_id: string }[]).map(
      (r) => r.camera_id,
    );
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
    const rows = this.indexes.size ? this.db.prepare('SELECT rowid AS id, model FROM person_vectors WHERE event_id = ?') : undefined;
    for (const id of ids) {
      for (const row of (rows?.all(id) ?? []) as { id: number | bigint; model: string }[]) this.indexes.get(row.model)?.remove(Number(row.id));
      del.run(id);
    }
  }

  /** The people of moments older than `ms` (the setting's days, favourites included): the events stay. */
  public deleteBefore(ms: number): number {
    for (const index of this.indexes.values()) index.removeBefore(ms);
    return Number(this.db.prepare('DELETE FROM person_vectors WHERE ts < ?').run(ms).changes);
  }

  public clear(): number {
    this.indexes.clear();
    return Number(this.db.prepare('DELETE FROM person_vectors').run().changes);
  }
}
