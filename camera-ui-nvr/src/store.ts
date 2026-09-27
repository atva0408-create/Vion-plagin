import { DatabaseSync } from 'node:sqlite';

import type { VideoCodec } from './media/ts-demux.js';
import type { RecordedEvent } from './types.js';

export interface SegmentRow {
  id: number;
  camera_id: string;
  role: string;
  start_us: number;
  end_us: number;
  path: string;
  bytes: number;
  codec: VideoCodec;
  codec_string: string;
  width: number;
  height: number;
  video_pid: number;
  /** JSON array of [byteOffset, tsUs] for every keyframe. */
  keyframes: string;
}

export interface Keyframe {
  offset: number;
  tsUs: number;
}

export interface EventRow {
  id: string;
  camera_id: string;
  start_ms: number;
  end_ms: number | null;
  state: string;
  data: string;
  favorite: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        role TEXT NOT NULL,
        start_us INTEGER NOT NULL,
        end_us INTEGER NOT NULL,
        path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        codec TEXT NOT NULL,
        codec_string TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        video_pid INTEGER NOT NULL,
        keyframes TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS segments_camera_time ON segments (camera_id, role, start_us);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS events_time ON events (start_ms);
      CREATE INDEX IF NOT EXISTS events_camera_time ON events (camera_id, start_ms);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_trace (event_id TEXT NOT NULL, t_ms INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_trace_event ON event_trace (event_id, t_ms);
    `);
  }

  public close(): void {
    this.db.close();
  }

  /** The database, shared with the semantic index and the face store. */
  public get sql(): DatabaseSync {
    return this.db;
  }

  // --- meta ---
  public meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  public setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // --- segments ---
  public addSegment(row: Omit<SegmentRow, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO segments (camera_id, role, start_us, end_us, path, bytes, codec, codec_string, width, height, video_pid, keyframes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.camera_id, row.role, row.start_us, row.end_us, row.path, row.bytes, row.codec, row.codec_string, row.width, row.height, row.video_pid, row.keyframes);
    return Number(res.lastInsertRowid);
  }

  public updateSegment(id: number, endUs: number, bytes: number, keyframes: string): void {
    this.db.prepare('UPDATE segments SET end_us = ?, bytes = ?, keyframes = ? WHERE id = ?').run(endUs, bytes, keyframes, id);
  }

  public segments(cameraId: string, role: string, startUs: number, endUs: number): SegmentRow[] {
    return this.db
      .prepare('SELECT * FROM segments WHERE camera_id = ? AND role = ? AND end_us >= ? AND start_us <= ? ORDER BY start_us')
      .all(cameraId, role, startUs, endUs) as unknown as SegmentRow[];
  }

  /** The segment containing `tsUs`, else the first one starting after it. */
  public segmentAt(cameraId: string, role: string, tsUs: number): SegmentRow | undefined {
    return (this.db.prepare('SELECT * FROM segments WHERE camera_id = ? AND role = ? AND end_us >= ? ORDER BY start_us LIMIT 1').get(cameraId, role, tsUs) ??
      undefined) as SegmentRow | undefined;
  }

  public nextSegment(cameraId: string, role: string, afterId: number, afterStartUs: number): SegmentRow | undefined {
    return (this.db
      .prepare('SELECT * FROM segments WHERE camera_id = ? AND role = ? AND (start_us > ? OR (start_us = ? AND id > ?)) ORDER BY start_us, id LIMIT 1')
      .get(cameraId, role, afterStartUs, afterStartUs, afterId) ?? undefined) as SegmentRow | undefined;
  }

  public segment(id: number): SegmentRow | undefined {
    return (this.db.prepare('SELECT * FROM segments WHERE id = ?').get(id) ?? undefined) as SegmentRow | undefined;
  }

  public oldestSegments(limit: number): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments ORDER BY start_us LIMIT ?').all(limit) as unknown as SegmentRow[];
  }

  public segmentsBefore(cutoffUs: number, limit: number): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments WHERE end_us < ? ORDER BY start_us LIMIT ?').all(cutoffUs, limit) as unknown as SegmentRow[];
  }

  public deleteSegment(id: number): void {
    this.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
  }

  public cameraStats(): { camera_id: string; bytes: number; count: number; oldest: number; newest: number }[] {
    return this.db
      .prepare('SELECT camera_id, SUM(bytes) AS bytes, COUNT(*) AS count, MIN(start_us) AS oldest, MAX(end_us) AS newest FROM segments GROUP BY camera_id')
      .all() as unknown as { camera_id: string; bytes: number; count: number; oldest: number; newest: number }[];
  }

  public totalBytes(): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM segments').get() as { b: number }).b);
  }

  public recordingDays(cameraId: string, fromUs: number, toUs: number): number[] {
    return (
      this.db.prepare('SELECT start_us, end_us FROM segments WHERE camera_id = ? AND end_us >= ? AND start_us < ?').all(cameraId, fromUs, toUs) as {
        start_us: number;
        end_us: number;
      }[]
    ).flatMap((r) => [r.start_us, r.end_us]);
  }

  // --- events ---
  public upsertEvent(event: RecordedEvent, favorite?: boolean): void {
    const existing = this.db.prepare('SELECT favorite FROM events WHERE id = ?').get(event.id) as { favorite: number } | undefined;
    this.db
      .prepare('INSERT OR REPLACE INTO events (id, camera_id, start_ms, end_ms, state, data, favorite) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        event.id,
        event.cameraId,
        event.startTime,
        event.endTime ?? null,
        event.state,
        JSON.stringify(event),
        favorite === undefined ? (existing?.favorite ?? 0) : favorite ? 1 : 0,
      );
  }

  public event(id: string): EventRow | undefined {
    return (this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) ?? undefined) as EventRow | undefined;
  }

  public events(opts: {
    cameraIds?: string[];
    startMs?: number;
    endMs?: number;
    startedSinceMs?: number;
    before?: number;
    favoritesOnly?: boolean;
    state?: string;
    limit: number;
  }): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.cameraIds?.length) {
      where.push(`camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    if (opts.startMs !== undefined) {
      where.push('COALESCE(end_ms, start_ms) >= ?');
      args.push(opts.startMs);
    }
    if (opts.endMs !== undefined) {
      where.push('start_ms <= ?');
      args.push(opts.endMs);
    }
    if (opts.startedSinceMs !== undefined) {
      where.push('start_ms >= ?');
      args.push(opts.startedSinceMs);
    }
    if (opts.before !== undefined) {
      where.push('start_ms < ?');
      args.push(opts.before);
    }
    if (opts.favoritesOnly) where.push('favorite = 1');
    if (opts.state) {
      where.push('state = ?');
      args.push(opts.state);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_ms DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, opts.limit) as unknown as EventRow[];
  }

  public setFavorite(id: string, favorite: boolean): void {
    this.db.prepare('UPDATE events SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  }

  public deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM event_trace WHERE event_id = ?').run(id);
  }

  // --- detection trace ---
  public addTrace(eventId: string, ticks: { tMs: number }[]): void {
    const insert = this.db.prepare('INSERT INTO event_trace (event_id, t_ms, data) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const tick of ticks) insert.run(eventId, Math.round(Number(tick.tMs) || 0), JSON.stringify(tick));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public traceCount(eventId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM event_trace WHERE event_id = ?').get(eventId) as { n: number }).n);
  }

  /** Ticks in time order (ties: arrival order). */
  public trace(eventId: string, offset: number, limit: number): string[] {
    return (
      this.db.prepare('SELECT data FROM event_trace WHERE event_id = ? ORDER BY t_ms, rowid LIMIT ? OFFSET ?').all(eventId, limit, offset) as { data: string }[]
    ).map((r) => r.data);
  }

  /** Number of ticks before `tMs`: the offset of the first tick at or after it. */
  public traceOffset(eventId: string, tMs: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM event_trace WHERE event_id = ? AND t_ms < ?').get(eventId, tMs) as { n: number }).n);
  }

  public eventsBefore(cutoffMs: number, limit: number): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE start_ms < ? AND favorite = 0 ORDER BY start_ms LIMIT ?').all(cutoffMs, limit) as unknown as EventRow[];
  }

  /** Events still "active" from a previous run (crash, restart): end them at their last update. */
  public closeStaleActive(): number {
    const res = this.db
      .prepare(
        `UPDATE events SET state = 'ended',
           end_ms = COALESCE(json_extract(data, '$.lastUpdate'), start_ms),
           data = json_set(data, '$.state', 'ended', '$.endTime', COALESCE(json_extract(data, '$.lastUpdate'), start_ms))
         WHERE state = 'active'`,
      )
      .run();
    return Number(res.changes);
  }

  public activeEvents(cameraId: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE camera_id = ? AND state = 'active'").all(cameraId) as unknown as EventRow[];
  }
}

export function parseKeyframes(json: string): Keyframe[] {
  return (JSON.parse(json) as [number, number][]).map(([offset, tsUs]) => ({ offset, tsUs }));
}
