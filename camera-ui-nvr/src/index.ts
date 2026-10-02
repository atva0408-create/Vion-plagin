import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, rm, rmdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ASSISTANT_TOOLS, callAssistantTool } from './assistant.js';
import { EventDescriber } from './describer.js';
import { Episodes } from './episodes.js';
import { exportClip, mosaic, writeZip, ZIP_MAX_BYTES, zipTooLarge } from './export.js';
import { FaceStore } from './faces.js';
import { matchesEvent } from './filter.js';
import { PlaybackManager } from './playback.js';
import { keyframeAtOrBefore, readGop, readKeyframe } from './reader.js';
import { Recorder } from './recorder.js';
import { SemanticIndex } from './semantic.js';
import { parseKeyframes, Store } from './store.js';

import type {
  AssistantToolContext,
  AssistantToolResult,
  AssistantToolSpec,
  CameraDevice,
  DetectionEventType,
  DeviceStorage,
  Disposable,
  JsonSchema,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { AssistantHost } from './assistant.js';
import type { EventDescription } from './describer.js';
import type { EpisodeTrace, RecordedEpisode } from './episodes.js';
import type { FaceImageData, FaceMatchResult, FaceProfile, FaceSighting, IgnoredFace, UnknownFace } from './faces.js';
import type { ClipEncoder, ClipReindexStatus, ClipSearchResult, TextEmbedding } from './semantic.js';
import type { EventRow, SegmentRow } from './store.js';
import type {
  DetectionEventMessage,
  EventAttachments,
  EventTrace,
  GetEventsOptions,
  ManualRecording,
  NvrFeatures,
  NvrFrame,
  NvrPlaybackCallbacks,
  PluginStorageValues,
  RecordedEvent,
  RecordingSegment,
  RecordingsDeletedEvent,
  RecordingState,
  StorageStats,
  SystemEvent,
  TraceChain,
  TraceFrameTarget,
  TraceTick,
} from './types.js';

type Unsubscribe = () => void;
type Role = 'high' | 'mid' | 'low';
type ExportQuality = 'best' | 'smallest';

const RETENTION_INTERVAL_MS = 5 * 60_000;
const MERGE_GAP_US = 2_000_000;
/** The writer owns the newest minutes; deleting them is refused. */
const PROTECTED_TAIL_US = 3 * 60_000_000;
const MAX_SYSTEM_EVENTS = 500;
/** Rows one event page may read once it has results (a selective filter scans further for the first one). */
const PAGE_SCAN_ROWS = 20_000;
const STATS_SCAN_ROWS = 100_000;
const STATS_CAP = 5000;
const TRACE_PAGE = 60;
const EPISODE_SWEEP_MS = 60_000;
/** An episode clip starts a little before the camera saw the visit and ends a little after (as in the player). */
const EPISODE_HEAD_MS = 1500;
const EPISODE_TAIL_MS = 2000;
/** A recording started by hand runs this long unless told otherwise, and never longer than the maximum. */
const MANUAL_DEFAULT_MIN = 5;
const MANUAL_MAX_MIN = 120;
/** Keyframes per trace-frames call (thumbnail strip), GOP frames per exact frame. */
const TRACE_MAX_TARGETS = 60;

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
const PLUGIN_CALL_TIMEOUT_MS = 30_000;

interface FaceEmbedder {
  embedFaceImages(images: Uint8Array[], config?: Record<string, unknown>): Promise<({ embedding: number[]; embeddingModel: string; quality?: number } | undefined)[]>;
}

interface FacesReindexStatus {
  running: boolean;
  embeddingModel?: string;
  total: number;
  done: number;
  skipped: number;
  skippedNames?: string[];
  error?: string;
}

interface FacesRescanStatus {
  running: boolean;
  total: number;
  done: number;
  matched?: number;
}

interface FaceAttribute {
  type?: string;
  label?: string;
  confidence?: number;
  embedding?: number[];
  embeddingModel?: string;
  clipEmbedding?: number[];
  clipEmbeddingModel?: string;
}

function withTimeout<T>(promise: Promise<T>, ms = PLUGIN_CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('plugin call timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Thumbnail key the UI expects for an attribute crop: `<seg>:face.<i>`, `<seg>:plate:<text>`, `<seg>:<type>:<label>`. */
function attributeKey(seg: number, index: number, attribute: FaceAttribute | undefined): string {
  if (attribute?.type === 'face') return `${seg}:face.${index}`;
  if (attribute?.type === 'license_plate') return `${seg}:plate:${attribute.label ?? ''}`;
  return `${seg}:${attribute?.type ?? 'attr'}:${attribute?.label ?? index}`;
}

/** Vectors live in their own tables; the stored (and UI-bound) event JSON stays lean. */
function withoutVectors(event: RecordedEvent): RecordedEvent {
  return {
    ...event,
    segments: (event.segments ?? []).map((segment) => ({
      ...segment,
      attributes: (segment.attributes ?? []).map((a) => {
        const { embedding: _e, clipEmbedding: _c, ...rest } = a as FaceAttribute & Record<string, unknown>;
        return rest;
      }),
    })),
  };
}

export default class VionNvr extends BasePlugin<PluginStorageValues> {
  private store!: Store;
  private semantic!: SemanticIndex;
  private faces!: FaceStore;
  private describer!: EventDescriber;
  private episodes!: Episodes;
  private episodeTimer: NodeJS.Timeout | undefined;
  private readonly proxies = new Map<string, unknown>();
  private clipStatus: ClipReindexStatus = { running: false, total: 0, done: 0, skipped: 0 };
  private clipCancel = false;
  private readonly clipListeners = new Set<(s: ClipReindexStatus) => void>();
  private facesReindexStatus: FacesReindexStatus = { running: false, total: 0, done: 0, skipped: 0 };
  private facesReindexCancel = false;
  private readonly facesReindexListeners = new Set<(s: FacesReindexStatus) => void>();
  private rescanStatus: FacesRescanStatus = { running: false, total: 0, done: 0 };
  private readonly rescanListeners = new Set<(s: FacesRescanStatus) => void>();
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

  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly detectionListeners = new Set<(m: DetectionEventMessage) => void>();
  private readonly deletedListeners = new Set<(ids: string[]) => void>();
  private readonly recordingsDeletedListeners = new Set<(e: RecordingsDeletedEvent) => void>();
  private readonly systemListeners = new Set<(e: SystemEvent) => void>();
  private readonly stateListeners = new Map<string, Set<(s: RecordingState) => void>>();
  private readonly systemEvents: SystemEvent[] = [];
  private readonly manual = new Map<string, { startedAt: number; untilMs: number; timer: NodeJS.Timeout }>();
  private readonly manualListeners = new Set<(s: ManualRecording) => void>();
  /** Export folders being filled right now: the cleanup of empty ones leaves them alone. */
  private readonly exporting = new Set<string>();
  /** Time zone names of clients that this server does not know, each reported once. */
  private readonly unknownZones = new Set<string>();

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
        description:
          'Видео и события старше этого срока удаляются автоматически. Избранные события остаются в списке, но их видео тоже удаляется. ' +
          'Не больше срока, который даёт тариф.',
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
        // running recorders keep the length they were built with until they are synced
        onSet: async () => this.syncAll(),
      },
      {
        type: 'boolean',
        key: 'recordAudio',
        title: 'Записывать звук',
        description:
          'Звук с камер сохраняется в архиве и слышен при просмотре и в экспортированном видео. Работает, только если камера ' +
          'отдаёт звук (в её собственных настройках он должен быть включён). Запись со звуком идёт через ffmpeg: он переводит ' +
          'любой звук в AAC. Запись звука регулируется законом: предупредите людей, которых он касается.',
        group: 'Storage',
        defaultValue: false,
        store: true,
        // recorders read the flag when they are built
        onSet: async () => this.syncAll(),
      },
      {
        type: 'boolean',
        key: 'aiDescriptions',
        title: 'Описания событий ИИ',
        description:
          'После каждого события с человеком, транспортом или животным модель ассистента описывает, что произошло ' +
          '(«курьер оставил посылку у двери»). Описания видны в записях и ищутся в «ИИ-поиске». ' +
          'Нужна модель, понимающая картинки (Настройки → Ассистент), и разрешение для ViON NVR.',
        group: 'AI',
        defaultValue: false,
        store: true,
      },
      {
        type: 'boolean',
        key: 'aiNotify',
        title: 'Умные уведомления',
        description:
          'Отправлять описание события уведомлением («Курьер оставил посылку»). ' +
          'Чтобы не получать два уведомления, отключите обычные уведомления о детекции у этих камер.',
        group: 'AI',
        defaultValue: false,
        store: true,
      },
      {
        type: 'number',
        key: 'aiMaxPerHour',
        title: 'Описаний в час, не больше',
        description: 'Ограничение расхода модели: события сверх лимита остаются без описания. 0 — без ограничения.',
        group: 'AI',
        defaultValue: 60,
        minimum: 0,
        maximum: 3600,
        step: 1,
        store: true,
      },
      {
        type: 'string',
        key: 'aiStatus',
        title: 'Модель',
        description: 'Модель ассистента, которой пользуется NVR. Выбирается в Настройки → Ассистент.',
        group: 'AI',
        readonly: true,
        onGet: async () => this.aiStatusText(),
      },
    ];
  }

  private async aiStatusText(): Promise<string> {
    try {
      const access = await this.api.coreManager.assistantAccess();
      if (!access.allowed) return 'Не разрешено: Настройки → Ассистент → разрешите модель для ViON NVR';
      if (access.vision === false) return `${access.model ?? 'модель'}: не понимает картинки — выберите модель с поддержкой изображений`;
      return `${access.model ?? 'модель ассистента'}${access.vision ? ' · картинки: да' : ''}`;
    } catch {
      return 'Модель ассистента недоступна';
    }
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
    this.store = new Store(join(this.dataDir, 'nvr.db'), this.recordingsDir);
    this.instanceId = this.store.meta('instance_id') ?? randomUUID();
    this.store.setMeta('instance_id', this.instanceId);
    this.semantic = new SemanticIndex(this.store.sql);
    this.faces = new FaceStore(this.store.sql, join(this.dataDir, 'faces'));
    this.describer = new EventDescriber(this.store.sql, {
      ask: (request) => this.api.coreManager.assistantAsk(request),
      access: () => this.api.coreManager.assistantAccess(),
      pictures: (event) => this.describePictures(event),
      cameraName: (cameraId) => this.cameras.get(cameraId)?.device.name ?? cameraId,
      settings: () => {
        const v = this.storage.values;
        return { enabled: v.aiDescriptions === true, notify: v.aiNotify === true, maxPerHour: Number(v.aiMaxPerHour ?? 60) };
      },
      save: (eventId, description) => this.saveDescription(eventId, description),
      notify: (event, description, picture) => this.notifyDescription(event, description, picture),
      log: (level, message) => this.logger[level](message),
    });
    const stale = this.store.closeStaleActive();
    if (stale) this.logger.log(`Закрыто событий, оставшихся активными после перезапуска: ${stale}`);
    this.episodes = new Episodes(this.store, { cameraName: (cameraId) => this.cameras.get(cameraId)?.device.name ?? cameraId, newId: () => randomUUID() });
    this.episodes.restore((eventId) => {
      const row = this.store.event(eventId);
      return row ? (JSON.parse(row.data) as RecordedEvent) : undefined;
    });
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
    this.episodeTimer = setInterval(() => this.episodes.sweep(Date.now()), EPISODE_SWEEP_MS);
    void this.enforceRetention();
    this.logger.log(`ViON NVR ready (ffmpeg: ${this.ffmpegPath})`);
  }

  private async stop(): Promise<void> {
    this.describer?.stop();
    clearInterval(this.retentionTimer);
    clearInterval(this.entitlementsTimer);
    clearInterval(this.episodeTimer);
    for (const m of this.manual.values()) clearTimeout(m.timer);
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
    this.endManual(cameraId);
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
    const mode = effectiveMode(rs?.mode);
    if (licensed && rs?.enabled && !disabled && mode) {
      const roles: Role[] = rs.sources?.length ? rs.sources : ['high'];
      for (const role of roles) {
        const source = role === 'high' ? (device.highResolutionSource ?? device.streamSource) : role === 'mid' ? device.midResolutionSource : device.lowResolutionSource;
        if (source)
          wanted.set(role, {
            rtspUrl: source.generateRTSPUrl({ video: true, audio: this.storage.values.recordAudio === true, timeout: 15 }),
            tsUrl: go2rtcTsUrl(source.urls?.snapshot?.jpeg),
          });
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
        mode: mode!,
        preBufferSec: Math.min(60, Math.max(0, Number(rs.preBuffer) || 0)),
        postBufferSec: s.postBufferSeconds,
        segmentSec: s.segmentSeconds,
        audio: this.storage.values.recordAudio === true,
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
        // the camera records while any of its streams does: the low stream dropping must not report «stopped»
        onStateChange: () =>
          this.emitRecordingState(
            device.id,
            [...(this.cameras.get(device.id)?.recorders.values() ?? [])].some((r) => r.isRecording),
          ),
        onSegment: () => undefined,
      });
      const manual = this.manual.get(device.id);
      if (manual) rec.setManual(manual.untilMs * 1000);
      managed.recorders.set(role, rec);
      if (!this.paused) rec.start();
    }
    // recording switched off or to «Постоянно»: a manual recording has nothing left to do
    if (this.manual.has(device.id) && (!managed.recorders.size || mode === 'continuous')) this.endManual(device.id);
  }

  // ------------------------------------------------------------- detections

  /**
   * Called by the server's frame worker for every detection event update. The server does not wait
   * for the previous call, so updates of one event are chained: an "end" arriving while an earlier
   * update still writes its pictures must not be overwritten by that update's stale merge.
   */
  public ingestDetectionEvent(cameraId: string, type: DetectionEventType, event: RecordedEvent, attachments?: EventAttachments): Promise<void> {
    const previous = this.eventChains.get(event.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.ingestNow(cameraId, type, event, attachments));
    this.eventChains.set(event.id, next);
    const cleanup = () => {
      if (this.eventChains.get(event.id) === next) this.eventChains.delete(event.id);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async ingestNow(cameraId: string, type: DetectionEventType, event: RecordedEvent, attachments?: EventAttachments): Promise<void> {
    await this.ready;
    const existingRow = this.store.event(event.id);
    const merged = existingRow ? mergeEvent(JSON.parse(existingRow.data) as RecordedEvent, event) : { ...event, cameraId };
    if (attachments) await this.saveAttachments(cameraId, merged, attachments);
    this.indexEvent(merged, attachments);
    this.store.upsertEvent(withoutVectors(merged));
    if (Array.isArray(attachments?.trace) && attachments.trace.length) this.saveTrace(cameraId, merged.id, attachments.trace);

    // event-mode recorders run until the post-buffer after the last update
    const managed = this.cameras.get(cameraId);
    // «По запросу» records only when started by hand: detections are stored but do not start it
    if (managed && managed.device.recordingSettings?.mode !== 'adhoc') {
      const untilUs = (Date.now() + this.setting.postBufferSeconds * 1000) * 1000;
      for (const rec of managed.recorders.values()) rec.trigger(type === 'end' ? untilUs : untilUs + 30_000_000);
    }

    const data = this.decorate(withoutVectors(merged), existingRow?.favorite === 1, true);
    for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type, data });
    this.offerToEpisodes(data);
    if (type === 'end') this.describer.offer(withoutVectors(merged));
  }

  /** Episodes are a view over the events: a failure there must never lose or delay an event. */
  private offerToEpisodes(event: RecordedEvent): void {
    try {
      const episode = this.episodes.offer(event);
      if (episode) for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type: 'episode', data: event, episode });
    } catch (error) {
      this.logger.warn(`Episodes: ${(error as Error).message}`);
    }
  }

  private async saveAttachments(cameraId: string, event: RecordedEvent, att: EventAttachments): Promise<void> {
    const dir = this.thumbDir(cameraId, event.id);
    mkdirSync(dir, { recursive: true });
    const seg = event.segmentIndex ?? Math.max(0, event.segments.length - 1);
    const writes: Promise<void>[] = [];
    if (att.scene) writes.push(writeFile(join(dir, 'event.jpg'), att.scene));
    if (att.strip) writes.push(writeFile(join(dir, `strip-${seg}.jpg`), att.strip));
    if (att.card) writes.push(writeFile(join(dir, `card-${seg}.jpg`), att.card));
    const attrs = (event.segments[seg]?.attributes ?? []) as FaceAttribute[];
    const crops: [string, unknown][] = Array.isArray(att.attributes)
      ? att.attributes.map((data, i) => [attributeKey(seg, i, attrs[i]), data])
      : Object.entries(att.attributes ?? {});
    for (const [key, data] of crops) {
      if (data instanceof Uint8Array && data.length) writes.push(writeFile(join(dir, `attr-${encodeURIComponent(key)}.jpg`), data));
    }
    await Promise.all(writes);
  }

  /** Trace ticks go to the index; the camera's zones and thresholds are kept once, at the first ticks. */
  private saveTrace(cameraId: string, eventId: string, ticks: TraceTick[]): void {
    try {
      const first = this.store.traceCount(eventId) === 0;
      this.store.addTrace(
        eventId,
        ticks.filter((t) => Number.isFinite(Number(t?.tMs))),
      );
      const device = this.cameras.get(cameraId)?.device;
      if (first && device) {
        const dir = this.thumbDir(cameraId, eventId);
        mkdirSync(dir, { recursive: true });
        const config = { zones: device.zones, objectConfidences: device.detectionSettings?.object?.confidences };
        void writeFile(join(dir, 'trace-config.json'), JSON.stringify(config)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Trace: ${(error as Error).message}`);
    }
  }

  private thumbDir(cameraId: string, eventId: string): string {
    return join(this.dataDir, 'thumbs', cameraId.replace(/[^\w-]/g, '_'), eventId.replace(/[^\w-]/g, '_'));
  }

  // ------------------------------------------------------------------ events

  public async getEvents(opts: GetEventsOptions = {}): Promise<{ events: RecordedEvent[]; hasMore: boolean }> {
    await this.ready;
    return this.queryEvents(undefined, opts, pageLimit(opts.limit), PAGE_SCAN_ROWS);
  }

  public async getCameraEvents(cameraIds: string[], opts: GetEventsOptions = {}): Promise<{ events: RecordedEvent[]; hasMore: boolean }> {
    await this.ready;
    return this.queryEvents(cameraIds, opts, pageLimit(opts.limit), PAGE_SCAN_ROWS);
  }

  /**
   * One event by its id, as `getEvents` lists it when asked for the recording info; `undefined` when there is none
   * (never recorded, deleted, past the retention). A report of the assistant names an event by its id alone.
   */
  public async getEvent(eventId: string): Promise<RecordedEvent | undefined> {
    await this.ready;
    const row = typeof eventId === 'string' ? this.store.event(eventId) : undefined;
    return row ? this.decorate(JSON.parse(row.data) as RecordedEvent, row.favorite === 1, true) : undefined;
  }

  /**
   * Newest first, with the filters applied per event (triggers, types, attributes with their «И/ИЛИ»,
   * confidence, search, hidden types; see filter.ts). A selective filter may need many rows for one
   * page, so rows are read in large batches. Once the page has results, the scan stops after
   * `scanRows` rows and reports `hasMore`: the next page continues before its last event. An empty
   * page never reports `hasMore` (the client would ask for the same page again). The client continues
   * with `before` = the start of the last event it got, so a page never ends between events that started
   * in the same millisecond: it takes them all, even past `limit`.
   */
  private queryEvents(cameraIds: string[] | undefined, opts: GetEventsOptions, limit: number, scanRows: number): { events: RecordedEvent[]; hasMore: boolean } {
    const batch = Math.min(Math.max(limit * 2 + 1, 200), 2000);
    const withRecording = opts.withRecordingInfo ?? opts.hasRecording;
    const out: RecordedEvent[] = [];
    let before = opts.before;
    let scanned = 0;
    let lastMs: number | undefined;
    for (;;) {
      const rows = this.store.events({
        cameraIds,
        startMs: opts.startMs,
        endMs: opts.endMs,
        startedSinceMs: opts.startedSinceMs,
        before,
        favoritesOnly: opts.favoritesOnly,
        state: opts.state,
        limit: batch,
      });
      for (const row of rows) {
        const raw = JSON.parse(row.data) as RecordedEvent;
        if (!matchesEvent(raw, opts)) continue;
        // the recording lookup costs a query: only for events the other filters let through
        const ev = this.decorate(raw, row.favorite === 1, withRecording);
        if (opts.hasRecording && !ev.hasRecording) continue;
        if (out.length >= limit && row.start_ms !== lastMs) return { events: out, hasMore: true };
        out.push(ev);
        lastMs = row.start_ms;
      }
      scanned += rows.length;
      if (rows.length < batch) return { events: out, hasMore: false };
      if (out.length > 0 && scanned >= scanRows) return { events: out, hasMore: true };
      before = rows.at(-1)!.start_ms;
    }
  }

  public async getEventStats(
    cameraIds: string[],
    opts: GetEventsOptions = {},
  ): Promise<{ total: number; segments: number; episodes: number; byType: Record<string, number>; capped: boolean }> {
    await this.ready;
    const scope = cameraIds?.length ? cameraIds : undefined;
    let counts = this.eventCounts(scope, opts);
    if (!counts) {
      const { events, hasMore } = this.queryEvents(scope, { ...opts, before: undefined }, STATS_CAP, STATS_SCAN_ROWS);
      counts = { total: events.length, segments: 0, byType: {}, capped: hasMore };
      for (const ev of events) {
        for (const t of ev.types ?? []) counts.byType[t] = (counts.byType[t] ?? 0) + 1;
        counts.segments += Math.max(1, ev.segments?.length ?? 0);
      }
    }
    // the episodes of the same cameras and time range, as the page lists them: an episode belongs to the range while
    // it ends in it, the event filters (types, search…) do not apply to episodes
    const episodes = this.store.episodeCount({
      fromMs: Math.max(Number(opts.startMs) || 0, Number(opts.startedSinceMs) || 0),
      toMs: Number(opts.endMs) || Number.MAX_SAFE_INTEGER,
      favoritesOnly: opts.favoritesOnly,
      cameraIds: cameraIds?.length ? cameraIds : undefined,
    });
    return { total: counts.total, segments: counts.segments, episodes, byType: counts.byType, capped: counts.capped };
  }

  /**
   * The counts of `getEventStats` without parsing an event: the walk of `queryEvents` (the same pages, the same two
   * limits, the same ties) over the two values the database reads from each event. Possible while the filter asks
   * nothing that needs the event itself: no detections or confidence, no search, no chosen types, triggers or
   * attributes, no hidden types; otherwise there is no answer here and the events are parsed as before.
   */
  private eventCounts(
    cameraIds: string[] | undefined,
    opts: GetEventsOptions,
  ): { total: number; segments: number; byType: Record<string, number>; capped: boolean } | undefined {
    const inEvent = [opts.hasDetections, opts.minConfidence, opts.search].some(Boolean);
    const chosen = [opts.triggers, opts.triggerLabels, opts.types, opts.attributes, ...Object.values(opts.hiddenTypes ?? {})].some((list) => list?.length);
    if (inEvent || chosen) return undefined;
    const batch = Math.min(Math.max(STATS_CAP * 2 + 1, 200), 2000);
    const withRecording = opts.withRecordingInfo ?? opts.hasRecording;
    const counts = { total: 0, segments: 0, byType: {} as Record<string, number>, capped: false };
    let before: number | undefined;
    let scanned = 0;
    let lastMs: number | undefined;
    for (;;) {
      const rows = this.store.eventDigests({
        cameraIds,
        startMs: opts.startMs,
        endMs: opts.endMs,
        startedSinceMs: opts.startedSinceMs,
        before,
        favoritesOnly: opts.favoritesOnly,
        state: opts.state,
        limit: batch,
      });
      for (const row of rows) {
        if (opts.hasRecording && !(withRecording && this.hasRecording(row.camera_id, row.start_ms, row.end_ms))) continue;
        if (counts.total >= STATS_CAP && row.start_ms !== lastMs) return { ...counts, capped: true };
        counts.total++;
        lastMs = row.start_ms;
        for (const t of row.types?.startsWith('[') ? (JSON.parse(row.types) as string[]) : []) counts.byType[t] = (counts.byType[t] ?? 0) + 1;
        counts.segments += Math.max(1, row.segments ?? 0);
      }
      scanned += rows.length;
      if (rows.length < batch) return counts;
      if (counts.total > 0 && scanned >= STATS_SCAN_ROWS) return { ...counts, capped: true };
      before = rows.at(-1)!.start_ms;
    }
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
      // pictures only (the folder also keeps the trace's camera config)
      if (!file.endsWith('.jpg')) continue;
      const data = new Uint8Array(await readFile(join(dir, file)));
      const name = file.replace(/\.jpg$/, '');
      if (name === 'event') result.event = data;
      else if (name.startsWith('strip-')) result.strips[name.slice(6)] = data;
      else if (name.startsWith('card-')) result.cards[name.slice(5)] = data;
      else if (name.startsWith('attr-')) result.attributes[safeDecode(name.slice(5))] = data;
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
    this.forgetEvents(deleted);
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

  /**
   * The days of a month that have recordings, `YYYY-MM-DD`. The interface draws its calendar in the time zone of the
   * browser and sends it as `timeZone` (an IANA name): the days are the days of that zone. Without it they are the
   * days of the server, which on a server in UTC put a recording of 01:00 in Moscow on the day before.
   */
  public async getRecordingDays(cameraId: string, year: number, month: number, timeZone?: string): Promise<string[]> {
    await this.ready;
    const zone = this.zoneFormat(timeZone);
    const count = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    if (!(count > 0)) return [];
    // where every day of the month starts, and the month after it: a day is not always 24 hours long
    const starts = Array.from({ length: count + 1 }, (_, i) => dayStart(year, month, i + 1, zone) * 1000);
    const from = starts[0];
    const to = starts[count];
    const recorded = new Set<number>();
    const bounds = this.store.recordingDays(cameraId, from, to);
    for (let i = 0; i < bounds.length && recorded.size < count; i += 2) {
      const startUs = Math.max(bounds[i], from);
      const endUs = Math.min(bounds[i + 1], to - 1);
      for (let day = 0; day < count; day++) if (startUs < starts[day + 1] && endUs >= starts[day]) recorded.add(day);
    }
    return [...recorded].sort((a, b) => a - b).map((day) => `${year}-${pad2(month)}-${pad2(day + 1)}`);
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
          // file first: if removing it fails the row stays and retention retries (readers skip a missing file)
          await rm(this.store.file(seg), { force: true });
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

  public nvrPlayback(cameraId: string, tsUs: number, videoOnly: boolean, sourceRole: string, callbacks: NvrPlaybackCallbacks): AsyncGenerator<void> {
    return this.playback.play(cameraId, tsUs, this.resolveRole(cameraId, sourceRole), callbacks, { audio: !videoOnly });
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
      const gop = await readGop(this.store.located(seg), kf, tsUs);
      if (!gop.length) return { ts: tsUs, videoCodec: '', noData: true };
      return { ...meta, ts: gop.at(-1)!.tsUs, frame: gop[0].data, frames: gop.map((f) => ({ frame: f.data, ts: f.tsUs, keyframe: f.keyframe })) };
    }
    const frame = await readKeyframe(this.store.located(seg), kf);
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
      const frame = await readKeyframe(this.store.located(seg), kf);
      if (!frame) continue;
      meta ??= { videoCodec: seg.codec, codecString: seg.codec_string, width: seg.width, height: seg.height };
      frames.push({ frame: frame.data, ts: frame.tsUs, keyframe: true });
    }
    return meta ? { ...meta, frames } : { frames: [], videoCodec: '', noData: true };
  }

  /**
   * Pictures for detection-trace ticks, from the recording. `keyframe`: the keyframe at or before each
   * target (thumbnail strip); `exact`: the frame at the target, decoded from its keyframe. The trace
   * times are the server's capture times and the recording is indexed by wall clock, so a picture is
   * the recorded frame nearest in time, never marked exact.
   */
  public async nvrTraceFrames(
    cameraId: string,
    targets: TraceFrameTarget[],
    mode: 'exact' | 'keyframe' = 'keyframe',
  ): Promise<{ chains: TraceChain[]; missing?: number[]; noData?: boolean }> {
    await this.ready;
    const chains = new Map<string, TraceChain>();
    const missing: number[] = [];
    const seen = new Map<string, number>();
    const list = (targets ?? []).slice(0, TRACE_MAX_TARGETS);
    for (let target = 0; target < list.length; target++) {
      const tsUs = Math.round(Number(list[target].tMs) * 1000);
      const role = this.resolveRole(cameraId, list[target].src);
      const seg = Number.isFinite(tsUs) ? this.store.segmentAt(cameraId, role, tsUs) : undefined;
      const kf = seg && seg.start_us <= tsUs + 2_000_000 ? keyframeAtOrBefore(seg, tsUs) : undefined;
      if (!seg || !kf) {
        missing.push(target);
        continue;
      }
      // exact: one chain per target (each GOP decodes on its own); keyframes share one chain per stream
      const key = mode === 'exact' ? `${target}` : `${role}|${seg.codec_string}|${seg.width}x${seg.height}`;
      let chain = chains.get(key);
      if (!chain) {
        chain = { role, videoCodec: seg.codec, codecString: seg.codec_string, width: seg.width, height: seg.height, frames: [], keep: [] };
        chains.set(key, chain);
      }
      if (mode === 'exact') {
        const gop = await readGop(this.store.located(seg), kf, tsUs);
        if (!gop.length) {
          missing.push(target);
          chains.delete(key);
          continue;
        }
        chain.frames = gop.map((f) => ({ frame: f.data, ts: f.tsUs, keyframe: f.keyframe }));
        chain.keep.push({ target, index: gop.length - 1, exact: false });
        continue;
      }
      const frameKey = `${key}|${seg.id}:${kf.offset}`;
      const known = seen.get(frameKey);
      if (known !== undefined) {
        chain.keep.push({ target, index: known, exact: false });
        continue;
      }
      const frame = await readKeyframe(this.store.located(seg), kf);
      if (!frame) {
        missing.push(target);
        continue;
      }
      seen.set(frameKey, chain.frames.length);
      chain.keep.push({ target, index: chain.frames.length, exact: false });
      chain.frames.push({ frame: frame.data, ts: frame.tsUs, keyframe: true });
    }
    const out = [...chains.values()].filter((c) => c.frames.length);
    return out.length ? { chains: out, ...(missing.length ? { missing } : {}) } : { chains: [], noData: true };
  }

  // ------------------------------------------------------------------ export

  public async nvrExport(
    cameraId: string,
    startUs: number,
    endUs: number,
    options: { timelapseIntervalSec?: number; sourceRole?: string; timeZone?: string } = {},
  ): Promise<{ url: string; filename: string; size: number; durationMs: number }> {
    await this.ready;
    const role = this.resolveRole(cameraId, options.sourceRole);
    const filename = `${this.cameraSlug(cameraId)}_${fileStamp(startUs, this.zoneFormat(options.timeZone))}.mp4`;
    const res = await exportClip({
      ffmpegPath: this.ffmpegPath,
      segments: this.store.segments(cameraId, role, startUs, endUs).map((s) => this.store.located(s)),
      startUs,
      endUs,
      outDir: join(this.dataDir, 'exports'),
      filename,
      timelapseIntervalSec: options.timelapseIntervalSec,
    });
    try {
      const dl = await this.api.downloadManager.createDownload({ filePath: res.path, filename, mimeType: 'video/mp4', ttlMs: 3 * 3600_000, cleanup: 'on-expiry' });
      return { url: dl.url, filename, size: res.size, durationMs: res.durationMs };
    } catch (error) {
      // without a download nobody removes the clip when it expires
      await rm(res.path, { force: true }).catch((e: Error) => this.logger.warn(`Export cleanup: ${e.message}`));
      throw error;
    }
  }

  /**
   * The files an export would have and their size. `tooLarge` is set when `nvrExportBatch` would refuse this export:
   * several files leave as one ZIP, which holds 4 GB at most. A timelapse (`timelapse`) is a small part of the
   * recordings it is made of, so it is not judged by their size.
   */
  public async nvrExportEstimate(request: {
    cameras: string[];
    slices: { day: string; startUs: number; endUs: number }[];
    quality?: ExportQuality;
    timelapse?: boolean;
  }): Promise<{
    files: { cameraId: string; day: string; startUs: number; endUs: number; bytes: number }[];
    totalBytes: number;
    durationMs: number;
    tooLarge?: { bytes: number; limitBytes: number };
  }> {
    await this.ready;
    const files: { cameraId: string; day: string; startUs: number; endUs: number; bytes: number }[] = [];
    let durationMs = 0;
    for (const cameraId of request.cameras) {
      for (const slice of request.slices) {
        let bytes = 0;
        for (const seg of this.exportSegments(cameraId, slice.startUs, slice.endUs, request.quality)) {
          const span = Math.max(1, seg.end_us - seg.start_us);
          const overlap = Math.max(0, Math.min(seg.end_us, slice.endUs) - Math.max(seg.start_us, slice.startUs));
          bytes += Math.round((seg.bytes * overlap) / span);
          durationMs += overlap / 1000;
        }
        if (bytes > 0) files.push({ cameraId, day: slice.day, startUs: slice.startUs, endUs: slice.endUs, bytes });
      }
    }
    const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
    const tooLarge = !request.timelapse && files.length > 1 && totalBytes >= ZIP_MAX_BYTES;
    return { files, totalBytes, durationMs: Math.round(durationMs), ...(tooLarge ? { tooLarge: { bytes: totalBytes, limitBytes: ZIP_MAX_BYTES } } : {}) };
  }

  public async nvrExportBatch(request: {
    cameras: string[];
    slices: { day: string; startUs: number; endUs: number }[];
    quality?: ExportQuality;
    timelapseIntervalSec?: number;
    timeZone?: string;
  }): Promise<{ url: string; filename: string }> {
    await this.ready;
    const zone = this.zoneFormat(request.timeZone);
    // several files leave as one ZIP, which holds 4 GB at most: said now, not after every file was cut. The estimate is
    // the size the export dialog shows, and it tells the dialog the same refusal beforehand. The files of a timelapse
    // are measured when they exist (writeZip).
    const { tooLarge } = await this.nvrExportEstimate({ ...request, timelapse: !!request.timelapseIntervalSec });
    if (tooLarge) throw zipTooLarge(tooLarge.bytes);
    const outDir = join(this.dataDir, 'exports', randomUUID());
    this.exporting.add(outDir);
    try {
      const parts: { path: string; name: string }[] = [];
      for (const cameraId of request.cameras) {
        for (const slice of request.slices) {
          const segments = this.exportSegments(cameraId, slice.startUs, slice.endUs, request.quality);
          if (!segments.length) continue;
          const name = `${this.cameraSlug(cameraId)}_${fileStamp(slice.startUs, zone)}.mp4`;
          const res = await exportClip({
            ffmpegPath: this.ffmpegPath,
            segments: segments.map((s) => this.store.located(s)),
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
      const filename = `vion-export_${fileStamp(Date.now() * 1000, zone)}.zip`;
      const zipPath = join(outDir, filename);
      await writeZip(zipPath, parts);
      await Promise.all(parts.map((p) => rm(p.path, { force: true })));
      const dl = await this.api.downloadManager.createDownload({ filePath: zipPath, filename, mimeType: 'application/zip', ttlMs: 3 * 3600_000, cleanup: 'on-expiry' });
      return { url: dl.url, filename };
    } catch (error) {
      await this.removeExportDir(outDir);
      throw error;
    } finally {
      this.exporting.delete(outDir);
    }
  }

  /** A failed export leaves nothing behind: the files cut before the failure would stay on the archive disk for good. */
  private async removeExportDir(outDir: string): Promise<void> {
    await rm(outDir, { recursive: true, force: true }).catch((error: Error) => this.logger.warn(`Export cleanup: ${error.message}`));
  }

  /**
   * When a download expires the host removes its file, not the folder a ZIP or an episode clip was made in: the empty
   * `exports/<id>` folders stayed for good. Only an empty folder goes (`rmdir` refuses any other, whose download is
   * still there), and never the folder of an export being made: it is empty until ffmpeg has opened its first file.
   */
  private async removeEmptyExportDirs(): Promise<void> {
    const root = join(this.dataDir, 'exports');
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const dir = join(root, entry.name);
        if (!entry.isDirectory() || this.exporting.has(dir)) continue;
        await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'ENOENT') this.logger.warn(`Export cleanup: ${error.message}`);
        });
      }
    } catch (error) {
      // nothing was exported yet: no folder to look into
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`Export cleanup: ${(error as Error).message}`);
    }
  }

  /**
   * Recorded files for an export slice in the chosen quality: «best» takes the highest-resolution
   * stream that has recordings in the slice, «smallest» the lowest. A camera recording only one
   * stream exports that stream either way.
   */
  private exportSegments(cameraId: string, startUs: number, endUs: number, quality: ExportQuality = 'best'): SegmentRow[] {
    const order = quality === 'smallest' ? ['low', 'mid', 'high'] : ['high', 'mid', 'low'];
    for (const role of order) {
      const segments = this.store.segments(cameraId, role, startUs, endUs);
      if (segments.length) return segments;
    }
    return [];
  }

  // ----------------------------------------------------------------- storage

  /** `timeZone`: the zone the first and the last day of each camera's archive are named in (the server's without it). */
  public async getStorageStats(timeZone?: string): Promise<StorageStats> {
    await this.ready;
    const zone = this.zoneFormat(timeZone);
    const fs = await statfs(this.recordingsDir);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const GB = 1024 ** 3;
    const s = this.setting;
    const cameras: StorageStats['cameras'] = {};
    const recorded = this.store.cameraStats();
    for (const row of recorded) {
      const hours = Math.max(1 / 60, (row.newest - row.oldest) / 3.6e9);
      const managed = this.cameras.get(row.camera_id);
      const recorders = [...(managed?.recorders.values() ?? [])];
      const oldestDay = localDay(row.oldest / 1000, zone);
      const newestDay = localDay(row.newest / 1000, zone);
      cameras[row.camera_id] = {
        usedBytes: row.bytes,
        segmentCount: row.count,
        oldestDay,
        newestDay,
        daysCount: Math.max(1, Math.round((new Date(newestDay).getTime() - new Date(oldestDay).getTime()) / 86_400_000) + 1),
        bandwidthMBh: Math.round((row.bytes / 1024 ** 2 / hours) * 10) / 10,
        recordingMode: shownMode(managed?.device),
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
        recordingMode: shownMode(managed.device),
        isRecording: [...managed.recorders.values()].some((r) => r.isRecording),
      };
    }
    return {
      diskTotalGB: round2(total / GB),
      diskUsedGB: round2((total - free) / GB),
      diskFreeGB: round2(free / GB),
      diskFreePercent: total ? round2((free / total) * 100) : 0,
      // the sum of what was read above: asking the database for the total was a second pass over every segment
      nvrUsedGB: round2(recorded.reduce((bytes, row) => bytes + row.bytes, 0) / GB),
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
          // file first: if removing it fails the row stays and retention retries (readers skip a missing file)
          await rm(this.store.file(seg), { force: true });
          this.store.deleteSegment(seg.id);
          removed++;
        }
      }

      // quota and free-space guard: drop the oldest files first
      const GB = 1024 ** 3;
      // summed once and kept up to date below: a SUM over every segment for each deleted file made a big cleanup quadratic
      let usedBytes = s.quotaGB > 0 ? this.store.totalBytes() : 0;
      for (let guard = 0; guard < 10_000; guard++) {
        const fs = await statfs(this.recordingsDir);
        const freePct = (fs.bavail / fs.blocks) * 100;
        const overQuota = s.quotaGB > 0 && usedBytes > s.quotaGB * GB;
        if (!overQuota && freePct >= s.minFreePercent) break;
        const [oldest] = this.store.oldestSegments(1);
        if (!oldest || this.isLiveSegment(oldest.id)) {
          if (freePct < Math.max(1, s.minFreePercent / 3) && !this.paused) {
            this.paused = true;
            this.pushSystemEvent({ type: 'storage', severity: 'error', message: 'Недостаточно места на диске: запись приостановлена' });
            this.announceManual();
            for (const c of this.cameras.values()) for (const r of c.recorders.values()) await r.stop();
          }
          break;
        }
        // file first: if removing it fails the row stays and retention retries (readers skip a missing file)
        await rm(this.store.file(oldest), { force: true });
        this.store.deleteSegment(oldest.id);
        usedBytes -= oldest.bytes;
        removed++;
      }
      if (this.paused) {
        const fs = await statfs(this.recordingsDir);
        if ((fs.bavail / fs.blocks) * 100 >= s.minFreePercent) {
          this.paused = false;
          this.pushSystemEvent({ type: 'storage', severity: 'success', message: 'Место на диске освободилось: запись возобновлена' });
          for (const c of this.cameras.values()) for (const r of c.recorders.values()) r.start();
          this.announceManual();
        }
      }

      // events and their thumbnails follow the same retention (favorites are kept)
      const expired: EventRow[] = this.store.eventsBefore(Date.now() - s.retentionDays * 86_400_000, 1000);
      for (const row of expired) {
        this.store.deleteEvent(row.id);
        await rm(this.thumbDir(row.camera_id, row.id), { recursive: true, force: true });
      }
      this.forgetEvents(expired.map((e) => e.id));
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
    await this.removeEmptyExportDirs();
  }

  // ------------------------------------------------------------ detection trace

  /** Stored detection-trace ticks of an event, a page at a time (time order). */
  public async getEventTrace(eventId: string, offset = 0, limit = TRACE_PAGE): Promise<EventTrace> {
    await this.ready;
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const ticks = this.store.trace(eventId, from, Math.min(Math.max(Math.floor(Number(limit) || TRACE_PAGE), 1), 500)).map((t) => JSON.parse(t) as TraceTick);
    const result: EventTrace = { eventId, offset: from, total: this.store.traceCount(eventId), exact: true, ticks };
    const row = this.store.event(eventId);
    if (row) {
      try {
        result.config = JSON.parse(readFileSync(join(this.thumbDir(row.camera_id, eventId), 'trace-config.json'), 'utf8')) as EventTrace['config'];
      } catch {
        // recorded before the NVR kept the camera config: the UI uses the current zones
      }
    }
    return result;
  }

  /** Offset of the first trace tick at or after `tMs`. */
  public async getEventTraceOffset(eventId: string, tMs: number): Promise<number> {
    await this.ready;
    return this.store.traceOffset(eventId, Number(tMs) || 0);
  }

  // ---------------------------------------------------------------- features

  /** What this NVR supports beyond the basics; the UI hides the rest. */
  public async getNvrFeatures(): Promise<NvrFeatures> {
    return { episodes: true, exportQuality: true, manualRecording: true };
  }

  // -------------------------------------------------------- manual recording

  /**
   * Starts recording a camera by hand, or extends a running manual recording, for `minutes` (default 5, at most
   * 120). A «Постоянно» camera already records: nothing changes and the answer says it is not a manual recording.
   */
  public async nvrStartRecording(cameraId: string, minutes?: number): Promise<ManualRecording> {
    await this.ready;
    const managed = this.cameras.get(cameraId);
    if (!managed) throw new Error('This camera is not recorded by ViON NVR');
    if (!managed.recorders.size) throw new Error(managed.overLimit ? 'No free recording slot in the plan' : 'Recording is off for this camera');
    // the disk guard stopped every recorder: a manual window would be answered as active and write nothing
    if (this.paused) throw new Error('Recording is paused: not enough free disk space');
    if (effectiveMode(managed.device.recordingSettings?.mode) === 'continuous') return { cameraId, active: false };

    const span = Math.min(Math.max(Math.round(Number(minutes) || MANUAL_DEFAULT_MIN), 1), MANUAL_MAX_MIN);
    const untilMs = Date.now() + span * 60_000;
    const previous = this.manual.get(cameraId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.endManual(cameraId), untilMs - Date.now());
    timer.unref?.();
    this.manual.set(cameraId, { startedAt: previous?.startedAt ?? Date.now(), untilMs, timer });
    for (const rec of managed.recorders.values()) rec.setManual(untilMs * 1000);
    const state = this.manualState(cameraId);
    for (const cb of this.manualListeners) this.safeCall(this.manualListeners, cb, state);
    return state;
  }

  public async nvrStopRecording(cameraId: string): Promise<ManualRecording> {
    await this.ready;
    this.endManual(cameraId);
    return this.manualState(cameraId);
  }

  public async getManualRecording(cameraId: string): Promise<ManualRecording> {
    await this.ready;
    return this.manualState(cameraId);
  }

  public async onManualRecording(callback: (state: ManualRecording) => void): Promise<Unsubscribe> {
    return this.subscribe(this.manualListeners, callback);
  }

  /**
   * While the disk guard has paused recording a manual recording writes nothing: it is reported as not active, with
   * the reason and the times it keeps. Its window stays on the recorders, so it goes on when there is room again
   * before its time is up (the timer that ends it runs through the pause).
   */
  private manualState(cameraId: string): ManualRecording {
    const m = this.manual.get(cameraId);
    if (!m) return { cameraId, active: false };
    const times = { startedAt: m.startedAt, untilMs: m.untilMs };
    return this.paused ? { cameraId, active: false, ...times, reason: 'paused' } : { cameraId, active: true, ...times };
  }

  /** The disk guard pausing or resuming changes the state of every manual recording at once: the listeners hear each. */
  private announceManual(): void {
    for (const cameraId of this.manual.keys()) {
      const state = this.manualState(cameraId);
      for (const cb of this.manualListeners) this.safeCall(this.manualListeners, cb, state);
    }
  }

  /** Ends a manual recording (stop, time up, camera gone); what detections asked for keeps recording. */
  private endManual(cameraId: string): void {
    const m = this.manual.get(cameraId);
    if (!m) return;
    clearTimeout(m.timer);
    this.manual.delete(cameraId);
    for (const rec of this.cameras.get(cameraId)?.recorders.values() ?? []) rec.setManual(0);
    const state = this.manualState(cameraId);
    for (const cb of this.manualListeners) this.safeCall(this.manualListeners, cb, state);
  }

  // ---------------------------------------------------------------- episodes

  public async getEpisodes(
    opts: { startMs?: number; endMs?: number; limit?: number; favoritesOnly?: boolean } = {},
  ): Promise<{ episodes: RecordedEpisode[]; hasMore: boolean }> {
    await this.ready;
    return this.episodes.list(opts ?? {});
  }

  /** The pictures of up to four of the episode's events, cameras first, in one JPEG; cached until the members change. */
  public async getEpisodeMosaic(episodeId: string): Promise<Uint8Array | undefined> {
    await this.ready;
    const episode = this.episodes.get(episodeId);
    if (!episode) return undefined;
    const members = [...new Map(episode.members.map((m) => [m.cameraId, m])).values(), ...episode.members].filter(
      (m, i, all) => all.findIndex((x) => x.eventId === m.eventId) === i,
    );
    const key = members
      .slice(0, 4)
      .map((m) => m.eventId)
      .join('|');
    const dir = join(this.dataDir, 'episodes', episodeId);
    try {
      if (readFileSync(join(dir, 'mosaic.key'), 'utf8') === key) return new Uint8Array(readFileSync(join(dir, 'mosaic.jpg')));
    } catch {
      // not made yet, or the members changed since
    }
    const pictures: Uint8Array[] = [];
    for (const member of members) {
      if (pictures.length === 4) break;
      const picture = await this.memberPicture(member.eventId);
      if (picture) pictures.push(picture);
    }
    if (!pictures.length) return undefined;
    try {
      const jpeg = await mosaic(this.ffmpegPath, pictures);
      mkdirSync(dir, { recursive: true });
      await writeFile(join(dir, 'mosaic.jpg'), jpeg);
      await writeFile(join(dir, 'mosaic.key'), key);
      return jpeg;
    } catch (error) {
      // a card still gets a picture when ffmpeg cannot compose one
      this.logger.warn(`Episode mosaic: ${(error as Error).message}`);
      return pictures[0];
    }
  }

  public async getEpisodeTrace(episodeId: string): Promise<EpisodeTrace | null> {
    await this.ready;
    return this.episodes.trace(episodeId);
  }

  /** The picture of every event of the episode, in its order, with the camera and the time into the visit. */
  public async getEpisodeTraceImages(episodeId: string): Promise<{ note: string; data?: Uint8Array }[]> {
    await this.ready;
    const trace = this.episodes.trace(episodeId);
    const episode = this.episodes.get(episodeId);
    if (!trace || !episode) return [];
    return Promise.all(episode.members.map(async (member, i) => ({ note: trace.images[i]?.note ?? member.cameraId, data: await this.memberPicture(member.eventId) })));
  }

  public async setEpisodeFavorite(episodeId: string, favorite: boolean): Promise<void> {
    await this.ready;
    const episode = this.episodes.setFavorite(episodeId, favorite === true);
    if (!episode) return;
    // other open views learn it the way they learn any episode change
    const row = this.store.event(episode.members[0]?.eventId ?? '');
    if (row) {
      const data = this.decorate(JSON.parse(row.data) as RecordedEvent, row.favorite === 1);
      for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type: 'episode', data, episode });
    }
  }

  /** The episode's recordings in the player's order: one MP4, or a ZIP with one MP4 per camera block. */
  public async nvrExportEpisode(episodeId: string, options: { timeZone?: string } = {}): Promise<{ url: string; filename: string }> {
    await this.ready;
    const zone = this.zoneFormat(options?.timeZone);
    const episode = this.episodes.get(episodeId);
    if (!episode) throw new Error('Episode not found');
    const told = (episode.blocks ?? []).filter((b) => !b.secondAngle && b.endMs > b.startMs);
    const blocks = told.length ? told : episode.members.map((m) => ({ cameraId: m.cameraId, startMs: m.firstSeen, endMs: m.lastSeen }));
    const outDir = join(this.dataDir, 'exports', randomUUID());
    this.exporting.add(outDir);
    try {
      const parts: { path: string; name: string }[] = [];
      for (const block of blocks) {
        const startUs = (block.startMs - EPISODE_HEAD_MS) * 1000;
        const endUs = (block.endMs + EPISODE_TAIL_MS) * 1000;
        const segments = this.exportSegments(block.cameraId, startUs, endUs);
        if (!segments.length) continue;
        const name = `${String(parts.length + 1).padStart(2, '0')}_${this.cameraSlug(block.cameraId)}_${fileStamp(startUs, zone)}.mp4`;
        const located = segments.map((s) => this.store.located(s));
        const res = await exportClip({ ffmpegPath: this.ffmpegPath, segments: located, startUs, endUs, outDir, filename: name });
        parts.push({ path: res.path, name });
      }
      if (!parts.length) throw new Error('No recordings for this episode');
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
      const filename = `vion-episode_${fileStamp(episode.startTime * 1000, zone)}.zip`;
      const zipPath = join(outDir, filename);
      await writeZip(zipPath, parts);
      await Promise.all(parts.map((p) => rm(p.path, { force: true })));
      const dl = await this.api.downloadManager.createDownload({ filePath: zipPath, filename, mimeType: 'application/zip', ttlMs: 3 * 3600_000, cleanup: 'on-expiry' });
      return { url: dl.url, filename };
    } catch (error) {
      await this.removeExportDir(outDir);
      throw error;
    } finally {
      this.exporting.delete(outDir);
    }
  }

  private async memberPicture(eventId: string): Promise<Uint8Array | undefined> {
    const row = this.store.event(eventId);
    if (!row) return undefined;
    try {
      return (await this.getEventThumbnails(row.camera_id, row.start_ms, eventId)).event;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------ indexing (CLIP, faces)

  /** Files the event's CLIP vectors and face vectors; unmatched faces go to the unknown list. */
  private indexEvent(event: RecordedEvent, att?: EventAttachments): void {
    try {
      this.semantic.ingest(event);
    } catch (error) {
      this.logger.warn(`Semantic index: ${(error as Error).message}`);
    }
    const current = event.segmentIndex ?? Math.max(0, event.segments.length - 1);
    event.segments.forEach((segment, seg) => {
      (segment.attributes ?? []).forEach((raw, attr) => {
        const a = raw as FaceAttribute;
        if (a.type !== 'face' || !a.embedding?.length || !a.embeddingModel) return;
        try {
          const sighting = { eventId: event.id, seg, attr };
          this.faces.recordSighting(sighting, a.embeddingModel, a.embedding, a.confidence);
          if (a.label && a.label !== 'unknown') return;
          const crop = seg === current ? this.cropAt(att, attr) : undefined;
          this.faces.addUnknown({
            cameraId: event.cameraId,
            eventId: event.id,
            seg,
            attr,
            ts: (segment as { firstSeen?: number }).firstSeen ?? event.startTime,
            model: a.embeddingModel,
            embedding: a.embedding,
            confidence: a.confidence,
            jpeg: crop ?? this.readAttributeCrop(event.cameraId, event.id, `${seg}:face.${attr}`),
          });
        } catch (error) {
          this.logger.warn(`Face index: ${(error as Error).message}`);
        }
      });
    });
  }

  private cropAt(att: EventAttachments | undefined, index: number): Uint8Array | undefined {
    const crops = att?.attributes;
    const data = Array.isArray(crops) ? crops[index] : undefined;
    return data instanceof Uint8Array && data.length ? data : undefined;
  }

  private readAttributeCrop(cameraId: string, eventId: string, key: string): Uint8Array | undefined {
    try {
      return new Uint8Array(readFileSync(join(this.thumbDir(cameraId, eventId), `attr-${encodeURIComponent(key)}.jpg`)));
    } catch {
      return undefined;
    }
  }

  private forgetEvents(ids: string[]): void {
    if (!ids.length) return;
    try {
      this.semantic.deleteEvents(ids);
      this.faces.deleteForEvents(ids);
      this.describer.deleteEvents(ids);
    } catch (error) {
      this.logger.warn(`Index cleanup: ${(error as Error).message}`);
    }
    // on its own: a failed index cleanup must not leave episodes pointing at deleted events
    try {
      for (const episodeId of this.episodes.forgetEvents(ids)) {
        void rm(join(this.dataDir, 'episodes', episodeId), { recursive: true, force: true }).catch((error: Error) => this.logger.warn(`Episode files: ${error.message}`));
      }
    } catch (error) {
      this.logger.warn(`Episode cleanup: ${(error as Error).message}`);
    }
  }

  /** RPC proxies of the plugins implementing an interface (CLIP, face embedding), cached per plugin. */
  private async pluginProxies<T>(iface: string): Promise<T[]> {
    const rpc = (this.api as unknown as { proxy?: { createProxy<P>(namespace: string): P } }).proxy;
    if (!rpc) return [];
    const infos = await this.api.coreManager.getPluginsByInterface(iface as never);
    return infos.map((info) => {
      const key = `${iface}:${info.id}`;
      let proxy = this.proxies.get(key) as T | undefined;
      if (!proxy) {
        proxy = rpc.createProxy<T>(`plugin.${info.id}.child.rpc`);
        this.proxies.set(key, proxy);
      }
      return proxy;
    });
  }

  private async textEmbeddings(text: string): Promise<TextEmbedding[]> {
    const out: TextEmbedding[] = [];
    for (const encoder of await this.pluginProxies<ClipEncoder>('ClipDetection')) {
      try {
        const many = await withTimeout(encoder.getTextEmbeddings!(text));
        if (Array.isArray(many) && many.length) {
          out.push(...many);
          continue;
        }
      } catch {
        // older plugins only serve one model
      }
      try {
        const one = await withTimeout(encoder.getTextEmbedding(text));
        if (one?.embedding?.length) out.push(one);
      } catch (error) {
        this.logger.warn(`CLIP text embedding failed: ${(error as Error).message}`);
      }
    }
    return out;
  }

  /** Relabels one face attribute of a stored event and tells the UI. */
  private relabelFace(s: FaceSighting, name: string): boolean {
    const row = this.store.event(s.eventId);
    if (!row) return false;
    const event = JSON.parse(row.data) as RecordedEvent;
    const attribute = event.segments?.[s.seg]?.attributes?.[s.attr] as FaceAttribute | undefined;
    if (attribute?.type !== 'face') return false;
    attribute.label = name;
    this.store.upsertEvent(event);
    const data = this.decorate(event, row.favorite === 1, true);
    for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type: 'update', data });
    // a name is an identity: an open episode may now read «Иван: …» or take this event in
    this.offerToEpisodes(data);
    return true;
  }

  // ------------------------------------------------------------ assistant tools

  public assistantTools(): AssistantToolSpec[] {
    return ASSISTANT_TOOLS;
  }

  public async callAssistantTool(name: string, input: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    await this.ready;
    return callAssistantTool(this.assistantHost(), name, input ?? {}, ctx);
  }

  private assistantHost(): AssistantHost {
    return {
      events: (cameraIds, opts, limit) => this.queryEvents(cameraIds, opts, limit, STATS_SCAN_ROWS),
      event: (eventId) => {
        const row = this.store.event(eventId);
        return row ? this.decorate(JSON.parse(row.data) as RecordedEvent, row.favorite === 1) : undefined;
      },
      cameras: () => [...this.cameras.values()].map((c) => ({ id: c.device.id, name: c.device.name })),
      search: (text, limit) => this.searchEventsByText(text, limit),
      picture: async (event) => (await this.getEventThumbnails(event.cameraId, event.startTime, event.id)).event,
    };
  }

  // ------------------------------------------------------------ semantic search

  public async searchEventsByText(text: string, limit = 50, threshold = 0): Promise<ClipSearchResult[]> {
    await this.ready;
    const query = text?.trim();
    if (!query) return [];
    // hybrid: CLIP/SigLIP vectors of the pictures + full text of the AI descriptions
    const queries = await this.textEmbeddings(query);
    const visual = queries.length ? this.semantic.search(queries, limit * 2, threshold) : [];
    const textual = this.describer.search(query, limit * 2);
    const merged = new Map<string, ClipSearchResult>(visual.map((r) => [r.eventId, r]));
    for (const t of textual) {
      const v = merged.get(t.eventId);
      if (v) merged.set(t.eventId, { ...v, score: Math.min(1, Math.max(v.score, t.score) + 0.15) });
      else if (t.score >= threshold)
        merged.set(t.eventId, {
          eventId: t.eventId,
          cameraId: t.cameraId,
          score: Math.round(t.score * 1000) / 1000,
          timestamp: t.timestamp,
          label: this.primaryLabel(t.eventId),
        });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score || b.timestamp - a.timestamp).slice(0, limit);
  }

  private primaryLabel(eventId: string): string {
    const row = this.store.event(eventId);
    if (!row) return '';
    const ev = JSON.parse(row.data) as RecordedEvent;
    return String((ev.segments?.[0]?.detections?.[0] as { label?: string } | undefined)?.label ?? ev.types?.[0] ?? '');
  }

  // --------------------------------------------------------- AI descriptions

  /** Describes one event now (UI action "Описать ИИ"), whatever the automatic setting. */
  public async describeEvent(eventId: string): Promise<EventDescription | undefined> {
    await this.ready;
    const row = this.store.event(eventId);
    if (!row) return undefined;
    return this.describer.describe(JSON.parse(row.data) as RecordedEvent);
  }

  /** Up to three pictures of the event: the card of each segment, else the scene. */
  private describePictures(event: RecordedEvent): Uint8Array[] {
    const dir = this.thumbDir(event.cameraId, event.id);
    const out: Uint8Array[] = [];
    for (let seg = 0; seg < Math.max(1, event.segments?.length ?? 0) && out.length < 3; seg++) {
      for (const name of [`card-${seg}.jpg`, `strip-${seg}.jpg`]) {
        try {
          out.push(new Uint8Array(readFileSync(join(dir, name))));
          break;
        } catch {
          // next candidate
        }
      }
    }
    if (!out.length) {
      try {
        out.push(new Uint8Array(readFileSync(join(dir, 'event.jpg'))));
      } catch {
        // no picture: nothing to describe
      }
    }
    return out;
  }

  private saveDescription(eventId: string, description: EventDescription): void {
    const row = this.store.event(eventId);
    if (!row) return;
    const event = { ...(JSON.parse(row.data) as RecordedEvent), ai: description };
    this.store.upsertEvent(event);
    const data = this.decorate(event, row.favorite === 1, true);
    for (const cb of this.detectionListeners) this.safeCall(this.detectionListeners, cb, { type: 'update', data });
    // the description comes after the event ended; the episode's text quotes it
    this.offerToEpisodes(data);
  }

  private async notifyDescription(event: RecordedEvent, description: EventDescription, picture: Uint8Array | undefined): Promise<void> {
    const camera = this.cameras.get(event.cameraId)?.device.name ?? event.cameraId;
    await this.api.notificationManager.publish({
      title: `${camera}: ${description.title}`,
      body: description.description,
      thumbnail: picture,
      tag: `ai:${event.id}`,
      deepLink: `/cameras/${encodeURIComponent(camera)}?startTs=${event.startTime}`,
      data: { cameraId: event.cameraId, eventId: event.id },
    });
  }

  public async getClipReindexStatus(): Promise<ClipReindexStatus> {
    return { ...this.clipStatus };
  }

  public async startClipReindex(): Promise<ClipReindexStatus> {
    await this.ready;
    if (!this.clipStatus.running) void this.runClipReindex();
    return { ...this.clipStatus };
  }

  public async cancelClipReindex(): Promise<void> {
    this.clipCancel = true;
  }

  public async onClipReindex(callback: (status: ClipReindexStatus) => void): Promise<Unsubscribe> {
    this.clipListeners.add(callback);
    return () => this.clipListeners.delete(callback);
  }

  private emitClip(patch: Partial<ClipReindexStatus>): void {
    this.clipStatus = { ...this.clipStatus, ...patch };
    for (const cb of this.clipListeners) this.safeCall(this.clipListeners, cb, { ...this.clipStatus });
  }

  /** Embeds the stored pictures of events that have no vector of the current CLIP model yet. */
  private async runClipReindex(): Promise<void> {
    this.clipCancel = false;
    this.emitClip({ running: true, total: 0, done: 0, skipped: 0, error: undefined });
    try {
      const [encoder] = await this.pluginProxies<ClipEncoder>('ClipDetection');
      if (!encoder) throw new Error('Нет плагина с CLIP (ONNX, OpenVINO или CoreML)');
      const model = (await withTimeout(encoder.getTextEmbedding('a photo'))).embeddingModel;

      const pending: { id: string; cameraId: string; startTime: number; label: string }[] = [];
      let skipped = 0;
      for (let before: number | undefined; ;) {
        const rows = this.store.events({ before, limit: 500 });
        if (!rows.length) break;
        for (const row of rows) {
          if (this.semantic.hasVectors(row.id, model)) {
            skipped++;
            continue;
          }
          const ev = JSON.parse(row.data) as RecordedEvent;
          const label = String((ev.segments?.[0]?.detections?.[0] as { label?: string } | undefined)?.label ?? ev.types?.[0] ?? '');
          pending.push({ id: row.id, cameraId: row.camera_id, startTime: row.start_ms, label });
        }
        before = rows[rows.length - 1].start_ms;
        if (rows.length < 500) break;
      }
      this.emitClip({ total: pending.length + skipped, done: skipped, skipped });

      for (let i = 0; i < pending.length && !this.clipCancel; i += 8) {
        const batch = pending.slice(i, i + 8);
        const pictures = batch.map((e) => this.eventPicture(e.cameraId, e.id));
        const usable = batch.filter((_, j) => pictures[j]);
        const images = pictures.filter((p): p is Uint8Array => !!p);
        let results: Awaited<ReturnType<NonNullable<ClipEncoder['embedImages']>>> = [];
        if (images.length) results = (await withTimeout(encoder.embedImages!(images), 120_000)) ?? [];
        usable.forEach((e, j) => {
          const vector = results[j]?.embeddings?.[0]?.embedding;
          if (vector?.length) this.semantic.addScene(e, results[j]!.embeddingModel, vector);
          else skipped++;
        });
        skipped += batch.length - usable.length;
        this.emitClip({ done: Math.min(this.clipStatus.total, skipped + i + batch.length), skipped });
      }
      this.emitClip({ running: false });
    } catch (error) {
      this.emitClip({ running: false, error: (error as Error).message });
    }
  }

  /** The best stored picture of an event: a segment card, else the scene. */
  private eventPicture(cameraId: string, eventId: string): Uint8Array | undefined {
    const dir = this.thumbDir(cameraId, eventId);
    for (const name of ['card-0.jpg', 'strip-0.jpg', 'event.jpg']) {
      try {
        return new Uint8Array(readFileSync(join(dir, name)));
      } catch {
        // next candidate
      }
    }
    return undefined;
  }

  // --------------------------------------------------------------------- faces

  public async matchFaces(embeddings: number[][], embeddingModel: string, sensitivity = 'balanced'): Promise<(FaceMatchResult | null)[]> {
    await this.ready;
    return this.faces.match(embeddings, embeddingModel, sensitivity);
  }

  public async enrollFace(name: string, imageData: Uint8Array): Promise<void> {
    await this.ready;
    const [embedder] = await this.pluginProxies<FaceEmbedder>('FaceEmbedding');
    if (!embedder) throw new Error('Нет плагина распознавания лиц (ONNX, OpenVINO, CoreML или NCNN)');
    const [result] = await withTimeout(embedder.embedFaceImages([imageData]));
    if (!result?.embedding?.length) throw new Error('На фото не найдено лицо');
    this.faces.enroll(name, result.embeddingModel, result.embedding, imageData, result.quality);
  }

  public async enrollFromEvent(name: string, unknownFaceId: string): Promise<void> {
    await this.enrollCluster(name, [unknownFaceId]);
  }

  public async enrollCluster(name: string, faceIds: string[]): Promise<void> {
    await this.ready;
    for (const sighting of this.faces.enrollUnknown(name, faceIds)) this.relabelFace(sighting, name.trim());
  }

  public async listKnownFaces(): Promise<FaceProfile[]> {
    await this.ready;
    return this.faces.listKnown();
  }

  public async deleteFace(name: string): Promise<void> {
    await this.ready;
    this.faces.deleteFace(name);
  }

  public async getFaceImages(name: string): Promise<FaceImageData[]> {
    await this.ready;
    return this.faces.images(name);
  }

  public async removeFaceImage(name: string, imageId: string): Promise<void> {
    await this.ready;
    this.faces.removeImage(name, imageId);
  }

  public async getUnknownFaces(limit = 500): Promise<UnknownFace[]> {
    await this.ready;
    return this.faces.listUnknown(limit, true, true);
  }

  public async listUnknownFaceMeta(limit = 500): Promise<UnknownFace[]> {
    await this.ready;
    return this.faces.listUnknown(limit, false, false);
  }

  public async getUnknownFaceThumbnails(unknownFaceIds: string[]): Promise<Record<string, Uint8Array>> {
    await this.ready;
    return this.faces.thumbnails(unknownFaceIds);
  }

  public async deleteUnknownFace(unknownFaceId: string): Promise<void> {
    await this.deleteUnknownFaces([unknownFaceId]);
  }

  public async deleteUnknownFaces(unknownFaceIds: string[]): Promise<void> {
    await this.ready;
    this.faces.deleteUnknown(unknownFaceIds);
  }

  public async deleteAllUnknownFaces(): Promise<void> {
    await this.ready;
    this.faces.deleteUnknown(this.faces.idsWhere('all'));
  }

  public async deleteUnknownFacesByCluster(clusterId: string): Promise<void> {
    await this.ready;
    this.faces.deleteUnknown(this.faces.idsWhere({ cluster: clusterId }));
  }

  public async deleteUngroupedUnknownFaces(): Promise<void> {
    await this.ready;
    this.faces.deleteUnknown(this.faces.idsWhere('ungrouped'));
  }

  public async removeFromCluster(unknownFaceId: string): Promise<void> {
    await this.removeFacesFromCluster([unknownFaceId]);
  }

  public async removeFacesFromCluster(unknownFaceIds: string[]): Promise<void> {
    await this.ready;
    this.faces.removeFromCluster(unknownFaceIds);
  }

  public async ignoreUnknownFaces(unknownFaceIds: string[]): Promise<void> {
    await this.ready;
    this.faces.ignore(unknownFaceIds);
  }

  public async ignoreUnknownFacesByCluster(clusterId: string): Promise<void> {
    await this.ready;
    this.faces.ignore(this.faces.idsWhere({ cluster: clusterId }));
  }

  public async listIgnoredFaces(): Promise<IgnoredFace[]> {
    await this.ready;
    return this.faces.listIgnored(true);
  }

  public async listIgnoredFaceMeta(): Promise<IgnoredFace[]> {
    await this.ready;
    return this.faces.listIgnored(false);
  }

  public async getIgnoredFaceThumbnails(ignoredFaceIds: string[]): Promise<Record<string, Uint8Array>> {
    await this.ready;
    return this.faces.thumbnails(ignoredFaceIds);
  }

  public async deleteIgnoredFaces(ignoredFaceIds: string[]): Promise<void> {
    await this.ready;
    this.faces.deleteUnknown(ignoredFaceIds);
  }

  /**
   * The user corrected who a face in an event is. The new name also learns from that face, so the
   * same person is recognised next time; clearing the name puts nobody's face back into the unknown list.
   */
  public async reassignEventFace(eventId: string, segIndex: number, oldName: string, newName: string, options?: { attrIndex?: number }): Promise<number> {
    await this.ready;
    const row = this.store.event(eventId);
    if (!row) return 0;
    const event = JSON.parse(row.data) as RecordedEvent;
    const attrs = (event.segments?.[segIndex]?.attributes ?? []) as FaceAttribute[];
    const indices =
      options?.attrIndex !== undefined
        ? [options.attrIndex]
        : attrs.flatMap((a, i) => (a.type === 'face' && (a.label ?? 'unknown') === (oldName || 'unknown') ? [i] : []));
    const name = newName?.trim() || 'unknown';
    let changed = 0;
    for (const attr of indices) {
      const sighting = { eventId, seg: segIndex, attr };
      if (!this.relabelFace(sighting, name)) continue;
      changed++;
      const seen = this.faces.sighting(sighting);
      if (name !== 'unknown' && seen) {
        this.faces.enroll(name, seen.model, seen.vec, this.readAttributeCrop(row.camera_id, eventId, `${segIndex}:face.${attr}`), seen.confidence);
        this.faces.deleteUnknownAt([sighting]);
      } else if (name === 'unknown' && seen) {
        this.faces.addUnknown({
          cameraId: row.camera_id,
          eventId,
          seg: segIndex,
          attr,
          ts: row.start_ms,
          model: seen.model,
          embedding: Array.from(seen.vec),
          confidence: seen.confidence,
          jpeg: this.readAttributeCrop(row.camera_id, eventId, `${segIndex}:face.${attr}`),
        });
      }
    }
    return changed;
  }

  /** Re-matches the unknown faces against the enrolled people (after enrolling someone new). */
  public async rescanFaces(): Promise<number> {
    await this.ready;
    const found = this.faces.rescan();
    for (const s of found) this.relabelFace(s, s.identity);
    this.faces.deleteUnknownAt(found);
    return found.length;
  }

  public async getFacesRescanStatus(): Promise<FacesRescanStatus> {
    return { ...this.rescanStatus };
  }

  public async startFacesRescan(): Promise<FacesRescanStatus> {
    await this.ready;
    if (this.rescanStatus.running) return { ...this.rescanStatus };
    const emit = (patch: Partial<FacesRescanStatus>) => {
      this.rescanStatus = { ...this.rescanStatus, ...patch };
      for (const cb of this.rescanListeners) this.safeCall(this.rescanListeners, cb, { ...this.rescanStatus });
    };
    emit({ running: true, total: 1, done: 0, matched: 0 });
    setImmediate(() => {
      void this.rescanFaces()
        .then((matched) => emit({ running: false, done: 1, matched }))
        .catch(() => emit({ running: false, done: 1 }));
    });
    return { ...this.rescanStatus };
  }

  public async onFacesRescan(callback: (status: FacesRescanStatus) => void): Promise<Unsubscribe> {
    this.rescanListeners.add(callback);
    return () => this.rescanListeners.delete(callback);
  }

  public async getFacesReindexStatus(): Promise<FacesReindexStatus> {
    return { ...this.facesReindexStatus };
  }

  public async startFacesReindex(): Promise<FacesReindexStatus> {
    await this.ready;
    if (!this.facesReindexStatus.running) void this.runFacesReindex();
    return { ...this.facesReindexStatus };
  }

  public async cancelFacesReindex(): Promise<void> {
    this.facesReindexCancel = true;
  }

  public async onFacesReindex(callback: (status: FacesReindexStatus) => void): Promise<Unsubscribe> {
    this.facesReindexListeners.add(callback);
    return () => this.facesReindexListeners.delete(callback);
  }

  /** After a face-model change: embeds the enrolled pictures with the current model (old vectors stay). */
  private async runFacesReindex(): Promise<void> {
    const emit = (patch: Partial<FacesReindexStatus>) => {
      this.facesReindexStatus = { ...this.facesReindexStatus, ...patch };
      for (const cb of this.facesReindexListeners) this.safeCall(this.facesReindexListeners, cb, { ...this.facesReindexStatus });
    };
    this.facesReindexCancel = false;
    emit({ running: true, total: 0, done: 0, skipped: 0, skippedNames: [], error: undefined, embeddingModel: undefined });
    try {
      const [embedder] = await this.pluginProxies<FaceEmbedder>('FaceEmbedding');
      if (!embedder) throw new Error('Нет плагина распознавания лиц');
      const pictures = this.faces.knownPictures();
      emit({ total: pictures.length });
      let model: string | undefined;
      const skippedNames = new Set<string>();
      let done = 0;
      let skipped = 0;
      // names re-embedded in this run; a name that already had the new model before is left alone
      const touched = new Set<string>();
      for (const picture of pictures) {
        if (this.facesReindexCancel) break;
        done++;
        if (!picture.jpeg || (model && (picture.model === model || (!touched.has(picture.name) && this.faces.nameHasModel(picture.name, model))))) {
          if (!picture.jpeg) {
            skipped++;
            skippedNames.add(picture.name);
          }
          emit({ done, skipped, skippedNames: [...skippedNames] });
          continue;
        }
        const [result] = await withTimeout(embedder.embedFaceImages([picture.jpeg]));
        if (!result?.embedding?.length) {
          skipped++;
          skippedNames.add(picture.name);
        } else {
          model = result.embeddingModel;
          if (result.embeddingModel !== picture.model && (touched.has(picture.name) || !this.faces.nameHasModel(picture.name, result.embeddingModel))) {
            this.faces.addModelVector(picture.id, picture.name, result.embeddingModel, result.embedding);
            touched.add(picture.name);
          }
        }
        emit({ done, skipped, skippedNames: [...skippedNames], embeddingModel: model });
      }
      emit({ running: false });
    } catch (error) {
      emit({ running: false, error: (error as Error).message });
    }
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
    if (withRecording) ev.hasRecording = this.hasRecording(event.cameraId, event.startTime, event.endTime);
    return ev;
  }

  /** Whether the stream the camera is played from has a recording of the time (until now, for an event still going on). */
  private hasRecording(cameraId: string, startMs: number, endMs: number | null | undefined): boolean {
    return this.store.hasSegments(cameraId, this.primaryRole(cameraId), startMs * 1000, (endMs ?? Date.now()) * 1000);
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

  /**
   * The calendar of the viewer: a formatter for the IANA zone the interface sent, or nothing for the server's own
   * zone, which is also what a name this server does not know falls back to (said once for a name).
   */
  private zoneFormat(timeZone: string | undefined): Intl.DateTimeFormat | undefined {
    if (!timeZone) return undefined;
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      const name = String(timeZone).slice(0, 64);
      // bounded: the name comes from the client
      if (!this.unknownZones.has(name) && this.unknownZones.size < 20) {
        this.unknownZones.add(name);
        this.logger.warn(`Unknown time zone "${name}": calendar days and export file names use the time zone of the server`);
      }
      return undefined;
    }
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

function safeDecode(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
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

/** Page size of an event query: the client's `limit`, within 1…500. */
function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number(limit) || 40, 1), 500);
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
  return !!rs?.enabled && !disabled && !!effectiveMode(rs.mode);
}

/**
 * How the recorder runs for a camera's recording mode. `adhoc` («По запросу») runs like «по событию» (the
 * pre-buffer is kept) but only a manual start records: detections do not trigger it (ingestNow).
 */
function effectiveMode(mode: string | undefined): 'continuous' | 'event' | undefined {
  if (mode === 'continuous') return 'continuous';
  if (mode === 'event' || mode === 'adhoc') return 'event';
  return undefined;
}

/**
 * The mode a camera records in, for the storage statistics: `adhoc` stays «По запросу» though it runs like «по
 * событию», and a camera whose recording is switched off, or which is disabled, is `off` whatever mode it keeps.
 */
function shownMode(device: CameraDevice | undefined): string {
  return device && isRecordingWanted(device) ? device.recordingSettings.mode : 'off';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The calendar date and the time of a moment: in the zone of `zone`, or in the server's own zone without one. */
function wallClock(ms: number, zone?: Intl.DateTimeFormat): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // a formatter throws for a time that is not one
  if (!zone || !Number.isFinite(ms)) {
    const d = new Date(ms);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
  const parts: Record<string, number> = {};
  for (const part of zone.formatToParts(ms)) parts[part.type] = Number(part.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/**
 * The first moment of a calendar day (a day past the end of the month is a day of the next one). In a zone it is the
 * midnight of that date read as UTC, moved back by the zone's offset. The offset is taken at that midnight and again
 * at the moment it gives, because the clock may change between the two; of the two results the day starts at the
 * earlier one that lies in the day, so a midnight skipped by a clock change starts the day an hour later.
 */
function dayStart(year: number, month: number, day: number, zone?: Intl.DateTimeFormat): number {
  if (!zone) return new Date(year, month - 1, day).getTime();
  const wall = Date.UTC(year, month - 1, day);
  const offsetAt = (ms: number) => {
    const c = wallClock(ms, zone);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - ms;
  };
  const first = wall - offsetAt(wall);
  const second = wall - offsetAt(first);
  const inDay = (ms: number) => ms + offsetAt(ms) >= wall;
  const [early, late] = first <= second ? [first, second] : [second, first];
  return inDay(early) ? early : late;
}

function localDay(ms: number, zone?: Intl.DateTimeFormat): string {
  const c = wallClock(ms, zone);
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
}

function fileStamp(us: number, zone?: Intl.DateTimeFormat): string {
  const c = wallClock(us / 1000, zone);
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}_${pad2(c.hour)}-${pad2(c.minute)}-${pad2(c.second)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
