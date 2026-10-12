// A compact in-memory index of the vectors of one model, for the searches over the archive. Each vector is kept as its
// signs only (one bit a dimension: 64 bytes for a 512-d CLIP vector instead of 2 KB), with its row in SQLite, its time
// and its camera; a search takes the vectors whose signs agree most with the query's (Hamming distance) and the caller
// scores those exactly from the table. Measured on the recorder's own code (spec/bench-vectors.ts): 400 000 CLIP
// vectors held 2.3 GB as Float32Arrays and took 10 s to load; the people search read every row of 90 days for each
// query (3.5-6 s). With no more vectors than the candidates asked for, every vector is a candidate: exact as before.

import { fromBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';

/** The rows a load reads at a time, giving way to the recorder in between. */
const PORTION = 5000;

/** Number of set bits of a 32-bit word. */
function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export interface IndexFilter {
  fromMs?: number;
  toMs?: number;
  cameraIds?: Set<string>;
}

/**
 * Fills `indexes` (model → index) with the vectors of a table, a portion of rows at a time in rowid order, giving way
 * between portions: 400 000 vectors took 8 s to read, and the recorder must not stop for that. The callers keep the
 * indexes in step meanwhile: a row written during the load has a higher rowid and is read by a later portion (added
 * twice it is replaced), a row deleted is no longer in the table when a search scores its candidates.
 */
export async function loadIndexes(db: DatabaseSync, table: 'clip_vectors' | 'person_vectors', indexes: Map<string, VectorIndex>): Promise<void> {
  const select = db.prepare(`SELECT rowid AS id, model, camera_id, ts, vec FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  let after = 0;
  for (;;) {
    const rows = select.all(after, PORTION) as { id: number | bigint; model: string; camera_id: string; ts: number; vec: Uint8Array }[];
    for (const r of rows) {
      const vec = fromBlob(r.vec);
      let index = indexes.get(r.model);
      if (!index) {
        index = new VectorIndex(vec.length);
        indexes.set(r.model, index);
      }
      index.add(Number(r.id), vec, r.ts, r.camera_id);
    }
    if (rows.length < PORTION) return;
    after = Number(rows[rows.length - 1].id);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export class VectorIndex {
  private readonly words: number;
  private codes: Uint32Array;
  private rowids: Float64Array;
  private times: Float64Array;
  private cameras: Uint16Array;
  private alive: Uint8Array;
  private size = 0;
  private dead = 0;
  private readonly slotOf = new Map<number, number>();
  private readonly cameraIndex = new Map<string, number>();
  private readonly cameraNames: string[] = [];

  constructor(public readonly dim: number, capacity = 1024) {
    this.words = Math.ceil(dim / 32);
    this.codes = new Uint32Array(capacity * this.words);
    this.rowids = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.cameras = new Uint16Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  /** Vectors held. */
  public get count(): number {
    return this.size - this.dead;
  }

  /** Slots in use, the removed ones not packed yet among them. */
  public get slots(): number {
    return this.size;
  }

  /** Bytes the index holds in typed arrays (the row map and camera names aside). */
  public get bytes(): number {
    return this.codes.byteLength + this.rowids.byteLength + this.times.byteLength + this.cameras.byteLength + this.alive.byteLength;
  }

  /** Adds the vector of a row (a row already held is replaced). */
  public add(rowid: number, vec: Float32Array, ts: number, cameraId: string): void {
    this.remove(rowid);
    if (this.size === this.rowids.length) this.grow();
    const slot = this.size++;
    const base = slot * this.words;
    for (let w = 0; w < this.words; w++) this.codes[base + w] = 0;
    for (let i = 0; i < this.dim && i < vec.length; i++) if (vec[i] > 0) this.codes[base + (i >>> 5)] |= 1 << (i & 31);
    this.rowids[slot] = rowid;
    this.times[slot] = ts;
    this.cameras[slot] = this.camera(cameraId);
    this.alive[slot] = 1;
    this.slotOf.set(rowid, slot);
  }

  public remove(rowid: number): void {
    const slot = this.slotOf.get(rowid);
    if (slot === undefined) return;
    this.slotOf.delete(rowid);
    this.alive[slot] = 0;
    this.dead++;
    // a quarter of the slots dead: packed again, the arrays do not keep growing with deleted rows
    if (this.dead > 1024 && this.dead * 4 > this.size) this.compact();
  }

  /** Removes every row older than `ms`; the rows removed. */
  public removeBefore(ms: number): number {
    let removed = 0;
    for (let slot = 0; slot < this.size; slot++) {
      if (!this.alive[slot] || this.times[slot] >= ms) continue;
      this.alive[slot] = 0;
      this.slotOf.delete(this.rowids[slot]);
      this.dead++;
      removed++;
    }
    if (this.dead * 4 > this.size) this.compact();
    return removed;
  }

  /**
   * The rows of at most `k` vectors whose signs agree most with the query's, among those the filter lets through
   * (nearest first is not promised: the caller scores them exactly). Every row the filter lets through when there are
   * no more than `k` of them.
   */
  public candidates(query: Float32Array, k: number, filter: IndexFilter = {}): number[] {
    const q = new Uint32Array(this.words);
    for (let i = 0; i < this.dim && i < query.length; i++) if (query[i] > 0) q[i >>> 5] |= 1 << (i & 31);
    const cams = filter.cameraIds ? new Set([...filter.cameraIds].map((id) => this.cameraIndex.get(id)).filter((i) => i !== undefined)) : undefined;
    const from = filter.fromMs ?? -Infinity;
    const to = filter.toMs ?? Infinity;
    // one pass for the distances, a histogram of them (0..dim) for the cut: no sort of a million numbers
    const dist = new Uint16Array(this.size);
    const histogram = new Uint32Array(this.dim + 2);
    const NONE = this.dim + 1;
    let passing = 0;
    for (let slot = 0; slot < this.size; slot++) {
      const t = this.times[slot];
      if (!this.alive[slot] || t < from || t > to || (cams && !cams.has(this.cameras[slot]))) {
        dist[slot] = NONE;
        continue;
      }
      let d = 0;
      const base = slot * this.words;
      for (let w = 0; w < this.words; w++) d += popcount((this.codes[base + w] ^ q[w]) >>> 0);
      dist[slot] = d;
      histogram[d]++;
      passing++;
    }
    const out: number[] = [];
    if (passing <= k) {
      for (let slot = 0; slot < this.size; slot++) if (dist[slot] !== NONE) out.push(this.rowids[slot]);
      return out;
    }
    let cut = 0;
    let below = 0;
    while (below + histogram[cut] < k) below += histogram[cut++];
    // the distances under the cut all, then from the cut itself as many as are left
    let atCut = k - below;
    for (let slot = 0; slot < this.size; slot++) {
      const d = dist[slot];
      if (d < cut) out.push(this.rowids[slot]);
      else if (d === cut && atCut > 0) {
        out.push(this.rowids[slot]);
        atCut--;
      }
    }
    return out;
  }

  private camera(id: string): number {
    let index = this.cameraIndex.get(id);
    if (index === undefined) {
      index = this.cameraNames.length;
      this.cameraNames.push(id);
      this.cameraIndex.set(id, index);
    }
    return index;
  }

  private grow(): void {
    const capacity = Math.max(1024, this.rowids.length * 2);
    const codes = new Uint32Array(capacity * this.words);
    codes.set(this.codes);
    this.codes = codes;
    for (const key of ['rowids', 'times'] as const) {
      const next = new Float64Array(capacity);
      next.set(this[key]);
      this[key] = next;
    }
    const cameras = new Uint16Array(capacity);
    cameras.set(this.cameras);
    this.cameras = cameras;
    const alive = new Uint8Array(capacity);
    alive.set(this.alive);
    this.alive = alive;
  }

  private compact(): void {
    let to = 0;
    for (let from = 0; from < this.size; from++) {
      if (!this.alive[from]) continue;
      if (to !== from) {
        this.codes.copyWithin(to * this.words, from * this.words, (from + 1) * this.words);
        this.rowids[to] = this.rowids[from];
        this.times[to] = this.times[from];
        this.cameras[to] = this.cameras[from];
        this.alive[to] = 1;
        this.slotOf.set(this.rowids[to], to);
      }
      to++;
    }
    this.alive.fill(0, to, this.size);
    this.size = to;
    this.dead = 0;
  }
}
