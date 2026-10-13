// A compact in-memory index of the vectors of one model, for the searches over the archive. Each vector is kept as
// int8 with its scale (one byte a dimension: 512 bytes for a 512-d CLIP vector instead of 2 KB), with its row in
// SQLite, its time and its camera; a search scores every vector the filter lets through from these bytes (within a few
// thousandths of the exact cosine) and the caller scores the best k exactly from the table. Measured on the recorder's
// own code (spec/bench-vectors.ts): 400 000 CLIP vectors held 2.3 GB as Float32Arrays and took 10 s to load; the people
// search read every row of 90 days for each query (3.5-6 s). The signs alone (64 bytes) were tried first and lost the
// best matches of a search by description: text and picture agree by 0.15-0.38 in CLIP, and among 300 000 vectors the
// signs kept 34 of the 50 best in 2000 candidates (spec/vector-index.spec.ts keeps that case).

import { fromBlob } from './vectors.js';

import type { DatabaseSync } from 'node:sqlite';

/** The rows a load reads at a time, giving way to the recorder in between. */
const PORTION = 5000;
/** The vectors a search scores before it gives way to the recorder (a few milliseconds of work). */
const SCORE_CHUNK = 8192;
/** The score histogram's bins over -1..1 for the cut of the best k: no sort of a million numbers. */
const BINS = 65536;

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
  private values: Int8Array;
  private scales: Float32Array;
  private rowids: Float64Array;
  private times: Float64Array;
  private cameras: Uint16Array;
  private alive: Uint8Array;
  private size = 0;
  private dead = 0;
  /** searches going on: the slots must not move under them, a packing waits for the last one */
  private searching = 0;
  private packDue = false;
  private readonly slotOf = new Map<number, number>();
  private readonly cameraIndex = new Map<string, number>();
  private readonly cameraNames: string[] = [];

  constructor(
    public readonly dim: number,
    capacity = 1024,
  ) {
    this.values = new Int8Array(capacity * dim);
    this.scales = new Float32Array(capacity);
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
    return this.values.byteLength + this.scales.byteLength + this.rowids.byteLength + this.times.byteLength + this.cameras.byteLength + this.alive.byteLength;
  }

  /** Adds the vector of a row (a row already held is replaced). */
  public add(rowid: number, vec: Float32Array, ts: number, cameraId: string): void {
    this.remove(rowid);
    if (this.size === this.rowids.length) this.grow();
    const slot = this.size++;
    const base = slot * this.dim;
    const n = Math.min(this.dim, vec.length);
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(vec[i]));
    const scale = max / 127;
    for (let i = 0; i < this.dim; i++) this.values[base + i] = i < n && scale > 0 ? Math.round(vec[i] / scale) : 0;
    this.scales[slot] = scale;
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
    if (this.dead > 1024 && this.dead * 4 > this.size) this.pack();
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
    if (this.dead * 4 > this.size) this.pack();
    return removed;
  }

  /**
   * The rows of the `k` vectors nearest the query (by their int8 copies), among those the filter lets through; every
   * row the filter lets through when there are no more than `k` of them. Nearest first is not promised: the caller
   * scores them exactly. Gives way to the recorder every SCORE_CHUNK vectors; rows added meanwhile are not looked at,
   * rows removed meanwhile may be among the answer (the table no longer has them).
   */
  public async candidates(query: Float32Array, k: number, filter: IndexFilter = {}): Promise<number[]> {
    this.searching++;
    try {
      const cams = filter.cameraIds ? new Set([...filter.cameraIds].map((id) => this.cameraIndex.get(id)).filter((i) => i !== undefined)) : undefined;
      const from = filter.fromMs ?? -Infinity;
      const to = filter.toMs ?? Infinity;
      const size = this.size;
      const n = Math.min(this.dim, query.length);
      const q = query.subarray(0, n);
      // a bin of the score a slot passing the filter, -1 for the others
      const bins = new Int32Array(size);
      const histogram = new Uint32Array(BINS);
      let passing = 0;
      for (let start = 0; start < size; start += SCORE_CHUNK) {
        if (start) await new Promise((resolve) => setImmediate(resolve));
        // read again after giving way: a vector added meanwhile may have grown them into new arrays
        const { values, scales, times, cameras, alive } = this;
        const end = Math.min(size, start + SCORE_CHUNK);
        for (let slot = start; slot < end; slot++) {
          const t = times[slot];
          if (!alive[slot] || t < from || t > to || (cams && !cams.has(cameras[slot]))) {
            bins[slot] = -1;
            continue;
          }
          const base = slot * this.dim;
          let s = 0;
          for (let i = 0; i < n; i++) s += values[base + i] * q[i];
          const score = s * scales[slot];
          const bin = Math.max(0, Math.min(BINS - 1, Math.floor((score + 1) * (BINS / 2))));
          bins[slot] = bin;
          histogram[bin]++;
          passing++;
        }
      }
      const rowids = this.rowids;
      const out: number[] = [];
      if (passing <= k) {
        for (let slot = 0; slot < size; slot++) if (bins[slot] >= 0) out.push(rowids[slot]);
        return out;
      }
      // from the best bin down until k are taken: those above the cut all, from the cut itself as many as are left
      let cut = BINS - 1;
      let above = 0;
      while (above + histogram[cut] < k) above += histogram[cut--];
      let atCut = k - above;
      for (let slot = 0; slot < size; slot++) {
        const bin = bins[slot];
        if (bin > cut) out.push(rowids[slot]);
        else if (bin === cut && atCut > 0) {
          out.push(rowids[slot]);
          atCut--;
        }
      }
      return out;
    } finally {
      this.searching--;
      if (!this.searching && this.packDue) this.pack();
    }
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
    const values = new Int8Array(capacity * this.dim);
    values.set(this.values);
    this.values = values;
    for (const key of ['scales'] as const) {
      const next = new Float32Array(capacity);
      next.set(this[key]);
      this[key] = next;
    }
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

  /** Moves the live slots together; not while a search scores them by their place, then after it. */
  private pack(): void {
    if (this.searching) {
      this.packDue = true;
      return;
    }
    this.packDue = false;
    let to = 0;
    for (let from = 0; from < this.size; from++) {
      if (!this.alive[from]) continue;
      if (to !== from) {
        this.values.copyWithin(to * this.dim, from * this.dim, (from + 1) * this.dim);
        this.scales[to] = this.scales[from];
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
