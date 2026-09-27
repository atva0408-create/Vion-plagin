import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { exportClip, writeZip } from './export.js';
import { PlaybackManager } from './playback.js';
import { keyframeAtOrBefore, readGop, readKeyframe } from './reader.js';
import { Recorder } from './recorder.js';
import { parseKeyframes, Store } from './store.js';

import type { CameraDevice, DetectionEventType, DeviceStorage, Disposable, JsonSchema, LoggerService, PluginAPI } from '@camera.ui/sdk';
import type { EventRow } from './store.js';
import type {
  DetectionEventMessage,
  EventAttachments,
  GetEventsOptions,
  NvrFrame,
  NvrPlaybackCallbacks,
  PluginStorageValues,
  RecordedEvent,
  RecordingSegment,
  RecordingsDeletedEvent,
  RecordingState,
  StorageStats,
  SystemEvent,
} from './types.js';

type Unsubscribe = () => void;
type Role = 'high' | 'mid' | 'low';

const RETENTION_INTERVAL_MS = 5 * 60_000;
const MERGE_GAP_US = 2_000_000;
/** The writer owns the newest minutes; deleting them is refused. */
const PROTECTED_TAIL_US = 3 * 60_000_000;
const MAX_SYSTEM_EVENTS = 500;

interface ManagedCamera {
  device: CameraDevice;
  recorders: Map<Role, Recorder>;
  subscriptions: Disposable[];
  /** Recording is enabled but the plan has no free camera slot. */
  overLimit?: boolean;
}

/** Plan limits from the host (ViON Cloud plan or local defaults); 0 = unlimited. */
interface Entitlements {
  source: 'cloud' | 'local';
  plan: { id: string; name: string };
  nvr: { maxCameras: number; retentionDays: number };
}

const ENTITLEMENTS_INTERVAL_MS = 10 * 60_000;

export default class VionNvr extends BasePlugin<PluginStorageValues> {
  private store!: Store;
  private playback!: PlaybackManager;
  private ffmpegPath = 'ffmpeg';
  private readonly cameras = new Map<string, ManagedCamera>();
  private retentionTimer: NodeJS.Timeout | undefined;
  private entitlementsTimer: NodeJS.Timeout | undefined;
  /** Unknown until the host answers (older hosts without the call: no limits). */
  private entitlements: Entitlements | undefined;
  private instanceId = '';
  private paused = false;
  private ready: Promise<void>;
  private markReady!: () => void;

  private readonly detectionListeners = new Set<(m: DetectionEventMessage) => void>();
  private readonly deletedListeners = new Set<(ids: string[]) => void>();
  private readonly recordingsDeletedListeners = new Set<(e: RecordingsDeletedEvent) => void>();
  private readonly systemListeners = new Set<(e: SystemEvent) => void>();
  private readonly stateListeners = new Map<string, Set<(s: RecordingState) => void>>();
  private readonly systemEvents: SystemEvent[] = [];

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginStorageValues>) {
    super(logger, api, storage);
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    // the host awaits configureCameras() before FINISH_LAUNCHING: the store must be usable right away
    this.init();
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => void this.start());
    this.api.on(API_EVENT.SHUTDOWN, () => void this.stop());
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'plan',
        title: 'Тариф',
        description: 'Лимиты записи задаёт тариф ViON Cloud владельца сервера. Сменить тариф: cloud.vionvision.tech → «Тариф».',
        group: 'License',
        readonly: true,
        onGet: async () => {
          await this.refreshEntitlements();
          return this.planSummary();
        },
      },
      {
        type: 'number',
        key: 'retentionDays',
        title: 'Хранить записи, дней',
        description: 'Записи и события старше этого срока удаляются автоматически (избранное сохраняется). Не больше срока, который даёт тариф.',
        group: 'Storage',
        defaultValue: 14,
        minimum: 1,
        maximum: 3650,
        step: 1,
        store: true,
      },
      {
        type: 'number',
        key: 'quotaGB',
        title: 'Лимит архива, ГБ',
        description: '0 — без лимита (архив ограничен только свободным местом на диске).',
        group: 'Storage',
        defaultValue: 0,
        minimum: 0,
        step: 1,
        store: true,
      },
      {
        type: 'number',
        key: 'minFreePercent',
        title: 'Минимум свободного места, %',
        description: 'Когда свободного места меньше, самые старые записи удаляются.',
        group: 'Storage',
        defaultValue: 5,
        minimum: 1,
        maximum: 50,
        step: 1,
        store: true,
      },
      {
        type: 'number',
        key: 'postBufferSeconds',
        title: 'Запись после события, с',
        description: 'Режим «по событию»: сколько секунд писать после окончания движения.',
        group: 'Storage',
        defaultValue: 10,
        minimum: 0,
        maximum: 300,
        step: 1,
        store: true,
      },
      {
        type: 'number',
        key: 'segmentSeconds',
        title: 'Длина файла записи, с',
        description: 'Архив хранится файлами такой длины; короче — точнее удаление, длиннее — меньше файлов.',
        group: 'Storage',
        defaultValue: 60,
        minimum: 10,
        maximum: 600,
        step: 5,
        store: true,
      },
    ];
  }

  // ---------------------------------------------------------------- lifecycle

  private get dataDir(): string {
    return this.api.storagePath;
  }

  private get recordingsDir(): string {
    return join(this.dataDir, 'recordings');
  }

  private get setting(): Required<Pick<PluginStorageValues, 'retentionDays' | 'quotaGB' | 'minFreePercent' | 'segmentSeconds' | 'postBufferSeconds'>> {
    const v = this.storage.values;
    return {
      retentionDays: this.capRetention(Number(v.retentionDays) || 14),
      quotaGB: Number(v.quotaGB) || 0,
      minFreePercent: Number(v.minFreePercent) || 5,
      segmentSeconds: Number(v.segmentSeconds) || 60,
      postBufferSeconds: Number(v.postBufferSeconds ?? 10),
    };
  }

  private capRetention(days: number): number {
    const max = this.entitlements?.nvr.retentionDays ?? 0;
    return max > 0 ? Math.min(days, max) : days;
  }

  private async refreshEntitlements(): Promise<void> {
    const core = this.api.coreManager as unknown as { getEntitlements?: () => Promise<Entitlements> };
    if (typeof core.getEntitlements !== 'function') return;
    try {
      const next = await core.getEntitlements();
      const changed = JSON.stringify(next) !== JSON.stringify(this.entitlements);
      this.entitlements = next;
      if (changed) {
        this.logger.log(`Plan: ${this.planSummary()}`);
        this.syncAll();
      }
    } catch (error) {
      this.logger.debug(`Entitlements unavailable: ${(error as Error).message}`);
    }
  }

  private planSummary(): string {
    const e = this.entitlements;
    if (!e) return 'без ограничений';
    const cams = e.nvr.maxCameras > 0 ? `до ${e.nvr.maxCameras} камер с записью` : 'запись со всех камер';
    const days = e.nvr.retentionDays > 0 ? `архив до ${e.nvr.retentionDays} дн.` : 'архив без ограничения срока';
    return e.source === 'cloud' ? `ViON Cloud · ${e.plan.name}: ${cams}, ${days}` : `Сервер не привязан к ViON Cloud: ${cams}, ${days}`;
  }

  /** Plan limits and which cameras use the recording slots (settings dashboard). */
  public async getRecordingPlan(): Promise<{
    source: 'cloud' | 'local' | 'none';
    planName: string;
    maxCameras: number;
    retentionDays: number;
    recording: string[];
    overLimit: string[];
  }> {
    await this.ready;
    const e = this.entitlements;
    const licensed = this.licensedCameraIds();
    const wanting = [...this.cameras.values()].filter((c) => isRecordingWanted(c.device)).map((c) => c.device.id);
    return {
      source: e?.source ?? 'none',
      planName: e?.plan.name ?? '',
      maxCameras: e?.nvr.maxCameras ?? 0,
      retentionDays: e?.nvr.retentionDays ?? 0,
      recording: wanting.filter((id) => licensed.has(id)),
      overLimit: wanting.filter((id) => !licensed.has(id)),
    };
  }

  /** Cameras allowed to record: the first `maxCameras` in the order recording was enabled (persisted). */
  private licensedCameraIds(): Set<string> {
    const wanting = [...this.cameras.values()].filter((c) => isRecordingWanted(c.device)).map((c) => c.device.id);
    const order = (JSON.parse(this.store.meta('record_order') ?? '[]') as string[]).filter((id) => wanting.includes(id));
    for (const id of wanting) if (!order.includes(id)) order.push(id);
    this.store.setMeta('record_order', JSON.stringify(order));
    const max = this.entitlements?.nvr.maxCameras ?? 0;
    return new Set(max > 0 ? order.slice(0, max) : order);
  }

  private syncAll(): void {
    for (const managed of this.cameras.values()) this.syncRecorders(managed);
  }

  private init(): void {
    mkdirSync(this.recordingsDir, { recursive: true });
    this.store = new Store(join(this.dataDir, 'nvr.db'));
    this.instanceId = this.store.meta('instance_id') ?? randomUUID();
    this.store.setMeta('instance_id', this.instanceId);
    const stale = this.store.closeStaleActive();
    if (stale) this.logger.log(`Закрыто событий, оставшихся активными после перезапуска: ${stale}`);
    this.playback = new PlaybackManager(this.store, (id) => [...this.cameras.values()].some((c) => [...c.recorders.values()].some((r) => r.liveSegmentId === id)));
    this.ffmpegPath = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
    // the host's bundled ffmpeg (fallback input and exports); never block startup on it
    void Promise.race([this.api.coreManager.getFFmpegPath(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000))])
      .then((path) => {
        if (path) {
          this.ffmpegPath = path;
          for (const c of this.cameras.values()) for (const r of c.recorders.values()) r.update({ ffmpegPath: path });
        }
      })
      .catch(() => undefined);
    this.markReady();
  }

  private async start(): Promise<void> {
    void this.refreshEntitlements();
    this.entitlementsTimer = setInterval(() => void this.refreshEntitlements(), ENTITLEMENTS_INTERVAL_MS);
    this.retentionTimer = setInterval(() => void this.enforceRetention(), RETENTION_INTERVAL_MS);
    void this.enforceRetention();
    this.logger.log(`ViON NVR ready (ffmpeg: ${this.ffmpegPath})`);
  }

  private async stop(): Promise<void> {
    clearInterval(this.retentionTimer);
    clearInterval(this.entitlementsTimer);
    this.playback?.stopAll();
    await Promise.all([...this.cameras.keys()].map((id) => this.releaseCamera(id)));
    this.store?.close();
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.onCameraAdded(camera);
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.ready;
    await this.releaseCamera(camera.id);
    const managed: ManagedCamera = { device: camera, recorders: new Map(), subscriptions: [] };
    this.cameras.set(camera.id, managed);
    managed.subscriptions.push(camera.onPropertyChange(['recordingSettings', 'sources', 'disabled'] as never).subscribe(() => this.syncAll()));
    this.syncRecorders(managed);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    await this.releaseCamera(cameraId);
    this.syncAll();
  }

  private async releaseCamera(cameraId: string): Promise<void> {
    const managed = this.cameras.get(cameraId);
    if (!managed) return;
    this.cameras.delete(cameraId);
    for (const s of managed.subscriptions) s.dispose();
    await Promise.all([...managed.recorders.values()].map((r) => r.stop()));
  }

  private syncRecorders(managed: ManagedCamera): void {
    const { device } = managed;
    const rs = device.recordingSettings;
    const disabled = (device as unknown as { disabled?: boolean }).disabled === true;
    const wanted = new Map<Role, { rtspUrl: string; tsUrl?: string }>();
    const licensed = !isRecordingWanted(device) || this.licensedCameraIds().has(device.id);
    if (!licensed && !managed.overLimit) {
      this.pushSystemEvent({
        type: 'license',
        severity: 'warning',
        cameraId: device.id,
        message: `Запись «${device.name}» не ведётся: лимит тарифа (${this.planSummary()})`,
      });
    }
    managed.overLimit = !licensed;
    if (licensed && rs?.enabled && !disabled && (rs.mode === 'continuous' || rs.mode === 'event')) {
      const roles: Role[] = rs.sources?.length ? rs.sources : ['high'];
      for (const role of roles) {
        const source = role === 'high' ? (device.highResolutionSource ?? device.streamSource) : role === 'mid' ? device.midResolutionSource : device.lowResolutionSource;
        if (source) wanted.set(role, { rtspUrl: source.generateRTSPUrl({ video: true, audio: false, timeout: 15 }), tsUrl: go2rtcTsUrl(source.urls?.snapshot?.jpeg) });
      }
    }

    for (const [role, rec] of managed.recorders) {
      if (!wanted.has(role)) {
        void rec.stop();
        managed.recorders.delete(role);
      }
    }
    const s = this.setting;
    for (const [role, { rtspUrl, tsUrl }] of wanted) {
      const common = {
        mode: rs.mode as 'continuous' | 'event',
        preBufferSec: Math.min(60, Math.max(0, Number(rs.preBuffer) || 0)),
        postBufferSec: s.postBufferSeconds,
        segmentSec: s.segmentSeconds,
      };
      const existing = managed.recorders.get(role);
      if (existing) {
        existing.update({ rtspUrl, tsUrl, ...common });
        continue;
      }
      const rec = new Recorder({
        cameraId: device.id,
        role,
        rtspUrl,
        tsUrl,
        ffmpegPath: this.ffmpegPath,
        dir: join(this.recordingsDir, device.id),
        store: this.store,
        ...common,
        log: (level, message) => {
          this.logger[level](message);
          if (level === 'warn' || level === 'error')
            this.pushSystemEvent({ type: 'stream', severity: level === 'error' ? 'error' : 'warning', cameraId: device.id, message });
        },
        onStateChange: (recording) => this.emitRecordingState(device.id, recording),
        onSegment: () => undefined,
      });
      managed.recorders.set(role, rec);
      if (!this.paused) rec.start();
    }
  }

  // ------------------------------------------------------------- detections

  /** Called by the server's frame worker for every detection event update. */
  public async ingestDetectionEvent(cameraId: string, type: DetectionEventType, event: RecordedEvent, attachments?: EventAttachments): Promise<void> {
    await this.ready;
    const existingRow = this.store.event(event.id);
    const merged = existingRow ? mergeEvent(JSON.parse(existingRow.data) as RecordedEvent, event) : { ...event, cameraId };
    this.store.upsertEvent(merged);
    if (attachments) await this.saveAttachments(cameraId, merged, attachments);

    // event-mode recorders run until the post-buffer after the last update
    const managed = this.cameras.get(cameraId);
    if (managed) {
      const untilUs = (Date.now() + this.setting.postBufferSeconds * 1000) * 1000;
      for (const rec of managed.recorders.values()) rec.trigger(type === 'end' ? untilUs : untilUs + 30_000_000);
    }

    const data = this.decorate(merged, existingRow?.favorite === 1, true);
    for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type, data });
  }

  private async saveAttachments(cameraId: string, event: RecordedEvent, att: EventAttachments): Promise<void> {
    const dir = this.thumbDir(cameraId, event.id);
    mkdirSync(dir, { recursive: true });
    const seg = event.segmentIndex ?? Math.max(0, event.segments.length - 1);
    const writes: Promise<void>[] = [];
    if (att.scene) writes.push(writeFile(join(dir, 'event.jpg'), att.scene));
    if (att.strip) writes.push(writeFile(join(dir, `strip-${seg}.jpg`), att.strip));
    if (att.card) writes.push(writeFile(join(dir, `card-${seg}.jpg`), att.card));
    for (const [key, data] of Object.entries(att.attributes ?? {})) {
      if (data instanceof Uint8Array) writes.push(writeFile(join(dir, `attr-${key.replace(/[^\w.-]/g, '_')}.jpg`), data));
    }
    await Promise.all(writes);
  }

  private thumbDir(cameraId: string, eventId: string): string {
    return join(this.dataDir, 'thumbs', cameraId.replace(/[^\w-]/g, '_'), eventId.replace(/[^\w-]/g, '_'));
  }

  // ------------------------------------------------------------------ events

  public async getEvents(opts: GetEventsOptions = {}): Promise<{ events: RecordedEvent[]; hasMore: boolean }> {
    return this.queryEvents(undefined, opts);
  }

  public async getCameraEvents(cameraIds: string[], opts: GetEventsOptions = {}): Promise<{ events: RecordedEvent[]; hasMore: boolean }> {
    return this.queryEvents(cameraIds, opts);
  }

  private async queryEvents(cameraIds: string[] | undefined, opts: GetEventsOptions): Promise<{ events: RecordedEvent[]; hasMore: boolean }> {
    await this.ready;
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 500);
    const out: RecordedEvent[] = [];
    let before = opts.before;
    // filters that SQL can't express are applied here; fetch in pages until the page is full
    for (let round = 0; round < 20 && out.length <= limit; round++) {
      const rows = this.store.events({
        cameraIds,
        startMs: opts.startMs ?? opts.startedSinceMs,
        endMs: opts.endMs,
        before,
        favoritesOnly: opts.favoritesOnly,
        state: opts.state,
        limit: limit * 2 + 1,
      });
      for (const row of rows) {
        const ev = this.decorate(JSON.parse(row.data) as RecordedEvent, row.favorite === 1, opts.withRecordingInfo ?? opts.hasRecording);
        if (matches(ev, opts)) out.push(ev);
      }
      if (rows.length < limit * 2 + 1) break;
      before = rows.at(-1)!.start_ms;
    }
    return { events: out.slice(0, limit), hasMore: out.length > limit };
  }

  public async getEventStats(
    cameraIds: string[],
    opts: GetEventsOptions = {},
  ): Promise<{ total: number; episodes: number; byType: Record<string, number>; capped: boolean }> {
    const CAP = 5000;
    const { events } = await this.queryEvents(cameraIds?.length ? cameraIds : undefined, { ...opts, limit: 500 });
    const byType: Record<string, number> = {};
    for (const ev of events) for (const t of ev.types ?? []) byType[t] = (byType[t] ?? 0) + 1;
    return { total: events.length, episodes: 0, byType, capped: events.length >= CAP };
  }

  public async getEventThumbnails(
    cameraId: string,
    _startMs: number,
    eventId: string,
  ): Promise<{ event?: Uint8Array; strips?: Record<string, Uint8Array>; cards?: Record<string, Uint8Array>; attributes?: Record<string, Uint8Array> }> {
    const dir = this.thumbDir(cameraId, eventId);
    if (!existsSync(dir)) return {};
    const result: { event?: Uint8Array; strips: Record<string, Uint8Array>; cards: Record<string, Uint8Array>; attributes: Record<string, Uint8Array> } = {
      strips: {},
      cards: {},
      attributes: {},
    };
    for (const file of await readdir(dir)) {
      const data = new Uint8Array(await readFile(join(dir, file)));
      const name = file.replace(/\.jpg$/, '');
      if (name === 'event') result.event = data;
      else if (name.startsWith('strip-')) result.strips[name.slice(6)] = data;
      else if (name.startsWith('card-')) result.cards[name.slice(5)] = data;
      else if (name.startsWith('attr-')) result.attributes[name.slice(5)] = data;
    }
    return result;
  }

  public async deleteEvents(eventIds: string[]): Promise<void> {
    await this.ready;
    const deleted: string[] = [];
    for (const id of eventIds) {
      const row = this.store.event(id);
      if (!row) continue;
      this.store.deleteEvent(id);
      await rm(this.thumbDir(row.camera_id, id), { recursive: true, force: true });
      deleted.push(id);
    }
    if (deleted.length) for (const cb of this.deletedListeners) this.safeCall(this.deletedListeners, cb, deleted);
  }

  public async setEventFavorite(eventId: string, favorite: boolean): Promise<void> {
    await this.ready;
    this.store.setFavorite(eventId, favorite);
  }

  public async onDetectionEvent(callback: (message: DetectionEventMessage) => void): Promise<Unsubscribe> {
    return this.subscribe(this.detectionListeners, callback);
  }

  public async onEventsDeleted(callback: (ids: string[]) => void): Promise<Unsubscribe> {
    return this.subscribe(this.deletedListeners, callback);
  }

  public async getDetectionHeatmap(
    cameraId: string,
    startMs: number,
    endMs: number,
  ): Promise<{ points: { x: number; y: number; w?: number }[]; count: number; showThumbnail: boolean; isTriggerOnly: boolean }> {
    await this.ready;
    const points: { x: number; y: number; w?: number }[] = [];
    let count = 0;
    for (const row of this.store.events({ cameraIds: [cameraId], startMs, endMs, limit: 2000 })) {
      const ev = JSON.parse(row.data) as RecordedEvent;
      count++;
      for (const seg of ev.segments ?? []) {
        for (const det of seg.detections ?? []) {
          const box = det.box as { x: number; y: number; width: number; height: number } | undefined;
          if (box) points.push({ x: box.x + box.width / 2, y: box.y + box.height, w: 1 });
        }
      }
    }
    return { points, count, showThumbnail: true, isTriggerOnly: points.length === 0 };
  }

  // ------------------------------------------------------ recordings/timeline

  public async getManagedCameraIds(): Promise<string[]> {
    return [...this.cameras.keys()];
  }

  public async getInstanceId(): Promise<string> {
    await this.ready;
    return this.instanceId;
  }

  public async getRecordingSegments(cameraId: string, startMs: number, endMs: number): Promise<RecordingSegment[]> {
    await this.ready;
    return this.merged(cameraId, this.primaryRole(cameraId), startMs, endMs);
  }

  public async getRecordingCoverage(cameraId: string, startMs: number, endMs: number): Promise<{ roles: Record<string, RecordingSegment[]>; union: RecordingSegment[] }> {
    await this.ready;
    const roles: Record<string, RecordingSegment[]> = {};
    for (const role of ['high', 'mid', 'low']) {
      const segs = this.merged(cameraId, role, startMs, endMs);
      if (segs.length) roles[role] = segs;
    }
    return { roles, union: mergeRanges(Object.values(roles).flat()) };
  }

  public async getRecordingDays(cameraId: string, year: number, month: number): Promise<string[]> {
    await this.ready;
    const from = new Date(year, month - 1, 1).getTime() * 1000;
    const to = new Date(year, month, 1).getTime() * 1000;
    const days = new Set<string>();
    const bounds = this.store.recordingDays(cameraId, from, to);
    for (let i = 0; i < bounds.length; i += 2) {
      for (let t = Math.max(bounds[i], from); t <= Math.min(bounds[i + 1], to - 1); t += 3600_000_000) days.add(localDay(t / 1000));
      days.add(localDay(Math.min(bounds[i + 1], to - 1) / 1000));
    }
    return [...days].filter((d) => d.startsWith(`${year}-${String(month).padStart(2, '0')}`)).sort();
  }

  public async onRecordingState(cameraId: string, callback: (s: RecordingState) => void): Promise<Unsubscribe> {
    let set = this.stateListeners.get(cameraId);
    if (!set) this.stateListeners.set(cameraId, (set = new Set()));
    const unsub = this.subscribe(set, callback);
    const recording = [...(this.cameras.get(cameraId)?.recorders.values() ?? [])].some((r) => r.isRecording);
    this.safeCall(set, callback, { cameraId, state: recording ? 'recording' : 'stopped', timestamp: Date.now() });
    return unsub;
  }

  public async onRecordingsDeleted(callback: (e: RecordingsDeletedEvent) => void): Promise<Unsubscribe> {
    return this.subscribe(this.recordingsDeletedListeners, callback);
  }

  public async nvrDeleteRange(cameraId: string, startUs: number, endUs: number): Promise<RecordingsDeletedEvent> {
    await this.ready;
    const limit = Date.now() * 1000 - PROTECTED_TAIL_US;
    let minUs = Infinity;
    let maxUs = -Infinity;
    for (const role of ['high', 'mid', 'low']) {
      for (const seg of this.store.segments(cameraId, role, startUs, Math.min(endUs, limit))) {
        if (seg.start_us >= startUs && seg.end_us <= endUs && seg.end_us <= limit) {
          await rm(seg.path, { force: true });
          this.store.deleteSegment(seg.id);
          minUs = Math.min(minUs, seg.start_us);
          maxUs = Math.max(maxUs, seg.end_us);
        }
      }
    }
    const result = Number.isFinite(minUs) ? { cameraId, startMs: Math.round(minUs / 1000), endMs: Math.round(maxUs / 1000) } : { cameraId, startMs: 0, endMs: 0 };
    if (result.endMs) for (const cb of this.recordingsDeletedListeners) this.safeCall(this.recordingsDeletedListeners, cb, result);
    return result;
  }

  public async getSystemEvents(
    cameraIds: string[],
    opts: { startMs?: number; endMs?: number; limit?: number } = {},
  ): Promise<{ events: SystemEvent[]; hasMore: boolean }> {
    const limit = opts.limit ?? 100;
    const filtered = this.systemEvents.filter(
      (e) =>
        (!cameraIds?.length || !e.cameraId || cameraIds.includes(e.cameraId)) &&
        (opts.startMs === undefined || e.timestamp >= opts.startMs) &&
        (opts.endMs === undefined || e.timestamp <= opts.endMs),
    );
    return { events: filtered.slice(-limit).reverse(), hasMore: filtered.length > limit };
  }

  public async onSystemEvent(callback: (e: SystemEvent) => void): Promise<Unsubscribe> {
    return this.subscribe(this.systemListeners, callback);
  }

  // ---------------------------------------------------------------- playback

  public nvrPlayback(cameraId: string, tsUs: number, _videoOnly: boolean, sourceRole: string, callbacks: NvrPlaybackCallbacks): AsyncGenerator<void> {
    return this.playback.play(cameraId, tsUs, this.resolveRole(cameraId, sourceRole), callbacks);
  }

  public async nvrPlaybackCmd(sessionId: string, cmd: { cmd: 'pause' | 'resume' | 'speed'; speed?: number }): Promise<void> {
    this.playback.command(sessionId, cmd);
  }

  public async nvrScrub(
    cameraId: string,
    tsUs: number,
    fine?: boolean,
    sourceRole?: string,
  ): Promise<{ frame?: Uint8Array; ts: number; videoCodec: string; noData?: boolean; codecString?: string; width?: number; height?: number; frames?: NvrFrame[] }> {
    await this.ready;
    const role = this.resolveRole(cameraId, sourceRole);
    const seg = this.store.segmentAt(cameraId, role, tsUs);
    if (!seg || seg.start_us > tsUs + 2_000_000) return { ts: tsUs, videoCodec: '', noData: true };
    const kf = keyframeAtOrBefore(seg, tsUs);
    if (!kf) return { ts: tsUs, videoCodec: '', noData: true };
    const meta = { videoCodec: seg.codec, codecString: seg.codec_string, width: seg.width, height: seg.height };
    if (fine) {
      const gop = await readGop(seg, kf, tsUs);
      if (!gop.length) return { ts: tsUs, videoCodec: '', noData: true };
      return { ...meta, ts: gop.at(-1)!.tsUs, frame: gop[0].data, frames: gop.map((f) => ({ frame: f.data, ts: f.tsUs, keyframe: f.keyframe })) };
    }
    const frame = await readKeyframe(seg, kf);
    return frame ? { ...meta, ts: frame.tsUs, frame: frame.data } : { ts: tsUs, videoCodec: '', noData: true };
  }

  public async nvrPreviewFrames(
    cameraId: string,
    startUs: number,
    endUs: number,
    count = 12,
  ): Promise<{ frames: NvrFrame[]; videoCodec: string; codecString?: string; width?: number; height?: number; noData?: boolean }> {
    await this.ready;
    const role = this.resolveRole(cameraId, 'low');
    const frames: NvrFrame[] = [];
    let meta: { videoCodec: string; codecString: string; width: number; height: number } | undefined;
    const seen = new Set<string>();
    const n = Math.max(1, Math.min(count, 60));
    for (let i = 0; i < n; i++) {
      const t = startUs + ((endUs - startUs) * i) / Math.max(1, n - 1);
      const seg = this.store.segmentAt(cameraId, role, t);
      if (!seg || seg.start_us > t) continue;
      const kf = keyframeAtOrBefore(seg, t);
      if (!kf || seen.has(`${seg.id}:${kf.offset}`)) continue;
      seen.add(`${seg.id}:${kf.offset}`);
      const frame = await readKeyframe(seg, kf);
      if (!frame) continue;
      meta ??= { videoCodec: seg.codec, codecString: seg.codec_string, width: seg.width, height: seg.height };
      frames.push({ frame: frame.data, ts: frame.tsUs, keyframe: true });
    }
    return meta ? { ...meta, frames } : { frames: [], videoCodec: '', noData: true };
  }

  public async nvrTraceFrames(): Promise<{ chains: never[]; noData: boolean }> {
    return { chains: [], noData: true };
  }

  // ------------------------------------------------------------------ export

  public async nvrExport(
    cameraId: string,
    startUs: number,
    endUs: number,
    options: { timelapseIntervalSec?: number; sourceRole?: string } = {},
  ): Promise<{ url: string; filename: string; size: number; durationMs: number }> {
    await this.ready;
    const role = this.resolveRole(cameraId, options.sourceRole);
    const filename = `${this.cameraSlug(cameraId)}_${fileStamp(startUs)}.mp4`;
    const res = await exportClip({
      ffmpegPath: this.ffmpegPath,
      segments: this.store.segments(cameraId, role, startUs, endUs),
      startUs,
      endUs,
      outDir: join(this.dataDir, 'exports'),
      filename,
      timelapseIntervalSec: options.timelapseIntervalSec,
    });
    const dl = await this.api.downloadManager.createDownload({ filePath: res.path, filename, mimeType: 'video/mp4', ttlMs: 3 * 3600_000, cleanup: 'on-expiry' });
    return { url: dl.url, filename, size: res.size, durationMs: res.durationMs };
  }

  public async nvrExportEstimate(request: {
    cameras: string[];
    slices: { day: string; startUs: number; endUs: number }[];
  }): Promise<{ files: { cameraId: string; day: string; startUs: number; endUs: number; bytes: number }[]; totalBytes: number; durationMs: number }> {
    await this.ready;
    const files: { cameraId: string; day: string; startUs: number; endUs: number; bytes: number }[] = [];
    let durationMs = 0;
    for (const cameraId of request.cameras) {
      const role = this.primaryRole(cameraId);
      for (const slice of request.slices) {
        let bytes = 0;
        for (const seg of this.store.segments(cameraId, role, slice.startUs, slice.endUs)) {
          const span = Math.max(1, seg.end_us - seg.start_us);
          const overlap = Math.max(0, Math.min(seg.end_us, slice.endUs) - Math.max(seg.start_us, slice.startUs));
          bytes += Math.round((seg.bytes * overlap) / span);
          durationMs += overlap / 1000;
        }
        if (bytes > 0) files.push({ cameraId, day: slice.day, startUs: slice.startUs, endUs: slice.endUs, bytes });
      }
    }
    return { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0), durationMs: Math.round(durationMs) };
  }

  public async nvrExportBatch(request: {
    cameras: string[];
    slices: { day: string; startUs: number; endUs: number }[];
    timelapseIntervalSec?: number;
  }): Promise<{ url: string; filename: string }> {
    await this.ready;
    const outDir = join(this.dataDir, 'exports', randomUUID());
    const parts: { path: string; name: string }[] = [];
    for (const cameraId of request.cameras) {
      for (const slice of request.slices) {
        const segments = this.store.segments(cameraId, this.primaryRole(cameraId), slice.startUs, slice.endUs);
        if (!segments.length) continue;
        const name = `${this.cameraSlug(cameraId)}_${fileStamp(slice.startUs)}.mp4`;
        const res = await exportClip({
          ffmpegPath: this.ffmpegPath,
          segments,
          startUs: slice.startUs,
          endUs: slice.endUs,
          outDir,
          filename: name,
          timelapseIntervalSec: request.timelapseIntervalSec,
        });
        parts.push({ path: res.path, name });
      }
    }
    if (!parts.length) throw new Error('No recordings in the selected range');
    if (parts.length === 1) {
      const dl = await this.api.downloadManager.createDownload({
        filePath: parts[0].path,
        filename: parts[0].name,
        mimeType: 'video/mp4',
        ttlMs: 3 * 3600_000,
        cleanup: 'on-expiry',
      });
      return { url: dl.url, filename: parts[0].name };
    }
    const filename = `vion-export_${fileStamp(Date.now() * 1000)}.zip`;
    const zipPath = join(outDir, filename);
    await writeZip(zipPath, parts);
    await Promise.all(parts.map((p) => rm(p.path, { force: true })));
    const dl = await this.api.downloadManager.createDownload({ filePath: zipPath, filename, mimeType: 'application/zip', ttlMs: 3 * 3600_000, cleanup: 'on-expiry' });
    return { url: dl.url, filename };
  }

  // ----------------------------------------------------------------- storage

  public async getStorageStats(): Promise<StorageStats> {
    await this.ready;
    const fs = await statfs(this.recordingsDir);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const GB = 1024 ** 3;
    const s = this.setting;
    const cameras: StorageStats['cameras'] = {};
    for (const row of this.store.cameraStats()) {
      const hours = Math.max(1 / 60, (row.newest - row.oldest) / 3.6e9);
      const managed = this.cameras.get(row.camera_id);
      const recorders = [...(managed?.recorders.values() ?? [])];
      const oldestDay = localDay(row.oldest / 1000);
      const newestDay = localDay(row.newest / 1000);
      cameras[row.camera_id] = {
        usedBytes: row.bytes,
        segmentCount: row.count,
        oldestDay,
        newestDay,
        daysCount: Math.max(1, Math.round((new Date(newestDay).getTime() - new Date(oldestDay).getTime()) / 86_400_000) + 1),
        bandwidthMBh: Math.round((row.bytes / 1024 ** 2 / hours) * 10) / 10,
        recordingMode: managed?.device.recordingSettings?.mode ?? 'off',
        isRecording: recorders.some((r) => r.isRecording),
      };
    }
    for (const [id, managed] of this.cameras) {
      cameras[id] ??= {
        usedBytes: 0,
        segmentCount: 0,
        oldestDay: '',
        newestDay: '',
        daysCount: 0,
        bandwidthMBh: 0,
        recordingMode: managed.device.recordingSettings?.mode ?? 'off',
        isRecording: [...managed.recorders.values()].some((r) => r.isRecording),
      };
    }
    return {
      diskTotalGB: round2(total / GB),
      diskUsedGB: round2((total - free) / GB),
      diskFreeGB: round2(free / GB),
      diskFreePercent: total ? round2((free / total) * 100) : 0,
      nvrUsedGB: round2(this.store.totalBytes() / GB),
      nvrQuotaGB: s.quotaGB,
      retentionDays: s.retentionDays,
      smallVolume: total > 0 && total < 32 * GB,
      paused: this.paused,
      cameras,
    };
  }

  private async enforceRetention(): Promise<void> {
    if (!this.store) return;
    try {
      const s = this.setting;
      const cutoffUs = (Date.now() - s.retentionDays * 86_400_000) * 1000;
      let removed = 0;
      for (let batch = this.store.segmentsBefore(cutoffUs, 200); batch.length; batch = this.store.segmentsBefore(cutoffUs, 200)) {
        for (const seg of batch) {
          await rm(seg.path, { force: true });
          this.store.deleteSegment(seg.id);
          removed++;
        }
      }

      // quota and free-space guard: drop the oldest files first
      const GB = 1024 ** 3;
      for (let guard = 0; guard < 10_000; guard++) {
        const fs = await statfs(this.recordingsDir);
        const freePct = (fs.bavail / fs.blocks) * 100;
        const overQuota = s.quotaGB > 0 && this.store.totalBytes() > s.quotaGB * GB;
        if (!overQuota && freePct >= s.minFreePercent) break;
        const [oldest] = this.store.oldestSegments(1);
        if (!oldest || this.isLiveSegment(oldest.id)) {
          if (freePct < Math.max(1, s.minFreePercent / 3) && !this.paused) {
            this.paused = true;
            this.pushSystemEvent({ type: 'storage', severity: 'error', message: 'Недостаточно места на диске: запись приостановлена' });
            for (const c of this.cameras.values()) for (const r of c.recorders.values()) await r.stop();
          }
          break;
        }
        await rm(oldest.path, { force: true });
        this.store.deleteSegment(oldest.id);
        removed++;
      }
      if (this.paused) {
        const fs = await statfs(this.recordingsDir);
        if ((fs.bavail / fs.blocks) * 100 >= s.minFreePercent) {
          this.paused = false;
          this.pushSystemEvent({ type: 'storage', severity: 'success', message: 'Место на диске освободилось: запись возобновлена' });
          for (const c of this.cameras.values()) for (const r of c.recorders.values()) r.start();
        }
      }

      // events and their thumbnails follow the same retention (favorites are kept)
      const expired: EventRow[] = this.store.eventsBefore(Date.now() - s.retentionDays * 86_400_000, 1000);
      for (const row of expired) {
        this.store.deleteEvent(row.id);
        await rm(this.thumbDir(row.camera_id, row.id), { recursive: true, force: true });
      }
      if (expired.length)
        for (const cb of this.deletedListeners)
          this.safeCall(
            this.deletedListeners,
            cb,
            expired.map((e) => e.id),
          );
      if (removed) this.logger.debug(`Retention removed ${removed} segment(s)`);
    } catch (error) {
      this.logger.warn(`Retention failed: ${(error as Error).message}`);
    }
  }

  // --------------------------------------------- not implemented yet (stubs)

  public async getEpisodes(): Promise<{ episodes: never[]; hasMore: boolean }> {
    return { episodes: [], hasMore: false };
  }

  public async getEpisodeMosaic(): Promise<undefined> {
    return undefined;
  }

  public async getEpisodeTrace(): Promise<null> {
    return null;
  }

  public async getEpisodeTraceImages(): Promise<never[]> {
    return [];
  }

  public async setEpisodeFavorite(): Promise<void> {}

  public async nvrExportEpisode(): Promise<never> {
    throw new Error('Episodes are not supported yet');
  }

  public async getEventTrace(eventId: string): Promise<{ eventId: string; offset: number; total: number; exact: boolean; episodes: never[]; hasMore: boolean }> {
    return { eventId, offset: 0, total: 0, exact: true, episodes: [], hasMore: false };
  }

  public async getEventTraceOffset(): Promise<number> {
    return 0;
  }

  public async matchFaces(embeddings: number[][]): Promise<null[]> {
    return embeddings.map(() => null);
  }

  public async listKnownFaces(): Promise<never[]> {
    return [];
  }

  public async getUnknownFaces(): Promise<never[]> {
    return [];
  }

  public async listUnknownFaceMeta(): Promise<never[]> {
    return [];
  }

  public async listIgnoredFaces(): Promise<never[]> {
    return [];
  }

  public async listIgnoredFaceMeta(): Promise<never[]> {
    return [];
  }

  public async getUnknownFaceThumbnails(): Promise<Record<string, Uint8Array>> {
    return {};
  }

  public async getIgnoredFaceThumbnails(): Promise<Record<string, Uint8Array>> {
    return {};
  }

  public async getFaceImages(): Promise<never[]> {
    return [];
  }

  public async reassignEventFace(): Promise<number> {
    return 0;
  }

  public async getFacesRescanStatus(): Promise<{ running: boolean; total: number; done: number }> {
    return { running: false, total: 0, done: 0 };
  }

  public async getFacesReindexStatus(): Promise<{ running: boolean; total: number; done: number; skipped: number }> {
    return { running: false, total: 0, done: 0, skipped: 0 };
  }

  public async getClipReindexStatus(): Promise<{ running: boolean; total: number; done: number; skipped: number }> {
    return { running: false, total: 0, done: 0, skipped: 0 };
  }

  public async searchEventsByText(): Promise<never[]> {
    return [];
  }

  public async onFacesRescan(): Promise<Unsubscribe> {
    return () => undefined;
  }

  public async onFacesReindex(): Promise<Unsubscribe> {
    return () => undefined;
  }

  public async onClipReindex(): Promise<Unsubscribe> {
    return () => undefined;
  }

  // ----------------------------------------------------------------- helpers

  private isLiveSegment(id: number): boolean {
    return [...this.cameras.values()].some((c) => [...c.recorders.values()].some((r) => r.liveSegmentId === id));
  }

  private primaryRole(cameraId: string): string {
    const roles = [...(this.cameras.get(cameraId)?.recorders.keys() ?? [])];
    return roles.includes('high') ? 'high' : (roles[0] ?? 'high');
  }

  /** Maps a requested role to one that has recordings (scrub/preview prefer the lightest stream). */
  private resolveRole(cameraId: string, requested?: string): string {
    const roles = [...(this.cameras.get(cameraId)?.recorders.keys() ?? [])] as string[];
    if (requested && roles.includes(requested)) return requested;
    if (requested === 'scrub' || requested === 'low') return roles.includes('low') ? 'low' : roles.includes('mid') ? 'mid' : this.primaryRole(cameraId);
    return this.primaryRole(cameraId);
  }

  private merged(cameraId: string, role: string, startMs: number, endMs: number): RecordingSegment[] {
    const live = new Set([...(this.cameras.get(cameraId)?.recorders.values() ?? [])].map((r) => r.liveSegmentId).filter((v): v is number => v !== undefined));
    const out: RecordingSegment[] = [];
    for (const seg of this.store.segments(cameraId, role, startMs * 1000, endMs * 1000)) {
      if (!parseKeyframes(seg.keyframes).length && !live.has(seg.id)) continue;
      const startTime = Math.round(seg.start_us / 1000);
      const endTime = Math.round((live.has(seg.id) ? Math.max(seg.end_us, Date.now() * 1000) : seg.end_us) / 1000);
      const last = out.at(-1);
      if (last && startTime - last.endTime <= MERGE_GAP_US / 1000) {
        last.endTime = Math.max(last.endTime, endTime);
        last.liveTip = live.has(seg.id) || undefined;
      } else {
        out.push({ startTime, endTime, cameraId, ...(live.has(seg.id) ? { liveTip: true } : {}) });
      }
    }
    return out;
  }

  private decorate(event: RecordedEvent, favorite: boolean, withRecording?: boolean): RecordedEvent {
    const ev: RecordedEvent = { ...event, favorite };
    if (withRecording) {
      const role = this.primaryRole(event.cameraId);
      const end = event.endTime ?? Date.now();
      ev.hasRecording = this.store.segments(event.cameraId, role, event.startTime * 1000, end * 1000).length > 0;
    }
    return ev;
  }

  private emitRecordingState(cameraId: string, recording: boolean): void {
    const set = this.stateListeners.get(cameraId);
    if (!set) return;
    const state: RecordingState = { cameraId, state: recording ? 'recording' : 'stopped', timestamp: Date.now() };
    for (const cb of set) this.safeCall(set, cb, state);
  }

  private pushSystemEvent(e: Omit<SystemEvent, 'id' | 'timestamp'>): void {
    const event: SystemEvent = { id: randomUUID(), timestamp: Date.now(), ...e };
    this.systemEvents.push(event);
    if (this.systemEvents.length > MAX_SYSTEM_EVENTS) this.systemEvents.shift();
    for (const cb of this.systemListeners) this.safeCall(this.systemListeners, cb, event);
  }

  private cameraSlug(cameraId: string): string {
    const name = this.cameras.get(cameraId)?.device.name ?? cameraId;
    return name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'camera';
  }

  private subscribe<T>(set: Set<(v: T) => void>, cb: (v: T) => void): Unsubscribe {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Remote callbacks may reject once the client is gone: drop them then. */
  private safeCall<T>(set: Set<(v: T) => void>, cb: (v: T) => void, value: T): void {
    try {
      const res = cb(value) as unknown;
      if (res && typeof (res as Promise<unknown>).catch === 'function') (res as Promise<unknown>).catch(() => set.delete(cb));
    } catch {
      set.delete(cb);
    }
  }
}

function mergeEvent(prev: RecordedEvent, next: RecordedEvent): RecordedEvent {
  const segments = [...(prev.segments ?? [])];
  if (next.segmentIndex !== undefined && next.segments?.length === 1) {
    segments[next.segmentIndex] = next.segments[0]!;
  } else if (next.segments?.length) {
    return { ...prev, ...next, types: [...new Set([...(prev.types ?? []), ...(next.types ?? [])])] };
  }
  return { ...prev, ...next, segments, types: [...new Set([...(prev.types ?? []), ...(next.types ?? [])])] };
}

function matches(ev: RecordedEvent, opts: GetEventsOptions): boolean {
  if (opts.types?.length && !opts.types.some((t) => ev.types?.includes(t) || ev.segments?.some((s) => s.detections?.some((d) => d.label === t)))) return false;
  if (opts.hasDetections && !ev.segments?.some((s) => s.detections?.length)) return false;
  if (opts.hasRecording && !ev.hasRecording) return false;
  if (opts.minConfidence !== undefined && !ev.segments?.some((s) => s.detections?.some((d) => Number(d.score ?? 0) >= opts.minConfidence!))) return false;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    const hay = [
      ...(ev.types ?? []),
      ...(ev.segments ?? []).flatMap((s) => [...(s.detections ?? []).map((d) => String(d.label)), ...(s.attributes ?? []).map((a) => String(a.label))]),
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function mergeRanges(ranges: RecordingSegment[]): RecordingSegment[] {
  const sorted = [...ranges].sort((a, b) => a.startTime - b.startTime);
  const out: RecordingSegment[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.startTime <= last.endTime + MERGE_GAP_US / 1000) {
      last.endTime = Math.max(last.endTime, r.endTime);
      if (r.liveTip) last.liveTip = true;
    } else out.push({ ...r });
  }
  return out;
}

/** go2rtc serves MPEG-TS next to its snapshot endpoint: `/api/frame.jpeg?src=x` -> `/api/stream.ts?src=x&video=all`. */
function go2rtcTsUrl(snapshotUrl: string | undefined): string | undefined {
  if (!snapshotUrl) return undefined;
  try {
    const url = new URL(snapshotUrl);
    const src = url.searchParams.get('src');
    if (!src || !url.pathname.endsWith('/frame.jpeg')) return undefined;
    url.pathname = url.pathname.replace(/frame\.jpeg$/, 'stream.ts');
    url.search = '';
    url.searchParams.set('src', src);
    url.searchParams.set('video', 'all');
    return url.toString();
  } catch {
    return undefined;
  }
}

function isRecordingWanted(device: CameraDevice): boolean {
  const rs = device.recordingSettings;
  const disabled = (device as unknown as { disabled?: boolean }).disabled === true;
  return !!rs?.enabled && !disabled && (rs.mode === 'continuous' || rs.mode === 'event');
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fileStamp(us: number): string {
  const d = new Date(us / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
