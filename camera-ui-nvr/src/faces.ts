// Face identities: enrolled people (several pictures + vectors each), faces seen in events that match
// nobody (grouped into clusters so the user can name a whole group at once) and faces the user chose
// to ignore. Vectors of different embedding models are never compared.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dot, fromBlob, normalize, toBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';

export interface FaceMatchResult {
  identity: string;
  score: number;
}

export interface FaceProfile {
  name: string;
  imageCount: number;
  createdAt: number;
  updatedAt: number;
  thumbnail?: Uint8Array;
}

export interface FaceImageData {
  id: string;
  jpeg: Uint8Array;
  confidence?: number;
}

export interface UnknownFace {
  id: string;
  cameraId: string;
  timestamp: number;
  embeddingModel: string;
  confidence?: number;
  clusterId?: string;
  embedding?: number[];
  thumbnail?: Uint8Array;
}

export interface IgnoredFace {
  id: string;
  cameraId: string;
  timestamp: number;
  embeddingModel: string;
  thumbnail?: Uint8Array;
}

/** Where an unknown face was seen, to relabel the event once it gets a name. */
export interface FaceSighting {
  eventId: string;
  seg: number;
  attr: number;
}

/** Cosine thresholds for a match (ArcFace/FaceNet 512-d, unit vectors). */
export const SENSITIVITY: Record<string, number> = { strict: 0.55, balanced: 0.45, relaxed: 0.38 };
/** Unknown faces at least this similar share a cluster. */
const CLUSTER_SIMILARITY = 0.5;
/** A new unknown face this similar to an ignored one is dropped. */
const IGNORE_SIMILARITY = 0.5;
/** Unknown faces kept at most (oldest go first). */
const MAX_UNKNOWN = 5000;

interface UnknownRow {
  id: string;
  camera_id: string;
  event_id: string;
  seg: number;
  attr: number;
  ts: number;
  model: string;
  vec: Uint8Array;
  confidence: number | null;
  cluster_id: string | null;
  ignored: number;
}

export class FaceStore {
  private readonly knownDir: string;
  private readonly unknownDir: string;

  constructor(
    private readonly db: DatabaseSync,
    dir: string,
  ) {
    this.knownDir = join(dir, 'known');
    this.unknownDir = join(dir, 'unknown');
    mkdirSync(this.knownDir, { recursive: true });
    mkdirSync(this.unknownDir, { recursive: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS faces (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS face_images (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        confidence REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS face_images_name ON face_images (name);
      CREATE TABLE IF NOT EXISTS unknown_faces (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seg INTEGER NOT NULL,
        attr INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        confidence REAL,
        cluster_id TEXT,
        ignored INTEGER NOT NULL DEFAULT 0,
        UNIQUE (event_id, seg, attr)
      );
      CREATE INDEX IF NOT EXISTS unknown_faces_ts ON unknown_faces (ignored, ts);
      CREATE TABLE IF NOT EXISTS face_sightings (
        event_id TEXT NOT NULL,
        seg INTEGER NOT NULL,
        attr INTEGER NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        confidence REAL,
        PRIMARY KEY (event_id, seg, attr)
      );
    `);
  }

  // ------------------------------------------------------------------ matching

  public match(embeddings: number[][], model: string, sensitivity = 'balanced'): (FaceMatchResult | null)[] {
    const threshold = SENSITIVITY[sensitivity] ?? SENSITIVITY.balanced;
    const known = this.knownVectors(model);
    return embeddings.map((embedding) => {
      if (!embedding?.length || !known.length) return null;
      const v = normalize(embedding);
      let best: FaceMatchResult | null = null;
      for (const k of known) {
        const score = dot(v, k.vec);
        if (score >= threshold && (!best || score > best.score)) best = { identity: k.name, score: Math.round(score * 1000) / 1000 };
      }
      return best;
    });
  }

  private knownVectors(model: string): { name: string; vec: Float32Array }[] {
    return (this.db.prepare('SELECT name, vec FROM face_images WHERE model = ?').all(model) as { name: string; vec: Uint8Array }[]).map((r) => ({
      name: r.name,
      vec: fromBlob(r.vec),
    }));
  }

  // --------------------------------------------------------------- known faces

  public enroll(name: string, model: string, embedding: number[] | Float32Array, jpeg: Uint8Array | undefined, confidence?: number): string {
    const now = Date.now();
    const clean = name.trim();
    if (!clean) throw new Error('Face name is empty');
    this.db
      .prepare('INSERT INTO faces (name, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at')
      .run(clean, now, now);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO face_images (id, name, model, vec, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean, model, toBlob(normalize(embedding)), confidence ?? null, now);
    if (jpeg?.length) writeFileSync(join(this.knownDir, `${id}.jpg`), jpeg);
    return id;
  }

  public listKnown(): FaceProfile[] {
    const rows = this.db
      .prepare(
        `SELECT f.name, f.created_at, f.updated_at, COUNT(i.id) AS n, MIN(i.id) AS first
         FROM faces f LEFT JOIN face_images i ON i.name = f.name GROUP BY f.name ORDER BY f.name COLLATE NOCASE`,
      )
      .all() as { name: string; created_at: number; updated_at: number; n: number; first: string | null }[];
    return rows.map((r) => ({
      name: r.name,
      imageCount: Number(r.n),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      thumbnail: this.firstPicture(r.name),
    }));
  }

  private firstPicture(name: string): Uint8Array | undefined {
    const ids = this.db.prepare('SELECT id FROM face_images WHERE name = ? ORDER BY created_at').all(name) as { id: string }[];
    for (const { id } of ids) {
      const jpeg = this.read(join(this.knownDir, `${id}.jpg`));
      if (jpeg) return jpeg;
    }
    return undefined;
  }

  public images(name: string): FaceImageData[] {
    return (this.db.prepare('SELECT id, confidence FROM face_images WHERE name = ? ORDER BY created_at').all(name) as { id: string; confidence: number | null }[])
      .map((r) => ({ id: r.id, jpeg: this.read(join(this.knownDir, `${r.id}.jpg`)) ?? new Uint8Array(), confidence: r.confidence ?? undefined }))
      .filter((i) => i.jpeg.length);
  }

  public removeImage(name: string, imageId: string): void {
    this.db.prepare('DELETE FROM face_images WHERE id = ? AND name = ?').run(imageId, name);
    rmSync(join(this.knownDir, `${imageId}.jpg`), { force: true });
  }

  public deleteFace(name: string): void {
    for (const { id } of this.db.prepare('SELECT id FROM face_images WHERE name = ?').all(name) as { id: string }[]) {
      rmSync(join(this.knownDir, `${id}.jpg`), { force: true });
    }
    this.db.prepare('DELETE FROM face_images WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM faces WHERE name = ?').run(name);
  }

  /** Known pictures and their models, for re-embedding after a model change. */
  public knownPictures(): { id: string; name: string; model: string; jpeg?: Uint8Array }[] {
    return (this.db.prepare('SELECT id, name, model FROM face_images').all() as { id: string; name: string; model: string }[]).map((r) => ({
      ...r,
      jpeg: this.read(join(this.knownDir, `${r.id}.jpg`)),
    }));
  }

  /** Adds a vector for another model to an enrolled picture (kept alongside the old one). */
  public addModelVector(sourceId: string, name: string, model: string, embedding: number[]): void {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO face_images (id, name, model, vec, confidence, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(id, name, model, toBlob(normalize(embedding)), Date.now());
    const jpeg = this.read(join(this.knownDir, `${sourceId}.jpg`));
    if (jpeg) writeFileSync(join(this.knownDir, `${id}.jpg`), jpeg);
  }

  public nameHasModel(name: string, model: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM face_images WHERE name = ? AND model = ? LIMIT 1').get(name, model);
  }

  public hasModel(model: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM face_images WHERE model = ? LIMIT 1').get(model);
  }

  // ------------------------------------------------------------------ sightings

  /** The vector of every face seen in an event, so a later correction can teach the person. */
  public recordSighting(s: FaceSighting, model: string, embedding: number[], confidence?: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO face_sightings (event_id, seg, attr, model, vec, confidence) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.eventId, s.seg, s.attr, model, toBlob(normalize(embedding)), confidence ?? null);
  }

  public sighting(s: FaceSighting): { model: string; vec: Float32Array; confidence?: number } | undefined {
    const row = this.db.prepare('SELECT model, vec, confidence FROM face_sightings WHERE event_id = ? AND seg = ? AND attr = ?').get(s.eventId, s.seg, s.attr) as
      { model: string; vec: Uint8Array; confidence: number | null } | undefined;
    return row ? { model: row.model, vec: fromBlob(row.vec), confidence: row.confidence ?? undefined } : undefined;
  }

  // ------------------------------------------------------------- unknown faces

  /** Records a face nobody matched. Returns false when it was ignored or already known. */
  public addUnknown(face: {
    cameraId: string;
    eventId: string;
    seg: number;
    attr: number;
    ts: number;
    model: string;
    embedding: number[];
    confidence?: number;
    jpeg?: Uint8Array;
  }): boolean {
    const vec = normalize(face.embedding);
    const existing = this.db.prepare('SELECT id FROM unknown_faces WHERE event_id = ? AND seg = ? AND attr = ?').get(face.eventId, face.seg, face.attr) as
      { id: string } | undefined;
    if (existing) {
      if (face.jpeg?.length && !existsSync(this.unknownPath(existing.id))) writeFileSync(this.unknownPath(existing.id), face.jpeg);
      return false;
    }
    const others = this.unknownVectors(face.model);
    if (others.some((o) => o.ignored && dot(vec, o.vec) >= IGNORE_SIMILARITY)) return false;

    // join the cluster of the most similar unknown face, or start one with it
    let cluster: string | null = null;
    let bestScore = CLUSTER_SIMILARITY;
    let bestOther: { id: string; cluster_id: string | null } | undefined;
    for (const o of others) {
      if (o.ignored) continue;
      const s = dot(vec, o.vec);
      if (s >= bestScore) {
        bestScore = s;
        bestOther = o;
      }
    }
    if (bestOther) {
      cluster = bestOther.cluster_id ?? randomUUID();
      if (!bestOther.cluster_id) this.db.prepare('UPDATE unknown_faces SET cluster_id = ? WHERE id = ?').run(cluster, bestOther.id);
    }

    const id = randomUUID();
    this.db
      .prepare('INSERT INTO unknown_faces (id, camera_id, event_id, seg, attr, ts, model, vec, confidence, cluster_id, ignored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(id, face.cameraId, face.eventId, face.seg, face.attr, face.ts, face.model, toBlob(vec), face.confidence ?? null, cluster);
    if (face.jpeg?.length) writeFileSync(this.unknownPath(id), face.jpeg);
    this.trimUnknown();
    return true;
  }

  private unknownVectors(model: string): { id: string; cluster_id: string | null; ignored: number; vec: Float32Array }[] {
    return (
      this.db.prepare('SELECT id, cluster_id, ignored, vec FROM unknown_faces WHERE model = ?').all(model) as {
        id: string;
        cluster_id: string | null;
        ignored: number;
        vec: Uint8Array;
      }[]
    ).map((r) => ({ ...r, vec: fromBlob(r.vec) }));
  }

  private trimUnknown(): void {
    const over = Number((this.db.prepare('SELECT COUNT(*) AS n FROM unknown_faces WHERE ignored = 0').get() as { n: number }).n) - MAX_UNKNOWN;
    if (over <= 0) return;
    const old = this.db.prepare('SELECT id FROM unknown_faces WHERE ignored = 0 ORDER BY ts LIMIT ?').all(over) as { id: string }[];
    this.deleteUnknown(old.map((r) => r.id));
  }

  public listUnknown(limit = 500, withPictures = true, withEmbedding = true): UnknownFace[] {
    const rows = this.db.prepare('SELECT * FROM unknown_faces WHERE ignored = 0 ORDER BY ts DESC LIMIT ?').all(limit) as unknown as UnknownRow[];
    return rows.map((r) => ({
      id: r.id,
      cameraId: r.camera_id,
      timestamp: r.ts,
      embeddingModel: r.model,
      confidence: r.confidence ?? undefined,
      clusterId: r.cluster_id ?? undefined,
      embedding: withEmbedding ? Array.from(fromBlob(r.vec)) : undefined,
      thumbnail: withPictures ? this.read(this.unknownPath(r.id)) : undefined,
    }));
  }

  public listIgnored(withPictures = true): IgnoredFace[] {
    const rows = this.db.prepare('SELECT * FROM unknown_faces WHERE ignored = 1 ORDER BY ts DESC').all() as unknown as UnknownRow[];
    return rows.map((r) => ({
      id: r.id,
      cameraId: r.camera_id,
      timestamp: r.ts,
      embeddingModel: r.model,
      thumbnail: withPictures ? this.read(this.unknownPath(r.id)) : undefined,
    }));
  }

  public thumbnails(ids: string[]): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const id of ids) {
      const jpeg = this.read(this.unknownPath(id));
      if (jpeg) out[id] = jpeg;
    }
    return out;
  }

  public deleteUnknown(ids: string[]): void {
    const del = this.db.prepare('DELETE FROM unknown_faces WHERE id = ?');
    for (const id of ids) {
      del.run(id);
      rmSync(this.unknownPath(id), { force: true });
    }
  }

  public idsWhere(where: 'all' | 'ungrouped' | { cluster: string }, ignored = 0): string[] {
    const sql =
      where === 'all'
        ? 'SELECT id FROM unknown_faces WHERE ignored = ?'
        : where === 'ungrouped'
          ? 'SELECT id FROM unknown_faces WHERE ignored = ? AND cluster_id IS NULL'
          : 'SELECT id FROM unknown_faces WHERE ignored = ? AND cluster_id = ?';
    const args: (string | number)[] = typeof where === 'object' ? [ignored, where.cluster] : [ignored];
    return (this.db.prepare(sql).all(...args) as { id: string }[]).map((r) => r.id);
  }

  public removeFromCluster(ids: string[]): void {
    const upd = this.db.prepare('UPDATE unknown_faces SET cluster_id = NULL WHERE id = ?');
    for (const id of ids) upd.run(id);
  }

  public ignore(ids: string[]): void {
    const upd = this.db.prepare('UPDATE unknown_faces SET ignored = 1, cluster_id = NULL WHERE id = ?');
    for (const id of ids) upd.run(id);
  }

  /** Moves unknown faces to a person: their vectors and pictures become enrolled pictures. */
  public enrollUnknown(name: string, ids: string[]): FaceSighting[] {
    const sightings: FaceSighting[] = [];
    for (const id of ids) {
      const row = this.db.prepare('SELECT * FROM unknown_faces WHERE id = ?').get(id) as unknown as UnknownRow | undefined;
      if (!row) continue;
      this.enroll(name, row.model, fromBlob(row.vec), this.read(this.unknownPath(id)), row.confidence ?? undefined);
      sightings.push({ eventId: row.event_id, seg: row.seg, attr: row.attr });
    }
    this.deleteUnknown(ids);
    return sightings;
  }

  /** Unknown faces that now match an enrolled person: removed from the list, returned for relabeling. */
  public rescan(sensitivity = 'balanced'): (FaceSighting & { identity: string })[] {
    const found: (FaceSighting & { identity: string })[] = [];
    const rows = this.db.prepare('SELECT * FROM unknown_faces WHERE ignored = 0').all() as unknown as UnknownRow[];
    const byModel = new Map<string, UnknownRow[]>();
    for (const r of rows) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
    for (const [model, list] of byModel) {
      const matches = this.match(
        list.map((r) => Array.from(fromBlob(r.vec))),
        model,
        sensitivity,
      );
      matches.forEach((m, i) => {
        if (!m) return;
        const r = list[i];
        found.push({ eventId: r.event_id, seg: r.seg, attr: r.attr, identity: m.identity });
      });
    }
    return found;
  }

  public deleteUnknownAt(sightings: FaceSighting[]): void {
    const ids = sightings
      .map((s) => this.db.prepare('SELECT id FROM unknown_faces WHERE event_id = ? AND seg = ? AND attr = ?').get(s.eventId, s.seg, s.attr) as { id: string } | undefined)
      .filter((r): r is { id: string } => !!r)
      .map((r) => r.id);
    this.deleteUnknown(ids);
  }

  public deleteForEvents(eventIds: string[]): void {
    for (const eventId of eventIds) {
      this.db.prepare('DELETE FROM face_sightings WHERE event_id = ?').run(eventId);
      const ids = (this.db.prepare('SELECT id FROM unknown_faces WHERE event_id = ? AND ignored = 0').all(eventId) as { id: string }[]).map((r) => r.id);
      this.deleteUnknown(ids);
    }
  }

  private unknownPath(id: string): string {
    return join(this.unknownDir, `${id.replace(/[^\w-]/g, '_')}.jpg`);
  }

  private read(path: string): Uint8Array | undefined {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return undefined;
    }
  }
}
