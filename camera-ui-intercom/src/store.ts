/**
 * What the intercom keeps, in one SQLite file of its storage (node:sqlite, as the recorder): panels, people,
 * instructions, guest codes, visits with a full-text index of their conversations, the door log, and small settings.
 *
 * Each row keeps the whole object as JSON and, beside it, the columns the archive filters on, so the filters are SQL
 * and the object is read back as written.
 */
import { DatabaseSync } from 'node:sqlite';

import type { Category, DoorLogEntry, GuestCode, Instruction, Outcome, Panel, Person, Visit } from './types.js';

const SCHEMA_VERSION = 1;

export interface VisitQuery {
  from?: number;
  to?: number;
  panelIds?: string[];
  personIds?: string[];
  /** visits whose visitor no person of the directory matched */
  unknownOnly?: boolean;
  categories?: Category[];
  companies?: string[];
  outcomes?: Outcome[];
  opened?: boolean;
  hasMessage?: boolean;
  withInstruction?: boolean;
  flagged?: boolean;
  /** part of a plate, either alphabet */
  plate?: string;
  /** words of the conversation, the purpose, the summary, the name or the service */
  text?: string;
  unseenBy?: string;
  /** visits that started before (the next page) */
  before?: number;
  limit?: number;
}

export interface VisitPage {
  visits: Visit[];
  hasMore: boolean;
}

/** Text as indexed and searched: the index's tokenizer does not take ё for е, as Russian writers mostly do. */
const fold = (text: string) => text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

/** One FTS5 query of what someone typed: each word a prefix, all of them needed. */
export function ftsQuery(text: string): string | undefined {
  const words = fold(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((word) => `"${word}"*`).join(' ') : undefined;
}

function visitText(visit: Visit): Record<string, string> {
  return {
    title: fold(visit.title ?? ''),
    summary: fold([visit.summary, visit.messageForOwner].filter(Boolean).join(' ')),
    purpose: fold(visit.purpose ?? ''),
    transcript: fold(visit.transcript.map((line) => line.text).join('\n')),
    who: fold([visit.who.name, visit.who.company, ...visit.who.identification.map((id) => id.value)].filter(Boolean).join(' ')),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panels (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instructions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guest_codes (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        category TEXT,
        company TEXT,
        person_id TEXT,
        opened INTEGER NOT NULL DEFAULT 0,
        has_message INTEGER NOT NULL DEFAULT 0,
        has_instruction INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0,
        plates TEXT NOT NULL DEFAULT '',
        seen_by TEXT NOT NULL DEFAULT '[]',
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS visits_time ON visits (started_at);
      CREATE INDEX IF NOT EXISTS visits_panel_time ON visits (panel_id, started_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS visits_text USING fts5 (id UNINDEXED, title, summary, purpose, transcript, who, tokenize = 'unicode61');
      CREATE TABLE IF NOT EXISTS door_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        panel_id TEXT NOT NULL,
        door_id TEXT NOT NULL,
        visit_id TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS door_log_time ON door_log (at);
    `);
    if (this.getMeta<number>('schema') === undefined) this.setMeta('schema', SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  // ---- small settings ----

  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // ---- panels, people, instructions, codes: the object as JSON ----

  private all<T>(table: string, order = 'id'): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY ${order}`).all() as { data: string }[]).map((row) => JSON.parse(row.data) as T);
  }

  private one<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private remove(table: string, id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes) > 0;
  }

  panels(): Panel[] {
    return this.all<Panel>('panels');
  }

  panel(id: string): Panel | undefined {
    return this.one<Panel>('panels', id);
  }

  savePanel(panel: Panel): void {
    this.db.prepare('INSERT INTO panels (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(panel.id, JSON.stringify(panel));
  }

  deletePanel(id: string): boolean {
    return this.remove('panels', id);
  }

  people(): Person[] {
    return this.all<Person>('people', 'name COLLATE NOCASE');
  }

  person(id: string): Person | undefined {
    return this.one<Person>('people', id);
  }

  savePerson(person: Person): void {
    this.db
      .prepare('INSERT INTO people (id, name, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data')
      .run(person.id, person.name, JSON.stringify(person));
  }

  deletePerson(id: string): boolean {
    return this.remove('people', id);
  }

  instructions(): Instruction[] {
    return this.all<Instruction>('instructions', 'created_at DESC');
  }

  instruction(id: string): Instruction | undefined {
    return this.one<Instruction>('instructions', id);
  }

  saveInstruction(instruction: Instruction): void {
    this.db
      .prepare('INSERT INTO instructions (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(instruction.id, instruction.createdAt, JSON.stringify(instruction));
  }

  /** Instructions that ended (done, cancelled or over) before the moment: kept a while for the archive, then removed. */
  purgeInstructions(over: (instruction: Instruction) => number | undefined, before: number): number {
    let removed = 0;
    for (const instruction of this.instructions()) {
      const endedAt = over(instruction);
      if (endedAt !== undefined && endedAt < before && this.remove('instructions', instruction.id)) removed++;
    }
    return removed;
  }

  codes(): GuestCode[] {
    return this.all<GuestCode>('guest_codes', 'created_at DESC');
  }

  code(id: string): GuestCode | undefined {
    return this.one<GuestCode>('guest_codes', id);
  }

  saveCode(code: GuestCode): void {
    this.db
      .prepare('INSERT INTO guest_codes (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(code.id, code.createdAt, JSON.stringify(code));
  }

  // ---- visits ----

  saveVisit(visit: Visit): void {
    const opened = visit.actions.some((action) => action.kind === 'open' && action.result !== 'failed');
    const plates = visit.who.identification
      .filter((id) => id.kind === 'plate')
      .map((id) => id.value)
      .join(' ');
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO visits (id, panel_id, started_at, ended_at, outcome, category, company, person_id, opened, has_message, has_instruction,
             flagged, plates, seen_by, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, outcome = excluded.outcome, category = excluded.category,
             company = excluded.company, person_id = excluded.person_id, opened = excluded.opened, has_message = excluded.has_message,
             has_instruction = excluded.has_instruction, flagged = excluded.flagged, plates = excluded.plates, seen_by = excluded.seen_by,
             data = excluded.data`,
        )
        .run(
          visit.id,
          visit.panelId,
          visit.startedAt,
          visit.endedAt ?? null,
          visit.outcome ?? null,
          visit.who.category ?? null,
          visit.who.company ?? null,
          visit.who.personId ?? null,
          opened ? 1 : 0,
          visit.messageForOwner || visit.voiceMessage ? 1 : 0,
          visit.instructionId ? 1 : 0,
          visit.flags.length ? 1 : 0,
          plates,
          JSON.stringify(visit.seenBy),
          JSON.stringify(visit),
        );
      const text = visitText(visit);
      this.db.prepare('DELETE FROM visits_text WHERE id = ?').run(visit.id);
      this.db
        .prepare('INSERT INTO visits_text (id, title, summary, purpose, transcript, who) VALUES (?, ?, ?, ?, ?, ?)')
        .run(visit.id, text.title, text.summary, text.purpose, text.transcript, text.who);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  visit(id: string): Visit | undefined {
    return this.one<Visit>('visits', id);
  }

  queryVisits(q: VisitQuery): VisitPage {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const list = (column: string, values: string[] | undefined) => {
      if (!values?.length) return;
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    if (q.from !== undefined) {
      where.push('started_at >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('started_at < ?');
      params.push(q.to);
    }
    if (q.before !== undefined) {
      where.push('started_at < ?');
      params.push(q.before);
    }
    list('panel_id', q.panelIds);
    list('person_id', q.personIds);
    list('category', q.categories);
    list('company', q.companies);
    list('outcome', q.outcomes);
    if (q.unknownOnly) where.push('person_id IS NULL');
    if (q.opened !== undefined) where.push(`opened = ${q.opened ? 1 : 0}`);
    if (q.hasMessage !== undefined) where.push(`has_message = ${q.hasMessage ? 1 : 0}`);
    if (q.withInstruction !== undefined) where.push(`has_instruction = ${q.withInstruction ? 1 : 0}`);
    if (q.flagged !== undefined) where.push(`flagged = ${q.flagged ? 1 : 0}`);
    if (q.plate) {
      where.push('plates LIKE ?');
      params.push(`%${q.plate.replace(/[%_]/g, '')}%`);
    }
    if (q.unseenBy) {
      where.push('NOT EXISTS (SELECT 1 FROM json_each(visits.seen_by) WHERE json_each.value = ?)');
      params.push(q.unseenBy);
    }
    const fts = q.text ? ftsQuery(q.text) : undefined;
    if (q.text && !fts) return { visits: [], hasMore: false };
    if (fts) {
      where.push('id IN (SELECT id FROM visits_text WHERE visits_text MATCH ?)');
      params.push(fts);
    }
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    const sql = `SELECT data FROM visits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ${limit + 1}`;
    const rows = this.db.prepare(sql).all(...params) as { data: string }[];
    return { visits: rows.slice(0, limit).map((row) => JSON.parse(row.data) as Visit), hasMore: rows.length > limit };
  }

  /** The services visitors named, for the archive's filter. */
  companies(): string[] {
    return (this.db.prepare('SELECT DISTINCT company FROM visits WHERE company IS NOT NULL ORDER BY company').all() as { company: string }[]).map((row) => row.company);
  }

  deleteVisit(id: string): Visit | undefined {
    const visit = this.visit(id);
    if (!visit) return undefined;
    this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM visits_text WHERE id = ?').run(id);
    return visit;
  }

  /** Visits that started before the moment, removed; returned so their files go too. */
  purgeVisits(before: number): Visit[] {
    const old = (this.db.prepare('SELECT data FROM visits WHERE started_at < ?').all(before) as { data: string }[]).map((row) => JSON.parse(row.data) as Visit);
    for (const visit of old) this.deleteVisit(visit.id);
    this.db.prepare('DELETE FROM door_log WHERE at < ?').run(before);
    return old;
  }

  // ---- the door log ----

  logDoor(entry: DoorLogEntry): void {
    this.db
      .prepare('INSERT INTO door_log (at, panel_id, door_id, visit_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(entry.at, entry.panelId, entry.doorId, entry.visitId ?? null, JSON.stringify(entry));
  }

  doorLog(q: { panelId?: string; from?: number; to?: number; limit?: number } = {}): DoorLogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.panelId) {
      where.push('panel_id = ?');
      params.push(q.panelId);
    }
    if (q.from !== undefined) {
      where.push('at >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('at < ?');
      params.push(q.to);
    }
    const limit = Math.max(1, Math.min(q.limit ?? 100, 500));
    const rows = this.db.prepare(`SELECT data FROM door_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ${limit}`).all(...params) as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data) as DoorLogEntry);
  }
}
