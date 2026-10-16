import { existsSync } from 'node:fs';
import { join, posix, relative, sep, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { StatementSync } from 'node:sqlite';
import type { VideoCodec } from './media/ts-demux.js';
import type { RecordedEvent, StoredCrossing } from './types.js';

/**
 * An event still going on reaches now: one running since before a range was missing from it ("today" did not show the
 * child at the computer since 23:30), the range is about when the event was, not when it began. Events lost by the
 * server are ended within 10 minutes (closeStaleActive), so this does not keep a dead one in every range.
 */
const stillOn = (table = '') => `(${table}end_ms IS NULL AND ${table}state = 'active')`;

export interface SegmentRow {
  id: number;
  camera_id: string;
  role: string;
  start_us: number;
  end_us: number;
  /**
   * As stored, not a place to open: `<camera>/<day>/<file>` below the recordings directory, or, in rows of older
   * versions, the absolute path the file was written at. `Store.file()` says where the file is now.
   */
  path: string;
  bytes: number;
  codec: VideoCodec;
  codec_string: string;
  width: number;
  height: number;
  video_pid: number;
  /** PID of the recorded AAC stream, -1 for a segment without sound (also every segment recorded before sound existed). */
  audio_pid: number;
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

/** What the event statistics need of an event, read from its stored JSON by the database (`Store.eventDigests`). */
export interface EventDigest {
  id: string;
  camera_id: string;
  start_ms: number;
  end_ms: number | null;
  /** JSON of the event's `types`. */
  types: string | null;
  /** How many segments it has. */
  segments: number | null;
}

export interface EpisodeRow {
  id: string;
  start_ms: number;
  end_ms: number;
  favorite: number;
  /** JSON of the stored episode (episodes.ts `StoredEpisode`). */
  data: string;
}

export class Store {
  private readonly db: DatabaseSync;
  private lastSegment: StatementSync | undefined;
  private anySegment: StatementSync | undefined;

  /**
   * `recordingsDir`: the directory the segment files are kept in. With it new rows name their file below it and
   * `file()` finds a file wherever the archive is now; without it (a store on its own) a path is kept and given as it is.
   */
  constructor(
    path: string,
    private readonly recordingsDir?: string,
  ) {
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
      -- the span of each file in the index itself: «has a recording» in a pause of a camera's recording looks at every
      -- earlier file, and read from the rows (each with its keyframes) on a cold HDD it held the recorder a minute
      CREATE INDEX IF NOT EXISTS segments_camera_span ON segments (camera_id, role, start_us, end_us);
      CREATE INDEX IF NOT EXISTS segments_time ON segments (start_us);
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
      -- the events of a camera by when they ended, for the traces cleared behind the oldest video (pruneTracesBefore)
      CREATE INDEX IF NOT EXISTS events_camera_end ON events (camera_id, COALESCE(end_ms, start_ms));
      -- the events still going on, looked for every minute (closeStaleActive): a few rows, not a read of every event
      CREATE INDEX IF NOT EXISTS events_active ON events (state) WHERE state = 'active';
      -- the ended events newest first with their ids, from the index alone: the search index looks for those without a
      -- vector every two minutes (SemanticIndex.unindexed), and the rows of the events are big
      CREATE INDEX IF NOT EXISTS events_state_time ON events (state, start_ms, id);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_trace (event_id TEXT NOT NULL, t_ms INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_trace_event ON event_trace (event_id, t_ms);
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episodes_time ON episodes (start_ms);
      CREATE TABLE IF NOT EXISTS episode_members (
        episode_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (episode_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS episode_members_event ON episode_members (event_id);
      CREATE TABLE IF NOT EXISTS crossings (
        camera_id TEXT NOT NULL,
        line TEXT NOT NULL,
        direction TEXT NOT NULL,
        way TEXT,
        label TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crossings_time ON crossings (at_ms);
      CREATE INDEX IF NOT EXISTS crossings_camera_time ON crossings (camera_id, at_ms);
    `);
    // databases created before recorded sound have no such column
    const columns = this.db.prepare('PRAGMA table_info(segments)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'audio_pid')) this.db.exec('ALTER TABLE segments ADD COLUMN audio_pid INTEGER NOT NULL DEFAULT -1');
  }

  public close(): void {
    this.db.close();
  }

  /** The database, shared with the semantic index and the face store. */
  public get sql(): DatabaseSync {
    return this.db;
  }

  // --- crossings of the lines ---

  public addCrossings(rows: StoredCrossing[]): void {
    const insert = this.db.prepare('INSERT INTO crossings (camera_id, line, direction, way, label, track_id, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row.cameraId, row.line, row.direction, row.way ?? null, row.label, row.trackId, row.at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The crossings of a range, newest first, a page at a time (`before`: the moment of the last one taken). */
  public crossingsPage(opts: { cameraIds?: string[]; startMs: number; endMs: number; before?: number; limit: number }): StoredCrossing[] {
    const where = ['at_ms >= ?', 'at_ms <= ?'];
    const args: (string | number)[] = [opts.startMs, opts.endMs];
    if (opts.before !== undefined) {
      where.push('at_ms < ?');
      args.push(opts.before);
    }
    if (opts.cameraIds?.length) {
      where.push(`camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    const rows = this.db
      .prepare(`SELECT camera_id, line, direction, way, label, track_id, at_ms FROM crossings WHERE ${where.join(' AND ')} ORDER BY at_ms DESC LIMIT ?`)
      .all(...args, opts.limit) as { camera_id: string; line: string; direction: string; way: string | null; label: string; track_id: number; at_ms: number }[];
    return rows.map((row) => ({
      cameraId: row.camera_id,
      line: row.line,
      direction: row.direction === 'a-to-b' ? 'a-to-b' : 'b-to-a',
      ...(row.way === 'in' || row.way === 'out' ? { way: row.way } : {}),
      label: row.label,
      trackId: row.track_id,
      at: row.at_ms,
    }));
  }

  /** The labels the lines counted in a range, each once, in order. */
  public crossingLabels(opts: { cameraIds?: string[]; startMs: number; endMs: number }): string[] {
    const where = ['at_ms >= ?', 'at_ms <= ?'];
    const args: (string | number)[] = [opts.startMs, opts.endMs];
    if (opts.cameraIds?.length) {
      where.push(`camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    const rows = this.db.prepare(`SELECT DISTINCT label FROM crossings WHERE ${where.join(' AND ')} ORDER BY label`).all(...args) as { label: string }[];
    return rows.map((row) => row.label);
  }

  /** The lines that counted in a range, by camera, and whether one of them was counted with a way in. */
  public crossingLines(opts: { cameraIds?: string[]; startMs: number; endMs: number }): { cameraId: string; line: string; hasWay: boolean }[] {
    const where = ['at_ms >= ?', 'at_ms <= ?'];
    const args: (string | number)[] = [opts.startMs, opts.endMs];
    if (opts.cameraIds?.length) {
      where.push(`camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    const rows = this.db
      .prepare(`SELECT camera_id, line, MAX(way IS NOT NULL) AS has_way FROM crossings WHERE ${where.join(' AND ')} GROUP BY camera_id, line ORDER BY line`)
      .all(...args) as { camera_id: string; line: string; has_way: number }[];
    return rows.map((row) => ({ cameraId: row.camera_id, line: row.line, hasWay: row.has_way === 1 }));
  }

  /** How many crossed each line of a range, by camera, line, label and way: one query for the modules page. */
  public crossingTotals(opts: { startMs: number; endMs: number }): { cameraId: string; line: string; label: string; way?: 'in' | 'out'; count: number }[] {
    const rows = this.db
      .prepare('SELECT camera_id, line, label, way, COUNT(*) AS n FROM crossings WHERE at_ms >= ? AND at_ms <= ? GROUP BY camera_id, line, label, way')
      .all(opts.startMs, opts.endMs) as { camera_id: string; line: string; label: string; way: string | null; n: number }[];
    return rows.map((row) => ({
      cameraId: row.camera_id,
      line: row.line,
      label: row.label,
      ...(row.way === 'in' || row.way === 'out' ? { way: row.way } : {}),
      count: Number(row.n),
    }));
  }

  /** Counts are kept longer than the video (a year of a busy door is under a million short rows): older ones go. */
  public pruneCrossings(beforeMs: number): number {
    return Number(this.db.prepare('DELETE FROM crossings WHERE at_ms < ?').run(beforeMs).changes);
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
        `INSERT INTO segments (camera_id, role, start_us, end_us, path, bytes, codec, codec_string, width, height, video_pid, audio_pid, keyframes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.camera_id,
        row.role,
        row.start_us,
        row.end_us,
        this.storedPath(row.path),
        row.bytes,
        row.codec,
        row.codec_string,
        row.width,
        row.height,
        row.video_pid,
        row.audio_pid,
        row.keyframes,
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * A file below the recordings directory is stored by its place in it, with `/` on every system: the archive can
   * then be mounted or moved elsewhere as a whole. Rows already written keep the path they have.
   */
  private storedPath(path: string): string {
    if (!this.recordingsDir) return path;
    const below = relative(this.recordingsDir, path);
    return below && !below.startsWith('..') && !isAbsolutePath(below) ? below.split(sep).join('/') : path;
  }

  /**
   * Where the file of a segment is now: everything that opens, sizes or removes one asks here. A stored path that
   * is not absolute lies below the recordings directory. An absolute one (rows of older versions, a file outside
   * the recordings directory) is used as it is while the file is there; when it is not, the archive was moved (the
   * volume mounted elsewhere, a folder renamed) and the file is looked for at the same place below the recordings
   * directory of today. Without this playback of a moved archive was silently empty and retention deleted the rows
   * and left the files.
   */
  public file(segment: Pick<SegmentRow, 'path'>): string {
    const stored = segment.path;
    if (!this.recordingsDir) return stored;
    if (!isAbsolutePath(stored)) return join(this.recordingsDir, stored);
    if (existsSync(stored)) return stored;
    // …/recordings/<camera>/<day>/<file>, written on this system or another
    const parts = stored.split(/[\\/]/);
    return parts.length > 4 && parts.at(-4) === 'recordings' ? join(this.recordingsDir, ...parts.slice(-3)) : stored;
  }

  /** The row with `path` being the place of its file now, for what reads a file by its row (reader.ts, export.ts). */
  public located(segment: SegmentRow): SegmentRow {
    return { ...segment, path: this.file(segment) };
  }

  public updateSegment(id: number, endUs: number, bytes: number, keyframes: string): void {
    this.db.prepare('UPDATE segments SET end_us = ?, bytes = ?, keyframes = ? WHERE id = ?').run(endUs, bytes, keyframes, id);
  }

  public segments(cameraId: string, role: string, startUs: number, endUs: number): SegmentRow[] {
    return this.db
      .prepare('SELECT * FROM segments WHERE camera_id = ? AND role = ? AND end_us >= ? AND start_us <= ? ORDER BY start_us')
      .all(cameraId, role, startUs, endUs) as unknown as SegmentRow[];
  }

  /**
   * Whether `segments()` would find anything, without reading it. Asked for every listed event («has a recording»),
   * and `segments()` walks the index from the camera's oldest file up to the range: 4 ms for an event of today on two
   * weeks of archive, seconds for a page of statistics. The file that starts last before the end of the range is the
   * one that covers it, when one does, and the index gives it at once. Only when that one ends before the range is
   * the old question asked: files overlap a little where one was cut, so an earlier one may still reach into it.
   */
  /** Whether any file of a camera's role reaches into a range (cameraId, role, startUs, endUs): from the index alone. */
  public readonly anySegmentSql = 'SELECT 1 FROM segments WHERE camera_id = ? AND role = ? AND end_us >= ? AND start_us <= ? LIMIT 1';

  public hasSegments(cameraId: string, role: string, startUs: number, endUs: number): boolean {
    // prepared once: asked thousands of times in a row, where preparing costs more than the look itself
    this.lastSegment ??= this.db.prepare('SELECT end_us FROM segments WHERE camera_id = ? AND role = ? AND start_us <= ? ORDER BY start_us DESC LIMIT 1');
    const last = this.lastSegment.get(cameraId, role, endUs) as { end_us: number } | undefined;
    if (!last) return false;
    if (last.end_us >= startUs) return true;
    this.anySegment ??= this.db.prepare(this.anySegmentSql);
    return this.anySegment.get(cameraId, role, startUs, endUs) !== undefined;
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
    // a segment that ended before the cutoff started before it: `start_us <` reads only the old end of segments_time.
    // With `end_us <` alone every row was read, on each retention pass: at a start on a cold HDD it held the recorder's
    // loop ~50 s, and every call to it timed out meanwhile
    return this.db
      .prepare('SELECT * FROM segments WHERE start_us < ? AND end_us < ? ORDER BY start_us LIMIT ?')
      .all(cutoffUs, cutoffUs, limit) as unknown as SegmentRow[];
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

  /**
   * Events recorded before ViON 2.6.1 kept a module's question among their types when it was answered only «нет»
   * («играет в компьютер» on every event the module looked at): the filter by type, the search and the counts by type
   * found the boy not playing too. Takes such a question out of the types of up to `limit` events after the rowid
   * `after`; `next` is where to go on, undefined at the end. The answers stay on the segments.
   */
  public dropNoAnswerTypes(after: number, limit = 500): { changed: number; next: number | undefined } {
    // only an event with a «нет» answer can have one to take out: the rest are not read
    const rows = this.db
      .prepare('SELECT rowid, data FROM events WHERE rowid > ? AND instr(data, ?) > 0 ORDER BY rowid LIMIT ?')
      .all(after, ': нет"', limit) as { rowid: number; data: string }[];
    const update = this.db.prepare('UPDATE events SET data = ? WHERE rowid = ?');
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const event = JSON.parse(row.data) as RecordedEvent;
        const types = typesWithoutNo(event);
        if (!types) continue;
        update.run(JSON.stringify({ ...event, types }), row.rowid);
        changed++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { changed, next: rows.length === limit ? rows[rows.length - 1].rowid : undefined };
  }

  /**
   * Files whose row ends more than `gapUs` past their last keyframe, among up to `limit` rows after the id `after`
   * (`next`: where to go on, undefined at the end): before NVR 0.22.10 a file was closed by the clock, and one whose
   * stream stopped with its connection open was said to be recorded for as long as it stayed open.
   */
  public endingLate(after: number, gapUs: number, limit = 200): { rows: SegmentRow[]; next: number | undefined } {
    const scanned = this.db.prepare('SELECT * FROM segments WHERE id > ? ORDER BY id LIMIT ?').all(after, limit) as unknown as SegmentRow[];
    const rows = scanned.filter((row) => {
      const last = parseKeyframes(row.keyframes).at(-1);
      return last !== undefined && row.end_us - last.tsUs > gapUs;
    });
    return { rows, next: scanned.length === limit ? scanned[scanned.length - 1].id : undefined };
  }

  /** Ends the row of a file at `endUs` if it still ends at `was` (its recorder may have written it since it was read). */
  public endSegmentAt(id: number, endUs: number, was: number): boolean {
    return Number(this.db.prepare('UPDATE segments SET end_us = ? WHERE id = ? AND end_us = ?').run(endUs, id, was).changes) > 0;
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
    return this.eventPage('*', opts) as EventRow[];
  }

  /**
   * The same page as `events()`, of two values per event instead of its whole JSON: counting events needs their
   * types and the number of their segments, and the database reads these in half the time it takes to parse the
   * events in JavaScript. (Not so for what lies deeper, the detections and their scores: measured, the database
   * was slower at those, so a filter on them still parses.)
   */
  public eventDigests(opts: Parameters<Store['events']>[0]): EventDigest[] {
    const columns = "id, camera_id, start_ms, end_ms, json_extract(data, '$.types') AS types, json_array_length(data, '$.segments') AS segments";
    return this.eventPage(columns, opts) as EventDigest[];
  }

  /**
   * The types of the events of a while (labels, triggers, the questions modules answered) with the events of each, or
   * with `attributes` the attribute types of their segments alone: read by the database from the JSON, so a month of a
   * busy recorder is not parsed event by event, and none is left out by a page of the newest.
   */
  /** `attributes`: the attribute types of the segments instead; `answers`: their labels («поза: лежит», «Анна»). */
  public eventTypeCounts(opts: { cameraIds?: string[]; startMs: number; endMs: number }): Map<string, number> {
    const { where, args } = this.typesWhere(opts);
    const sql = `SELECT t.value AS name, COUNT(*) AS n FROM events e, json_each(e.data, '$.types') t WHERE ${where} GROUP BY name`;
    const rows = this.db.prepare(sql).all(...args) as unknown as { name: unknown; n: number }[];
    return new Map(rows.filter((row) => typeof row.name === 'string' && row.name).map((row) => [row.name as string, Number(row.n)]));
  }

  /**
   * The attribute types (the questions of modules, faces, plates) of the events of a while and their labels (the
   * answers), each with how many events have it. One pass over the JSON of the segments for both: two took 2 s each of
   * the plugin's thread for a month of a busy recorder, on every question the assistant was asked.
   */
  public attributeCounts(opts: { cameraIds?: string[]; startMs: number; endMs: number }): { types: Map<string, number>; answers: Map<string, number> } {
    const { where, args } = this.typesWhere(opts);
    const sql =
      "WITH a AS MATERIALIZED (SELECT DISTINCT e.id AS id, json_extract(a.value, '$.type') AS type, json_extract(a.value, '$.label') AS label " +
      `FROM events e, json_each(e.data, '$.segments') s, json_each(s.value, '$.attributes') a WHERE ${where}) ` +
      "SELECT 'type' AS kind, type AS name, COUNT(DISTINCT id) AS n FROM a GROUP BY type " +
      "UNION ALL SELECT 'answer', label, COUNT(DISTINCT id) FROM a GROUP BY label";
    const rows = this.db.prepare(sql).all(...args) as unknown as { kind: string; name: unknown; n: number }[];
    const types = new Map<string, number>();
    const answers = new Map<string, number>();
    for (const row of rows) if (typeof row.name === 'string' && row.name) (row.kind === 'type' ? types : answers).set(row.name, Number(row.n));
    return { types, answers };
  }

  private typesWhere(opts: { cameraIds?: string[]; startMs: number; endMs: number }): { where: string; args: (string | number)[] } {
    const where = [`(${stillOn('e.')} OR COALESCE(e.end_ms, e.start_ms) >= ?)`, 'e.start_ms <= ?'];
    const args: (string | number)[] = [opts.startMs, opts.endMs];
    if (opts.cameraIds?.length) {
      where.push(`e.camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    return { where: where.join(' AND '), args };
  }

  private eventPage(columns: string, opts: Parameters<Store['events']>[0]): unknown[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.cameraIds?.length) {
      where.push(`camera_id IN (${opts.cameraIds.map(() => '?').join(',')})`);
      args.push(...opts.cameraIds);
    }
    if (opts.startMs !== undefined) {
      // in brackets: the conditions are joined by AND, an OR outside them let the events of other cameras in
      where.push(`(${stillOn()} OR COALESCE(end_ms, start_ms) >= ?)`);
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
    const sql = `SELECT ${columns} FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_ms DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, opts.limit) as unknown as { id: string; start_ms: number }[];
    // the next page is asked for with `before` = the start of the last row, a strict `<`: events that started in the
    // same millisecond as that row and did not fit under LIMIT would never be listed, so a full page takes them too
    if (rows.length > 0 && rows.length === opts.limit) {
      const lastMs = rows[rows.length - 1].start_ms;
      const listed = new Set(rows.filter((r) => r.start_ms === lastMs).map((r) => r.id));
      const tied = this.db.prepare(`SELECT ${columns} FROM events WHERE ${[...where, 'start_ms = ?'].join(' AND ')}`).all(...args, lastMs) as unknown as typeof rows;
      for (const row of tied) if (!listed.has(row.id)) rows.push(row);
    }
    return rows;
  }

  public setFavorite(id: string, favorite: boolean): void {
    this.db.prepare('UPDATE events SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  }

  public deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM event_trace WHERE event_id = ?').run(id);
  }

  /** The start of the oldest video left of each camera that has any (ms). */
  public oldestVideo(): Map<string, number> {
    const rows = this.db.prepare('SELECT camera_id, MIN(start_us) AS start_us FROM segments GROUP BY camera_id').all() as { camera_id: string; start_us: number }[];
    return new Map(rows.map((row) => [row.camera_id, Math.floor(Number(row.start_us) / 1000)]));
  }

  /** The events of a camera that ended from one time to another with a trace (cameraId, sinceMs, beforeMs, limit). */
  public readonly pruneTracesSql =
    'SELECT id FROM events e WHERE camera_id = ? AND COALESCE(end_ms, start_ms) >= ? AND COALESCE(end_ms, start_ms) < ? ' +
    'AND EXISTS (SELECT 1 FROM event_trace t WHERE t.event_id = e.id) LIMIT ?';

  /**
   * Deletes the detection trace of a camera's events that ended before a time (and from `sinceMs`, where a pass before
   * left off: every pass read every old event of the camera), at most `limit` events a call (a trace is a few hundred
   * rows: one big delete held the database for seconds). The events stay. Answers the events cleared.
   */
  public pruneTracesBefore(cameraId: string, beforeMs: number, limit: number, sinceMs = 0): number {
    const ids = (this.db.prepare(this.pruneTracesSql).all(cameraId, sinceMs, beforeMs, limit) as { id: string }[]).map((row) => row.id);
    if (!ids.length) return 0;
    this.db.prepare(`DELETE FROM event_trace WHERE event_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return ids.length;
  }

  /** The bytes of the pages in use, the free ones left out: two pragmas, not a count (cheap on any size). */
  public usedBytes(): number {
    const one = (sql: string) => Number(Object.values(this.db.prepare(sql).get() as Record<string, number>)[0]);
    return (one('PRAGMA page_count') - one('PRAGMA freelist_count')) * one('PRAGMA page_size');
  }

  /** The ended events with a trace, oldest first (limit): from the index events_state_time and the trace's by event. */
  public readonly oldestTracedSql =
    "SELECT id FROM events e WHERE state = 'ended' AND EXISTS (SELECT 1 FROM event_trace t WHERE t.event_id = e.id) ORDER BY start_ms LIMIT ?";

  /** Clears the traces of up to `limit` oldest events that have one; the events stay. Answers the events cleared. */
  public pruneOldestTraces(limit: number): number {
    const ids = (this.db.prepare(this.oldestTracedSql).all(limit) as { id: string }[]).map((row) => row.id);
    if (!ids.length) return 0;
    this.db.prepare(`DELETE FROM event_trace WHERE event_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return ids.length;
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
    // a favorite episode keeps its events like a favorite event keeps itself; excluded here rather than
    // skipped by the caller, which would page over the same kept rows forever
    return this.db
      .prepare(
        `SELECT * FROM events WHERE start_ms < ? AND favorite = 0
           AND id NOT IN (SELECT m.event_id FROM episode_members m JOIN episodes e ON e.id = m.episode_id WHERE e.favorite = 1)
         ORDER BY start_ms LIMIT ?`,
      )
      .all(cutoffMs, limit) as unknown as EventRow[];
  }

  // --- episodes ---
  public upsertEpisode(row: EpisodeRow, eventIds: string[]): void {
    this.db
      .prepare(
        `INSERT INTO episodes (id, start_ms, end_ms, favorite, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, data = excluded.data`,
      )
      .run(row.id, row.start_ms, row.end_ms, row.favorite, row.data);
    this.db.prepare('DELETE FROM episode_members WHERE episode_id = ?').run(row.id);
    const add = this.db.prepare('INSERT OR IGNORE INTO episode_members (episode_id, event_id) VALUES (?, ?)');
    for (const eventId of eventIds) add.run(row.id, eventId);
  }

  public episode(id: string): EpisodeRow | undefined {
    return (this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) ?? undefined) as EpisodeRow | undefined;
  }

  /** Episodes overlapping [fromMs, toMs], newest first. */
  public episodes(opts: { fromMs: number; toMs: number; limit: number; favoritesOnly?: boolean }): EpisodeRow[] {
    return this.db
      .prepare(`SELECT * FROM episodes WHERE end_ms >= ? AND start_ms <= ? ${opts.favoritesOnly ? 'AND favorite = 1' : ''} ORDER BY start_ms DESC LIMIT ?`)
      .all(opts.fromMs, opts.toMs, opts.limit) as unknown as EpisodeRow[];
  }

  /** How many episodes overlap [fromMs, toMs]; with `cameraIds`, only those with an event of one of these cameras. */
  public episodeCount(opts: { fromMs: number; toMs: number; favoritesOnly?: boolean; cameraIds?: string[] }): number {
    const where = ['end_ms >= ?', 'start_ms <= ?'];
    const args: (string | number)[] = [opts.fromMs, opts.toMs];
    if (opts.favoritesOnly) where.push('favorite = 1');
    if (opts.cameraIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(episodes.data, '$.episode.members') AS m
           WHERE json_extract(m.value, '$.cameraId') IN (${opts.cameraIds.map(() => '?').join(',')}))`,
      );
      args.push(...opts.cameraIds);
    }
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n);
  }

  /** Episodes ending at or after `sinceMs` (the ones still open when the NVR restarted). */
  public episodesEndingAfter(sinceMs: number): EpisodeRow[] {
    return this.db.prepare('SELECT * FROM episodes WHERE end_ms >= ? ORDER BY start_ms').all(sinceMs) as unknown as EpisodeRow[];
  }

  public episodeIdsOfEvents(eventIds: string[]): string[] {
    if (!eventIds.length) return [];
    const query = this.db.prepare('SELECT DISTINCT episode_id FROM episode_members WHERE event_id = ?');
    const ids = new Set<string>();
    for (const eventId of eventIds) for (const row of query.all(eventId) as { episode_id: string }[]) ids.add(row.episode_id);
    return [...ids];
  }

  public setEpisodeFavorite(id: string, favorite: boolean, data: string): void {
    this.db.prepare('UPDATE episodes SET favorite = ?, data = ? WHERE id = ?').run(favorite ? 1 : 0, data, id);
  }

  public deleteEpisode(id: string): void {
    this.db.prepare('DELETE FROM episode_members WHERE episode_id = ?').run(id);
    this.db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
  }

  /**
   * Events still "active" that no update reached since `before` (a frame worker that crashed, an "end" the server
   * lost): ended at their last update. Without `before`, every active event: at the start of the plugin none is live.
   */
  public closeStaleActive(before?: number): number {
    const res = this.db
      .prepare(
        `UPDATE events SET state = 'ended',
           end_ms = COALESCE(json_extract(data, '$.lastUpdate'), start_ms),
           data = json_set(data, '$.state', 'ended', '$.endTime', COALESCE(json_extract(data, '$.lastUpdate'), start_ms))
         WHERE state = 'active'${before === undefined ? '' : " AND COALESCE(json_extract(data, '$.lastUpdate'), start_ms) < ?"}`,
      )
      .run(...(before === undefined ? [] : [before]));
    return Number(res.changes);
  }

  public activeEvents(cameraId: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE camera_id = ? AND state = 'active'").all(cameraId) as unknown as EventRow[];
  }
}

/** Absolute on this system or the other one: an archive is also moved between a Windows and a Linux server. */
/**
 * The types of an event without a question answered there only «нет», as the server keeps them since ViON 2.6.1;
 * undefined when none goes. A type a detection or a trigger gives stays whatever was answered.
 */
function typesWithoutNo(event: RecordedEvent): string[] | undefined {
  const segments = event.segments ?? [];
  const given = new Set<string>([...segments.flatMap((s) => (s.detections ?? []).map((d) => String(d.label))), ...(event.triggers ?? []).map((t) => String(t.type))]);
  // per type: whether any answer of it was other than «нет»
  const answered = new Map<string, boolean>();
  for (const segment of segments) {
    for (const { type, label } of segment.attributes ?? []) {
      if (typeof type !== 'string' || !type || typeof label !== 'string') continue;
      answered.set(type, (answered.get(type) ?? false) || label !== `${type}: нет`);
    }
  }
  const types = event.types ?? [];
  const kept = types.filter((type) => answered.get(type) !== false || given.has(type));
  return kept.length === types.length ? undefined : kept;
}

function isAbsolutePath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

export function parseKeyframes(json: string): Keyframe[] {
  return (JSON.parse(json) as [number, number][]).map(([offset, tsUs]) => ({ offset, tsUs }));
}
