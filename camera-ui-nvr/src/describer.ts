// Event descriptions by the assistant model (any provider the admin configured: an OpenAI-compatible
// gateway, Ollama, OpenRouter…). Only ended events with objects are described, one at a time and
// within an hourly budget, so a busy camera never floods the model. The text is indexed for
// full-text search (hybrid with the CLIP vectors) and can be sent as a "smart" notification.

import type { DatabaseSync } from 'node:sqlite';
import type { RecordedEvent } from './types.js';

export interface EventDescription {
  title: string;
  description: string;
  tags: string[];
  model?: string;
  at: number;
}

export interface DescribeSettings {
  enabled: boolean;
  notify: boolean;
  maxPerHour: number;
}

export interface AskResult {
  ok: boolean;
  text?: string;
  json?: unknown;
  reason?: string;
  message?: string;
}

export interface DescriberDeps {
  ask(request: {
    system: string;
    prompt: string;
    images: { data: Uint8Array; mimeType: string }[];
    outputSchema: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<AskResult>;
  access(): Promise<{ allowed: boolean; model: string | null; vision: boolean | null; language: string | null }>;
  pictures(event: RecordedEvent): Uint8Array[];
  cameraName(cameraId: string): string;
  settings(): DescribeSettings;
  /** Stores the description on the event and tells the UI. */
  save(eventId: string, description: EventDescription): void;
  notify(event: RecordedEvent, description: EventDescription, picture: Uint8Array | undefined): Promise<void>;
  log(level: 'log' | 'warn' | 'debug', message: string): void;
}

export interface TextSearchResult {
  eventId: string;
  cameraId: string;
  timestamp: number;
  score: number;
}

const QUEUE_LIMIT = 50;
const OBJECT_LABELS = new Set(['person', 'vehicle', 'animal']);

const LABELS_RU: Record<string, string> = { person: 'человек', vehicle: 'транспорт', animal: 'животное', face: 'лицо', license_plate: 'номер' };

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Заголовок уведомления, до 6 слов' },
    description: { type: 'string', description: 'Что произошло, 1–2 предложения' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Ключевые слова для поиска: объекты, цвета, действия' },
  },
  required: ['title', 'description'],
};

function systemPrompt(language: string): string {
  const lang = language === 'ru' ? 'на русском языке' : `на языке «${language}»`;
  return [
    'Ты — модуль видеоаналитики системы видеонаблюдения ViON.',
    'По кадрам события опиши, что произошло: кто или что в кадре, что делает, важные детали (одежда, цвет и тип машины, предметы в руках, животные).',
    'Пиши только то, что видно на кадрах, без домыслов и оценок. Если кадр неинформативен, так и скажи.',
    `Ответ ${lang}: короткий заголовок для уведомления (до 6 слов, например «Курьер оставил посылку»), описание в 1–2 предложения и 3–8 ключевых слов для поиска.`,
  ].join('\n');
}

/** Crude Russian/English stemming for prefix search: "фургона" → "фург*", "ворота" → "вор*". */
function ftsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const stems = words.map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w));
  return stems.map((s) => `"${s}"*`).join(' OR ');
}

export class EventDescriber {
  private readonly queue: RecordedEvent[] = [];
  private running = false;
  private readonly recent: number[] = [];
  private stopped = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: DescriberDeps,
  ) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS event_text
      USING fts5(event_id UNINDEXED, camera_id UNINDEXED, ts UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
    `);
  }

  public stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Called for every ended event; only events with objects are described. */
  public offer(event: RecordedEvent): void {
    const s = this.deps.settings();
    if (!s.enabled || this.stopped) return;
    if ((event as { ai?: EventDescription }).ai) return;
    const labels = labelsOf(event);
    if (!labels.some((l) => OBJECT_LABELS.has(l))) return;
    if (this.queue.some((e) => e.id === event.id)) return;
    if (this.queue.length >= QUEUE_LIMIT) this.queue.shift();
    this.queue.push(event);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const s = this.deps.settings();
        if (!s.enabled) {
          this.queue.length = 0;
          break;
        }
        const hourAgo = Date.now() - 3_600_000;
        while (this.recent.length && this.recent[0] < hourAgo) this.recent.shift();
        if (s.maxPerHour > 0 && this.recent.length >= s.maxPerHour) {
          this.deps.log('debug', 'AI descriptions: hourly budget used, skipping queued events');
          this.queue.length = 0;
          break;
        }
        const event = this.queue.shift()!;
        this.recent.push(Date.now());
        await this.describe(event).catch((error: unknown) => this.deps.log('warn', `AI description failed: ${(error as Error).message}`));
      }
    } finally {
      this.running = false;
    }
  }

  public async describe(event: RecordedEvent): Promise<EventDescription | undefined> {
    const access = await this.deps.access();
    if (!access.allowed) {
      this.deps.log('warn', 'AI descriptions: NVR is not allowed to use the assistant model (Settings → Assistant → plugins)');
      return undefined;
    }
    const pictures = this.deps.pictures(event).slice(0, 3);
    if (!pictures.length) return undefined;
    const language = access.language ?? 'ru';
    const labels = labelsOf(event);
    const names = namesOf(event);
    const when = new Date(event.startTime);
    const prompt = [
      `Камера: ${this.deps.cameraName(event.cameraId)}`,
      `Время: ${when.toLocaleString('ru-RU')}`,
      `Детектор увидел: ${[...new Set(labels)].map((l) => LABELS_RU[l] ?? l).join(', ') || '—'}`,
      names.length ? `Распознано: ${names.join(', ')}` : '',
      `Кадров: ${pictures.length}`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.deps.ask({
      system: systemPrompt(language),
      prompt,
      images: pictures.map((data) => ({ data, mimeType: 'image/jpeg' })),
      outputSchema: OUTPUT_SCHEMA,
      timeoutMs: 90_000,
    });
    if (!result.ok) {
      this.deps.log('warn', `AI description: ${result.reason ?? 'error'} ${result.message ?? ''}`.trim());
      return undefined;
    }
    const parsed = parseAnswer(result);
    if (!parsed) return undefined;
    const description: EventDescription = { ...parsed, model: access.model ?? undefined, at: Date.now() };
    this.index(event, description);
    this.deps.save(event.id, description);
    if (this.deps.settings().notify) await this.deps.notify(event, description, pictures[0]).catch(() => undefined);
    return description;
  }

  public index(event: { id: string; cameraId: string; startTime: number }, d: EventDescription): void {
    this.db.prepare('DELETE FROM event_text WHERE event_id = ?').run(event.id);
    this.db
      .prepare('INSERT INTO event_text (event_id, camera_id, ts, text) VALUES (?, ?, ?, ?)')
      .run(event.id, event.cameraId, event.startTime, [d.title, d.description, ...d.tags].join('\n'));
  }

  /** Full-text search over descriptions; scores 0.5..1 so they rank with the vector matches. */
  public search(text: string, limit = 50): TextSearchResult[] {
    const query = ftsQuery(text);
    if (!query) return [];
    let rows: { event_id: string; camera_id: string; ts: number; rank: number }[];
    try {
      rows = this.db
        .prepare('SELECT event_id, camera_id, ts, bm25(event_text) AS rank FROM event_text WHERE event_text MATCH ? ORDER BY rank LIMIT ?')
        .all(query, limit) as typeof rows;
    } catch {
      return [];
    }
    if (!rows.length) return [];
    // bm25 is negative, lower is better: map the best to 1.0 and the rest down to 0.5
    const best = rows[0].rank;
    const worst = rows[rows.length - 1].rank;
    return rows.map((r) => ({
      eventId: r.event_id,
      cameraId: r.camera_id,
      timestamp: Number(r.ts),
      score: best === worst ? 1 : 0.5 + 0.5 * ((worst - r.rank) / (worst - best)),
    }));
  }

  public deleteEvents(ids: string[]): void {
    const del = this.db.prepare('DELETE FROM event_text WHERE event_id = ?');
    for (const id of ids) del.run(id);
  }
}

function labelsOf(event: RecordedEvent): string[] {
  return (event.segments ?? []).flatMap((s) => (s.detections ?? []).map((d) => String((d as { label?: string }).label ?? '')));
}

function namesOf(event: RecordedEvent): string[] {
  const out = new Set<string>();
  for (const s of event.segments ?? []) {
    for (const a of (s.attributes ?? []) as { type?: string; label?: string }[]) {
      if (a.type === 'face' && a.label && a.label !== 'unknown') out.add(`лицо: ${a.label}`);
      if (a.type === 'license_plate' && a.label) out.add(`номер: ${a.label}`);
    }
  }
  return [...out];
}

function parseAnswer(result: AskResult): Omit<EventDescription, 'model' | 'at'> | undefined {
  let value = result.json as { title?: unknown; description?: unknown; tags?: unknown } | undefined;
  if (!value && result.text) {
    try {
      value = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as typeof value;
    } catch {
      value = { title: result.text.split('\n')[0]?.slice(0, 60), description: result.text };
    }
  }
  const title = typeof value?.title === 'string' ? value.title.trim() : '';
  const description = typeof value?.description === 'string' ? value.description.trim() : '';
  if (!title && !description) return undefined;
  const tags = Array.isArray(value?.tags) ? value.tags.filter((t): t is string => typeof t === 'string').slice(0, 12) : [];
  return { title: title || description.split(/[.!?]/)[0].slice(0, 60), description: description || title, tags };
}
