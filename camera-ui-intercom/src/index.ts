/**
 * The intercom plugin: panels ring, the household answers in ViON or on the phone, the door agent answers when nobody
 * does, doors open by a person or a rule, and every visit goes to the archive.
 *
 * This file joins the intercom (intercom.ts) to ViON: the panels' cameras, the plugin's own doorbell and locks of a
 * driver panel (RUBITEK, Dahua, Hikvision: they are seen like any doorbell by automations, the recorder, HomeKit and
 * the floor plan), doorbells, locks, relays and door contacts of other plugins, faces and plates of the cameras' events,
 * the recorder, VOICE, notifications and the assistant. The server calls the public methods below with the user of the
 * session as `actor`; the intercom checks the rights.
 */
import { join } from 'node:path';

import { API_EVENT, BasePlugin, DoorbellTrigger, LockControl, LockState, SensorType, Severity } from '@camera.ui/sdk';
import { CameraSpeaker, LANGUAGE_NAMES, ModelStore, SherpaEngine, serverTimeZone, speakerProblem, systemClock } from '@vionvision/speech';

import { IntercomError, asActor, needAdmin } from './access.js';
import { ownerText, ownerTexts } from './agent/summary.js';
import { Intercom } from './intercom.js';
import { cameraConfig } from './panels/camera.js';
import { ProfileCatalog } from './panels/catalog.js';
import { HttpPanel } from './panels/engine.js';
import { validHost } from './panels/profile.js';
import { SipPanel } from './panels/sip.js';
import { placeOf } from './place.js';
import { nativeRequire, pluginVersion, shippedDir } from './runtime.js';
import { SipServer } from './sip/server.js';
import { PhraseCache, panelSound, saveOpus, sipSound } from './sound.js';
import { Store } from './store.js';
import { TOOLS, callTool } from './tools.js';

import type {
  AssistantToolContext,
  AssistantToolProvider,
  AssistantToolResult,
  AssistantToolSpec,
  CameraDevice,
  DetectionEvent,
  DeviceStorage,
  JsonSchema,
  LoggerService,
  PluginAPI,
  SensorLike,
} from '@camera.ui/sdk';
import type { Language } from '@vionvision/speech';
import type { Ask } from './agent/dialog.js';
import type { DoorResult, IntercomHost, NvrPort, PanelPort } from './intercom.js';
import type { PanelWorld } from './inputs.js';
import type { FloorPlanView } from './place.js';
import type { PanelEngine, PanelListener } from './panels/engine.js';
import type { Credentials, PanelEventKind, PanelProfile } from './panels/profile.js';
import type { VisitQuery } from './store.js';
import type { Panel, PanelDoor } from './types.js';

type PluginValues = Record<string, never>;

const NVR_PLUGIN = '@vionvision/camera-ui-nvr';
const VOICE_PLUGIN = '@vionvision/camera-ui-voice';
const TICK_MS = 30_000;
/** A door counts as opened when its contact or lock says so within this. */
const CONFIRM_MS = 10_000;
/** A doorbell or a panel silent this long is reported to the admins (ТЗ 4.9). */
const OFFLINE_REPORT_MS = 5 * 60_000;
const CATALOG_EVERY_MS = 24 * 60 * 60_000;
const ACCESS_EVERY_MS = 10 * 60_000;
const PLAN_EVERY_MS = 10 * 60_000;
const USERS_EVERY_MS = 60_000;
/** The settings page acts as an administrator: only administrators reach it. */
const SETTINGS_ACTOR = { userId: 'settings', role: 'admin' } as const;

interface CameraEntry {
  device: CameraDevice;
  speaker: CameraSpeaker;
  disposers: { unsubscribe(): void }[];
  /** the last time the camera's events showed a person */
  personAt?: number;
}

/** The plugin's own lock of a panel door: "unlocked" opens the door through the panel's engine. */
class PanelLock extends LockControl {
  private reflecting = false;

  constructor(
    name: string,
    nativeId: string,
    private readonly opener: () => Promise<void>,
  ) {
    super(name, { nativeId });
  }

  override async setTargetState(value: LockState): Promise<void> {
    await super.setTargetState(value);
    if (value === LockState.Unsecured && !this.reflecting) await this.opener();
  }

  /** Shows the door's state without opening anything. */
  async reflect(value: LockState): Promise<void> {
    this.reflecting = true;
    try {
      await super.setTargetState(value);
    } finally {
      this.reflecting = false;
    }
  }
}

interface OwnSensors {
  cameraId: string;
  doorbell?: DoorbellTrigger;
  locks: Map<string, PanelLock>;
}

interface EngineEntry {
  engine: PanelEngine;
  key: string;
  doorOpenAt?: number;
  offlineSince?: number;
  reported?: boolean;
}

export default class IntercomPlugin extends BasePlugin<PluginValues> implements AssistantToolProvider {
  private store: Store;
  private intercom: Intercom;
  private catalog: ProfileCatalog;
  private engine: SherpaEngine;
  private phrases: PhraseCache;
  private cameras = new Map<string, CameraEntry>();
  private sensors = new Map<string, { sensor: SensorLike; disposers: { unsubscribe(): void }[]; offlineSince?: number; reported?: boolean }>();
  private own = new Map<string, OwnSensors>();
  private engines = new Map<string, EngineEntry>();
  /** calls of the panels that call over SIP (RUBITEK's path B); open while such a panel is set up */
  private sip: SipServer | undefined;
  private sipGeneration = 0;
  private sipProblem: string | undefined;
  private allowed: { ok: boolean; at: number; vision: boolean } = { ok: false, at: 0, vision: false };
  private tickTimer: NodeJS.Timeout | undefined;
  private catalogAt = 0;
  private plan: { view?: FloorPlanView; at: number } = { at: 0 };
  private usersAt = 0;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginValues>) {
    super(logger, api, storage);
    this.store = new Store(join(api.storagePath, 'intercom.db'));
    const version = pluginVersion();
    this.catalog = new ProfileCatalog(shippedDir('profiles', 'dahua-vto.json'), join(api.storagePath, 'profiles'), version, undefined, (m) => this.logger.log(m));
    this.catalog.load();
    const models = new ModelStore(join(api.storagePath, 'speech-models'), undefined, (m) => this.logger.log(m));
    this.engine = new SherpaEngine(
      models,
      (message) => this.logger.debug(message),
      () => nativeRequire('sherpa-onnx-node'),
    );
    this.phrases = new PhraseCache(this.engine);
    this.intercom = new Intercom(this.host(version));
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => void this.start());
    this.api.on(API_EVENT.SHUTDOWN, () => void this.stop());
  }

  // ---- the world of the intercom ----

  private host(version: string): IntercomHost {
    return {
      clock: systemClock,
      store: this.store,
      dataDir: this.api.storagePath,
      pluginVersion: version,
      port: (panel) => this.port(panel),
      publish: (notification) => this.api.notificationManager.publish(notification),
      nvr: () => this.nvr(),
      announce: (text, panelCameraIds) => this.announce(text, panelCameraIds),
      ask: () => this.ask(),
      describe: (jpeg, language, timeoutMs) => this.describe(jpeg, language, timeoutMs),
      place: (panel) => placeOf(panel, this.plan.view),
      saveVoicemail: async (samples, file) => saveOpus(await this.api.coreManager.getFFmpegPath(), samples, file),
      postToThread: (threadId, userId, text, visitId) => this.postToThread(threadId, userId, text, visitId),
      panelsChanged: () => void this.syncPanels(),
      panelWorld: () => this.panelWorld(),
      timeZone: () => serverTimeZone(),
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
    };
  }

  private language(): Language {
    return this.intercom.language();
  }

  private ask(): Ask | undefined {
    return this.allowed.ok ? (request) => this.api.coreManager.assistantAsk(request) : undefined;
  }

  private async refreshAccess(): Promise<void> {
    try {
      const access = await this.api.coreManager.assistantAccess();
      this.allowed = { ok: access.allowed, at: Date.now(), vision: access.vision === true };
    } catch {
      this.allowed = { ok: false, at: Date.now(), vision: false };
    }
  }

  private async describe(jpeg: Uint8Array, language: Language, timeoutMs: number): Promise<string | undefined> {
    if (!this.allowed.vision) return undefined;
    const result = await this.api.coreManager.assistantAsk({
      system:
        `Describe in ${LANGUAGE_NAMES[language]} who is at the door in this picture, in one short phrase, at most 10 words, e.g. "a man in a uniform with a box". ` +
        'Only what is clearly visible: no guesses about who it is. Answer JSON {"say": "..."}.',
      prompt: 'Who is at the door?',
      images: [{ data: jpeg, mimeType: 'image/jpeg' }],
      outputSchema: { type: 'object', properties: { say: { type: 'string', maxLength: 120 } }, required: ['say'] },
      timeoutMs,
    });
    const say = result.ok ? (result.json as { say?: unknown } | undefined)?.say : undefined;
    return typeof say === 'string' && say.trim() && say.length <= 120 ? say.trim() : undefined;
  }

  private async nvr(): Promise<NvrPort | undefined> {
    const nvr = (await this.api.coreManager.connectToPlugin(NVR_PLUGIN).catch(() => undefined)) as Record<string, any> | undefined;
    if (!nvr) return undefined;
    return {
      startRecording: async (cameraId, minutes) => {
        await nvr.nvrStartRecording(cameraId, minutes);
      },
      events: async (cameraId, from, to) => {
        const page = (await nvr.getCameraEvents([cameraId], { startMs: from, endMs: to, limit: 20 })) as { events: DetectionEvent[] };
        return page.events.map((event) => ({ id: event.id, triggers: (event.triggers ?? []).map((t) => t.type) }));
      },
      favorite: async (eventId) => {
        await nvr.setEventFavorite(eventId, true);
      },
    };
  }

  /** "A ring at the gate" on VOICE's speakers; VOICE leaves the panels' cameras out itself. */
  private async announce(text: string, panelCameraIds: string[]): Promise<void> {
    const voice = (await this.api.coreManager.connectToPlugin(VOICE_PLUGIN).catch(() => undefined)) as Record<string, any> | undefined;
    if (typeof voice?.announce !== 'function') return;
    await voice.announce(text, { exceptCameraIds: panelCameraIds, chime: true });
  }

  /**
   * The result of an instruction in the assistant's thread it came from. The server's plugin proxy has it only from the
   * version that added it (ТЗ 5.5); before that, or when it refuses, the owner gets the ordinary notification.
   */
  private async postToThread(threadId: string, userId: string, text: string, visitId: string): Promise<boolean> {
    const core = this.api.coreManager as unknown as Record<string, unknown>;
    if (typeof core.assistantPost !== 'function') return false;
    try {
      // the server answers false when it refuses the thread (its grants are gone after a restart)
      const posted = await (core.assistantPost as (post: unknown) => Promise<unknown>)({ threadId, userId, text, references: [{ kind: 'intercom-visit', id: visitId }] });
      return posted === true;
    } catch {
      return false;
    }
  }

  private panelWorld(): PanelWorld {
    const sensors: PanelWorld['sensors'] = [...this.sensors.values()].map(({ sensor }) => ({ id: sensor.id, type: sensor.type, name: sensor.displayName }));
    for (const own of this.own.values()) {
      if (own.doorbell) sensors.push({ id: own.doorbell.id, type: SensorType.Doorbell, name: own.doorbell.displayName });
    }
    return {
      cameras: [...this.cameras.values()].map((e) => ({ id: e.device.id, name: e.device.name, speakProblem: speakerProblem(e.device) })),
      sensors,
      profile: (id) => {
        const choice = this.catalog.list().find((c) => c.profile.id === id);
        return choice?.usable ? choice.profile : undefined;
      },
    };
  }

  // ---- a panel's port: its camera, sensors and engine ----

  private port(panel: Panel): PanelPort | undefined {
    const entry = this.cameras.get(panel.cameraId);
    if (!entry) return undefined;
    const device = entry.device;
    const engine = this.engines.get(panel.id);
    const sipPanel = engine?.engine instanceof SipPanel ? engine.engine : undefined;
    return {
      snapshot: async () => {
        const data = await (device.snapshotSource ?? device.streamSource).snapshot().catch(() => undefined);
        return data ? new Uint8Array(data) : undefined;
      },
      // a panel that calls over SIP: the agent speaks and listens in its call
      speakProblem: () => (sipPanel ? (this.sip?.running ? undefined : (this.sipProblem ?? 'the SIP port is not open')) : speakerProblem(device)),
      sound: () =>
        sipPanel
          ? sipSound({
              call: () => sipPanel.call,
              engine: this.engine,
              cache: this.phrases,
              clock: systemClock,
              language: () => this.language(),
              speed: () => this.intercom.settings().agent.speed,
            })
          : panelSound({
              camera: device,
              speaker: entry.speaker,
              engine: this.engine,
              cache: this.phrases,
              clock: systemClock,
              ffmpegPath: () => this.api.coreManager.getFFmpegPath(),
              language: () => this.language(),
              speed: () => this.intercom.settings().agent.speed,
            }),
      open: (door) => this.openVia(panel, door),
      answered: engine ? async () => void (await engine.engine.answered()) : undefined,
      hangUp: engine ? async () => void (await engine.engine.hangUp()) : undefined,
      personSeen: (withinMs) => this.personSeen(entry, withinMs),
    };
  }

  private personSeen(entry: CameraEntry, withinMs: number): boolean | undefined {
    const objects = [...this.sensors.values()].map((s) => s.sensor).filter((s) => s.type === SensorType.Object && s.assignedCameraIds.includes(entry.device.id));
    for (const sensor of objects) {
      const detections = sensor.getValue('detections');
      if (Array.isArray(detections) && detections.some((d: { label?: string }) => d?.label === 'person')) return true;
    }
    if (entry.personAt !== undefined && Date.now() - entry.personAt < withinMs) return true;
    return objects.length || entry.personAt !== undefined ? false : undefined;
  }

  /** Opens by the door's way and waits for the door to say it opened. */
  private async openVia(panel: Panel, door: PanelDoor): Promise<DoorResult> {
    const started = Date.now();
    const via = door.via;
    try {
      if (via.kind === 'panel') {
        const engine = this.engines.get(panel.id);
        if (!engine) return { result: 'failed', error: 'the panel is not connected' };
        const result = await engine.engine.open(via.doorKey);
        if (!result.ok) return { result: 'failed', error: result.error ?? `status ${result.status}` };
        const lock = this.own.get(panel.id)?.locks.get(door.id);
        void lock?.reflect(LockState.Unsecured);
        setTimeout(() => void lock?.reflect(LockState.Secured), Math.max(door.relockSeconds, 3) * 1000).unref();
        return this.confirm(panel, () => (engine.doorOpenAt ?? 0) >= started);
      }
      const sensor = this.sensors.get(via.sensorId)?.sensor;
      if (!sensor) return { result: 'failed', error: 'the sensor of the door is not available' };
      if (via.kind === 'lock') {
        await sensor.updateValue('targetState', LockState.Unsecured);
        if (door.relockSeconds > 0) setTimeout(() => void sensor.updateValue('targetState', LockState.Secured), door.relockSeconds * 1000).unref();
        return this.confirm(panel, () => sensor.getValue('currentState') === LockState.Unsecured);
      }
      await sensor.updateValue('on', true);
      setTimeout(() => void sensor.updateValue('on', false), via.pulseSeconds * 1000).unref();
      return this.confirm(panel, () => false);
    } catch (error) {
      return { result: 'failed', error: (error as Error).message };
    }
  }

  /** "Confirmed" when the door's contact opened or the check holds within ten seconds; else the command went out unconfirmed. */
  private async confirm(panel: Panel, check: () => boolean): Promise<DoorResult> {
    const contact = panel.contactSensorId ? this.sensors.get(panel.contactSensorId)?.sensor : undefined;
    const end = Date.now() + CONFIRM_MS;
    while (Date.now() < end) {
      if (check() || contact?.getValue('detected') === true) return { result: 'confirmed' };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { result: 'sent' };
  }

  // ---- lifecycle ----

  private async start(): Promise<void> {
    await this.refreshAccess();
    this.api.coreManager.onEvent.subscribe(({ type }) => {
      if (type === 'assistantModelChanged') void this.refreshAccess();
    });
    await this.syncPanels();
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    void this.refreshCatalog();
    void this.refreshPlan();
    void this.refreshUsers();
  }

  private async stop(): Promise<void> {
    clearInterval(this.tickTimer);
    for (const entry of this.engines.values()) entry.engine.stop();
    this.engines.clear();
    await this.sip?.stop().catch(() => undefined);
    this.sip = undefined;
    await this.intercom.stop().catch(() => undefined);
    for (const entry of this.cameras.values()) await entry.speaker.close();
    this.store.close();
  }

  private async tick(): Promise<void> {
    this.intercom.tick();
    if (Date.now() - this.allowed.at > ACCESS_EVERY_MS) void this.refreshAccess();
    if (Date.now() - this.catalogAt > CATALOG_EVERY_MS) void this.refreshCatalog();
    if (Date.now() - this.plan.at > PLAN_EVERY_MS) void this.refreshPlan();
    if (Date.now() - this.usersAt > USERS_EVERY_MS) void this.refreshUsers();
    this.reportOffline();
  }

  /** The users of ViON, from servers that give them to plugins: a call to "all" ends when every one declined. */
  private async refreshUsers(): Promise<void> {
    this.usersAt = Date.now();
    const core = this.api.coreManager as unknown as { getUserIds?: () => Promise<string[]> };
    if (typeof core.getUserIds !== 'function') return;
    const ids = await core.getUserIds().catch(() => undefined);
    if (Array.isArray(ids)) this.intercom.setUsers(ids);
  }

  /** The floor plan, from servers that give it to plugins; an older server leaves the agent without places. */
  private async refreshPlan(): Promise<void> {
    this.plan.at = Date.now();
    const core = this.api.coreManager as unknown as { getFloorPlan?: () => Promise<FloorPlanView> };
    if (typeof core.getFloorPlan !== 'function') return;
    this.plan.view = await core.getFloorPlan().catch(() => this.plan.view);
  }

  private async refreshCatalog(): Promise<void> {
    this.catalogAt = Date.now();
    const result = await this.catalog.refresh().catch((error: Error) => ({ added: [], updated: [], failed: [{ id: 'catalog', reason: error.message }] }));
    if (result.added.length || result.updated.length) this.logger.log(`panel models: ${[...result.added, ...result.updated].join(', ')}`);
    for (const failure of result.failed) this.logger.debug(`panel model ${failure.id}: ${failure.reason}`);
  }

  /** Doorbells and panels silent for five minutes are reported to the admins, once, and once again when back. */
  private reportOffline(): void {
    const now = Date.now();
    const t = (key: string, panel: string) => ownerText(this.language(), key, { panel });
    for (const panel of this.store.panels().filter((p) => p.enabled)) {
      const states = [
        ...panel.doorbellSensorIds.map((id) => this.sensors.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s)),
        ...[this.engines.get(panel.id)].filter((e): e is EngineEntry => Boolean(e)),
      ];
      for (const state of states) {
        if (state.offlineSince !== undefined && !state.reported && now - state.offlineSince >= OFFLINE_REPORT_MS) {
          state.reported = true;
          void this.api.notificationManager.publish({
            title: t('panelOfflineTitle', panel.name),
            severity: Severity.Warn,
            adminOnly: true,
            tag: `intercom-offline:${panel.id}`,
          });
        }
      }
    }
  }

  private backOnline(state: { offlineSince?: number; reported?: boolean }, panel: Panel | undefined): void {
    if (state.reported && panel) {
      void this.api.notificationManager.publish({
        title: ownerText(this.language(), 'panelOnlineTitle', { panel: panel.name }),
        adminOnly: true,
        silent: true,
        tag: `intercom-offline:${panel.id}`,
      });
    }
    state.offlineSince = undefined;
    state.reported = false;
  }

  // ---- cameras ----

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.onCameraAdded(camera);
  }

  async onCameraAdded(device: CameraDevice): Promise<void> {
    if (this.cameras.has(device.id)) await this.onCameraReleased(device.id);
    const entry: CameraEntry = { device, speaker: new CameraSpeaker(device, systemClock, (m) => this.logger.log(m)), disposers: [] };
    this.cameras.set(device.id, entry);
    entry.disposers.push(device.onDetectionEvent.subscribe(({ type, event }) => this.onDetection(entry, type, event)));
    await this.syncOwnSensors();
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    const entry = this.cameras.get(cameraId);
    if (!entry) return;
    for (const disposer of entry.disposers) disposer.unsubscribe();
    await entry.speaker.close();
    this.cameras.delete(cameraId);
    for (const [panelId, own] of this.own) if (own.cameraId === cameraId) this.own.delete(panelId);
  }

  private onDetection(entry: CameraEntry, type: string, event: DetectionEvent): void {
    const faces: { name: string; score: number }[] = [];
    const plates: { plate: string; score: number }[] = [];
    let person = false;
    let inZone = false;
    const zones = new Set(
      this.store
        .panels()
        .filter((p) => p.cameraId === entry.device.id && p.presenceZone)
        .map((p) => p.presenceZone!),
    );
    for (const segment of event.segments ?? []) {
      const people = (segment.detections ?? []).some((d) => d.label === 'person');
      if (people) {
        person = true;
        if (segment.zones?.some((zone) => zones.has(zone))) inZone = true;
      }
      for (const attribute of segment.attributes ?? []) {
        if (attribute.type === 'face' && attribute.label && attribute.label !== 'unknown') faces.push({ name: attribute.label, score: attribute.confidence ?? 0 });
        else if (attribute.type === 'license_plate' && attribute.label) plates.push({ plate: attribute.label, score: attribute.confidence ?? 0 });
      }
    }
    if (person) entry.personAt = Date.now();
    if (faces.length || plates.length) this.intercom.sighting(entry.device.id, faces, plates);
    if (zones.size) {
      if (type === 'end' || event.state === 'ended') this.intercom.presence(entry.device.id, false);
      else if (inZone) this.intercom.presence(entry.device.id, true);
    }
  }

  // ---- sensors of other plugins ----

  async configureSensors(sensors: SensorLike[]): Promise<void> {
    for (const sensor of sensors) await this.onSensorAdded(sensor);
  }

  async onSensorAdded(sensor: SensorLike): Promise<void> {
    await this.onSensorReleased(sensor.id);
    const entry: { sensor: SensorLike; disposers: { unsubscribe(): void }[]; offlineSince?: number; reported?: boolean } = { sensor, disposers: [] };
    this.sensors.set(sensor.id, entry);
    if (sensor.type === SensorType.Doorbell) {
      entry.disposers.push(
        sensor.onPropertyChanged.subscribe(({ property, value }) => {
          if (property !== 'ring' || value !== true) return;
          for (const panel of this.store.panels().filter((p) => p.doorbellSensorIds.includes(sensor.id))) this.intercom.press(panel.id);
        }),
      );
      entry.disposers.push(
        sensor.onConnectedChanged.subscribe((connected) => {
          if (!connected) entry.offlineSince ??= Date.now();
          else
            this.backOnline(
              entry,
              this.store.panels().find((p) => p.doorbellSensorIds.includes(sensor.id)),
            );
        }),
      );
      if (!sensor.connected) entry.offlineSince = Date.now();
    }
  }

  async onSensorReleased(sensorId: string): Promise<void> {
    const entry = this.sensors.get(sensorId);
    if (!entry) return;
    for (const disposer of entry.disposers) disposer.unsubscribe();
    this.sensors.delete(sensorId);
  }

  // ---- driver panels: engines and own sensors ----

  private credentials(panel: Panel): Credentials | undefined {
    const driver = panel.driver;
    if (!driver) return undefined;
    return {
      host: driver.host,
      httpPort: driver.httpPort,
      rtspPort: driver.rtspPort,
      username: driver.username,
      password: this.intercom.panelPassword(panel.id),
    };
  }

  /** Engines and own sensors follow the stored panels: started, restarted when their address changed, stopped. */
  private async syncPanels(): Promise<void> {
    const sipWanted = this.store.panels().some((panel) => panel.enabled && panel.driver && this.catalog.get(panel.driver.profileId)?.engine === 'sip');
    await this.syncSip(sipWanted);
    const wanted = new Set<string>();
    for (const panel of this.store.panels()) {
      const profile = panel.driver ? this.catalog.get(panel.driver.profileId) : undefined;
      const credentials = this.credentials(panel);
      if (!panel.enabled || !profile || !credentials || profile.engine === 'generic' || profile.events.via === 'sensors') continue;
      const sip = profile.engine === 'sip';
      // a SIP panel follows the SIP server too: a new port is a new server
      const key = JSON.stringify([profile.id, profile.version, credentials, sip ? this.sipGeneration : 0]);
      wanted.add(panel.id);
      const running = this.engines.get(panel.id);
      if (running?.key === key) continue;
      running?.engine.stop();
      const entry = { key } as EngineEntry;
      const listener: PanelListener = {
        event: (kind, fields) => this.onPanelEvent(panel.id, kind, fields, entry),
        online: (ok, reason) => {
          if (ok) this.backOnline(entry, this.store.panel(panel.id));
          else {
            entry.offlineSince ??= Date.now();
            this.logger.debug(`${panel.name}: not answering${reason ? `: ${reason}` : ''}`);
          }
        },
      };
      const options = { log: (message: string) => this.logger.debug(`${panel.name}: ${message}`) };
      entry.engine = sip ? new SipPanel(profile, credentials, listener, () => this.sip, options) : new HttpPanel(profile, credentials, listener, options);
      this.engines.set(panel.id, entry);
      entry.engine.start();
    }
    for (const [panelId, entry] of this.engines) {
      if (wanted.has(panelId)) continue;
      entry.engine.stop();
      this.engines.delete(panelId);
    }
    await this.syncOwnSensors();
  }

  /** The SIP server is open while a panel calls over SIP, on the port of the settings. */
  private async syncSip(wanted: boolean): Promise<void> {
    const port = this.intercom.settings().sipPort;
    if (this.sip && (!wanted || this.sip.port !== port)) {
      await this.sip.stop().catch(() => undefined);
      this.sip = undefined;
    }
    if (!wanted) {
      this.sipProblem = undefined;
      return;
    }
    if (this.sip) return;
    const server = new SipServer({ port, log: (message) => this.logger.debug(message) });
    try {
      await server.start();
      this.sip = server;
      this.sipGeneration++;
      this.sipProblem = undefined;
      this.logger.log(`SIP: the panels call in on UDP ${port} (the home network only)`);
    } catch (error) {
      this.sipProblem = `the SIP port ${port} could not be opened: ${(error as Error).message}`;
      this.logger.warn(this.sipProblem);
    }
  }

  private onPanelEvent(panelId: string, kind: PanelEventKind, fields: Record<string, string>, entry: EngineEntry): void {
    const panel = this.store.panel(panelId);
    if (!panel) return;
    switch (kind) {
      case 'ring':
        this.own.get(panelId)?.doorbell?.trigger();
        this.intercom.press(panelId);
        return;
      case 'door_open':
        entry.doorOpenAt = Date.now();
        return;
      case 'call_end':
        this.intercom.panelHungUp(panelId, entry.engine instanceof SipPanel);
        return;
      case 'code':
        // a code typed at the panel during its SIP call: checked like one typed anywhere
        if (fields.digits) void this.intercom.panelInput(panel.cameraId, fields.digits).catch(() => undefined);
        return;
      case 'tamper':
        void this.api.notificationManager.publish({
          title: ownerText(this.language(), 'tamperTitle', { panel: panel.name }),
          severity: Severity.Critical,
          tag: `intercom-tamper:${panel.id}`,
        });
        return;
      default:
        return;
    }
  }

  /** The doorbell and the door locks of each driver panel, on its camera. */
  private async syncOwnSensors(): Promise<void> {
    for (const panel of this.store.panels()) {
      const profile = panel.driver ? this.catalog.get(panel.driver.profileId) : undefined;
      const device = this.cameras.get(panel.cameraId)?.device;
      if (!profile || !device || !panel.enabled) continue;
      let own = this.own.get(panel.id);
      if (own && own.cameraId !== device.id) own = undefined;
      if (!own) {
        own = { cameraId: device.id, locks: new Map() };
        this.own.set(panel.id, own);
      }
      try {
        if (!own.doorbell && profile.events.via !== 'sensors') {
          const doorbell = new DoorbellTrigger(panel.name, { nativeId: `intercom-doorbell:${panel.id}` });
          await device.addSensor(doorbell);
          own.doorbell = doorbell;
          if (!panel.doorbellSensorIds.includes(doorbell.id)) {
            this.store.savePanel({ ...panel, doorbellSensorIds: [...panel.doorbellSensorIds, doorbell.id] });
          }
        }
        for (const door of panel.doors) {
          if (door.via.kind !== 'panel' || own.locks.has(door.id)) continue;
          const lock = new PanelLock(`${panel.name}: ${door.name}`, `intercom-lock:${panel.id}:${door.id}`, async () => {
            await this.intercom.openFromSensor(panel.id, door.id);
          });
          await device.addSensor(lock);
          await lock.reflect(LockState.Secured);
          own.locks.set(door.id, lock);
        }
      } catch (error) {
        this.logger.warn(`${panel.name}: the doorbell and locks of the panel: ${(error as Error).message}`);
      }
    }
  }

  // ---- settings page ----

  get storageSchema(): JsonSchema[] {
    const bridge = (key: string, read: () => unknown, write: (value: unknown) => Record<string, unknown>) => ({
      store: false,
      onGet: async () => read(),
      onSet: async (value: unknown) => {
        this.intercom.setSettings(SETTINGS_ACTOR, write(value));
      },
      key,
    });
    const s = () => this.intercom.settings();
    return [
      {
        type: 'string',
        title: 'Now',
        description: 'Panels, the mode of the house, calls in progress. Panels are added on the Intercom page.',
        format: 'textarea',
        readonly: true,
        key: 'status',
        store: false,
        onGet: async () => this.statusText(),
        group: 'Intercom',
      },
      {
        type: 'string',
        title: 'Language',
        description: 'The door agent speaks and listens in this language; the notifications use it too.',
        enum: ['ru', 'en', 'de'],
        enumLabels: { ru: 'Russian', en: 'English', de: 'German' },
        group: 'Intercom',
        ...bridge(
          'language',
          () => s().language ?? 'ru',
          (value) => ({ language: value }),
        ),
      },
      {
        type: 'string',
        title: 'Time zone',
        description: "The household's time zone, e.g. Europe/Moscow: instructions, the night and modes follow it. Empty: the server's.",
        placeholder: serverTimeZone(),
        group: 'Intercom',
        ...bridge(
          'timeZone',
          () => s().timeZone ?? '',
          (value) => ({ timeZone: value }),
        ),
      },
      {
        type: 'boolean',
        title: 'The door agent answers',
        description: 'When nobody answered in the time of the mode, the agent talks to the visitor through the panel.',
        group: 'Door agent',
        ...bridge(
          'agentEnabled',
          () => s().agent.enabled,
          (value) => ({ agent: { enabled: value === true } }),
        ),
      },
      {
        type: 'string',
        title: 'Greeting',
        description: 'Empty: "Hello! The conversation is recorded. How can I help?"',
        group: 'Door agent',
        ...bridge(
          'greeting',
          () => s().agent.greeting ?? '',
          (value) => ({ agent: { greeting: value } }),
        ),
      },
      {
        type: 'string',
        title: 'House rules',
        description: 'What the agent may tell any visitor: "parcels go into the box at the gate". Anyone at the door may hear it.',
        format: 'textarea',
        group: 'Door agent',
        ...bridge(
          'houseRules',
          () => s().agent.houseRules ?? '',
          (value) => ({ agent: { houseRules: value } }),
        ),
      },
      {
        type: 'boolean',
        title: 'Describe the picture',
        description: 'Before the greeting the assistant looks at the snapshot ("a man with a box"). Needs a model that sees pictures.',
        group: 'Door agent',
        ...bridge(
          'describe',
          () => s().agent.describe,
          (value) => ({ agent: { describe: value === true } }),
        ),
      },
      {
        type: 'number',
        title: 'Keep visits, days',
        description: 'Visits, their snapshots and voice messages are removed after this. The video stays as long as the recorder keeps it.',
        minimum: 1,
        maximum: 3650,
        group: 'Archive',
        ...bridge(
          'retentionDays',
          () => s().retentionDays,
          (value) => ({ retentionDays: Number(value) }),
        ),
      },
      {
        type: 'number',
        title: 'SIP port',
        description: 'Panels that call over SIP (RUBITEK path B) call this UDP port directly. Only the panels added here are answered; never forward it to the internet.',
        minimum: 1024,
        maximum: 65535,
        group: 'Panels',
        ...bridge(
          'sipPort',
          () => s().sipPort,
          (value) => ({ sipPort: Number(value) }),
        ),
      },
      {
        type: 'string',
        title: 'Assistant',
        description: 'The agent asks the assistant to write its phrases. Without it the agent speaks from ready phrases.',
        readonly: true,
        key: 'assistant',
        store: false,
        onGet: async () => (this.allowed.ok ? 'Allowed' : 'Not allowed: turn the intercom on in Settings → Assistant. Until then the agent uses ready phrases.'),
        group: 'Door agent',
      },
    ] as JsonSchema[];
  }

  private statusText(): string {
    const state = this.intercom.intercomState(SETTINGS_ACTOR);
    const panels = (state.panels as { name: string; speakProblem?: string }[]).map(
      (p) => `${p.name}${p.speakProblem ? ` (the agent cannot speak: ${p.speakProblem})` : ''}`,
    );
    const mode = state.mode as { mode: string; until?: number };
    const sip = this.sip ? `SIP: the panels call in on UDP ${this.sip.port}` : this.sipProblem ? `SIP: ${this.sipProblem}` : undefined;
    return [`Panels: ${panels.join(', ') || 'none yet'}`, `Mode: ${mode.mode}${mode.until ? ` until ${new Date(mode.until).toLocaleString()}` : ''}`, sip]
      .filter(Boolean)
      .join('\n');
  }

  // ---- assistant tools ----

  assistantTools(): AssistantToolSpec[] {
    return TOOLS;
  }

  async callAssistantTool(name: string, input: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    return callTool(this.intercom, name, input ?? {}, ctx);
  }

  // ---- public methods: the server's /api/intercom calls them with the user of the session ----

  async intercomState(actor: unknown) {
    return this.intercom.intercomState(asActor(actor));
  }

  async callState(actor: unknown, callId: string) {
    return this.intercom.callState(asActor(actor), callId);
  }

  async answerCall(actor: unknown, callId: string) {
    return this.intercom.answerCall(asActor(actor), callId);
  }

  async declineCall(actor: unknown, callId: string) {
    return this.intercom.declineCall(asActor(actor), callId);
  }

  async handToAgent(actor: unknown, callId: string) {
    return this.intercom.handToAgent(asActor(actor), callId);
  }

  async takeOver(actor: unknown, callId: string) {
    return this.intercom.takeOver(asActor(actor), callId);
  }

  async hangUpCall(actor: unknown, callId: string) {
    return this.intercom.hangUpCall(asActor(actor), callId);
  }

  async sayInCall(actor: unknown, callId: string, text: string, options?: { verbatim?: boolean }) {
    return this.intercom.sayInCall(asActor(actor), callId, text, options?.verbatim !== false);
  }

  async quickAnswer(actor: unknown, callId: string, option: string) {
    return this.intercom.quickAnswer(asActor(actor), callId, option);
  }

  async openDoor(actor: unknown, panelId: string, doorId: string) {
    return this.intercom.openDoorAs(asActor(actor), panelId, doorId);
  }

  async visits(actor: unknown, query: VisitQuery) {
    return this.intercom.visits(asActor(actor), query ?? {});
  }

  async visit(actor: unknown, id: string) {
    return this.intercom.visit(asActor(actor), id);
  }

  async visitFile(actor: unknown, id: string, name: string) {
    return this.intercom.visitFile(asActor(actor), id, name);
  }

  async deleteVisit(actor: unknown, id: string) {
    return this.intercom.deleteVisit(asActor(actor), id);
  }

  async markVisitSeen(actor: unknown, id: string) {
    return this.intercom.markVisitSeen(asActor(actor), id);
  }

  async setVisitPerson(actor: unknown, visitId: string, personId: string) {
    return this.intercom.setVisitPerson(asActor(actor), visitId, personId);
  }

  async visitCompanies(actor: unknown) {
    asActor(actor);
    return this.intercom.companies();
  }

  async doorLog(actor: unknown, query: { panelId?: string; from?: number; to?: number; limit?: number }) {
    return this.intercom.doorLog(asActor(actor), query ?? {});
  }

  async instructions(actor: unknown, all?: boolean) {
    return this.intercom.instructions(asActor(actor), all === true);
  }

  async addInstruction(actor: unknown, input: Record<string, unknown>) {
    return this.intercom.addInstruction(asActor(actor), input);
  }

  async updateInstruction(actor: unknown, id: string, input: Record<string, unknown>) {
    return this.intercom.updateInstruction(asActor(actor), id, input);
  }

  async cancelInstruction(actor: unknown, id: string) {
    return this.intercom.cancelInstruction(asActor(actor), id);
  }

  async people(actor: unknown) {
    return this.intercom.people(asActor(actor));
  }

  async peopleNames(actor: unknown) {
    asActor(actor);
    return this.intercom.peopleNames();
  }

  async setPerson(actor: unknown, input: Record<string, unknown>) {
    return this.intercom.setPerson(asActor(actor), input);
  }

  async deletePerson(actor: unknown, id: string) {
    return this.intercom.deletePerson(asActor(actor), id);
  }

  async guestCodes(actor: unknown) {
    return this.intercom.guestCodes(asActor(actor));
  }

  async createGuestCode(actor: unknown, input: Record<string, unknown>) {
    return this.intercom.createGuestCode(asActor(actor), input);
  }

  async revokeGuestCode(actor: unknown, id: string) {
    return this.intercom.revokeGuestCode(asActor(actor), id);
  }

  async setMode(actor: unknown, mode: string, until?: number) {
    return this.intercom.setMode(asActor(actor), mode, until);
  }

  async getSettings(actor: unknown) {
    return this.intercom.getSettings(asActor(actor));
  }

  async setSettings(actor: unknown, patch: Record<string, unknown>) {
    return this.intercom.setSettings(asActor(actor), patch);
  }

  async panels(actor: unknown) {
    return this.intercom.panels(asActor(actor));
  }

  async savePanel(actor: unknown, input: Record<string, unknown>) {
    return this.intercom.savePanel(asActor(actor), input);
  }

  async deletePanel(actor: unknown, id: string) {
    return this.intercom.deletePanel(asActor(actor), id);
  }

  async simulate(actor: unknown, sessionId: string, text: string, options?: { panelId?: string; personId?: string }) {
    return this.intercom.simulate(asActor(actor), sessionId, text, options ?? {});
  }

  /** For VOICE: the panels' cameras, where the agent speaks and VOICE must not. */
  async panelCameraIds(): Promise<string[]> {
    return this.intercom.panelCameraIds();
  }

  /** Digits typed on a panel's keypad (an engine or another plugin): a code or a PIN. */
  async panelInput(cameraId: string, input: { digits?: string }): Promise<{ opened: boolean }> {
    return { opened: await this.intercom.panelInput(cameraId, String(input?.digits ?? '')) };
  }

  async panelProfiles(actor: unknown) {
    needAdmin(asActor(actor));
    return this.catalog.list().map((choice) => ({
      id: choice.profile.id,
      vendor: choice.profile.vendor,
      models: choice.profile.models,
      engine: choice.profile.engine,
      status: choice.profile.status,
      version: choice.profile.version,
      source: choice.source,
      usable: choice.usable,
      why: choice.why,
      doors: choice.profile.doors.map((d) => ({ key: d.key, name: d.name })),
      events: choice.profile.events.via,
      features: choice.profile.features,
      setup: choice.profile.setup.map((key) => this.setupText(key)),
      quirks: choice.profile.quirks,
      ownVideoAddress: !choice.profile.video.main,
    }));
  }

  /** A step of a profile's setup ("setup.rubetek.sipDirect") in the household's language; the key when it has no text. */
  private setupText(key: string): string {
    const texts = ownerTexts(this.language()).setup as Record<string, string> | undefined;
    const text = texts?.[key.replace(/^setup\./, '')];
    return text ? text.replaceAll('{port}', String(this.intercom.settings().sipPort)) : key;
  }

  async refreshProfiles(actor: unknown) {
    needAdmin(asActor(actor));
    const result = await this.catalog.refresh();
    this.catalogAt = Date.now();
    return result;
  }

  private draft(input: Record<string, unknown>): { profile: PanelProfile; credentials: Credentials } {
    const profile = this.catalog.list().find((c) => c.profile.id === input.profileId && c.usable)?.profile;
    if (!profile) throw new IntercomError('invalid', `no usable model "${String(input.profileId)}"`);
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    if (!validHost(host)) throw new IntercomError('invalid', 'host: an IP address or a name, without a scheme or a port');
    const port = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : Number(value));
    let password = typeof input.password === 'string' ? input.password : '';
    // checking a saved panel again: its stored password, which the wizard never gets back
    if (!password && typeof input.panelId === 'string') password = this.intercom.panelPassword(input.panelId);
    return {
      profile,
      credentials: { host, httpPort: port(input.httpPort), rtspPort: port(input.rtspPort), username: typeof input.username === 'string' ? input.username : '', password },
    };
  }

  /** The wizard's check of a panel: the login, the model and firmware it reports, what to turn on (ТЗ 14.3). */
  async panelProbe(actor: unknown, input: Record<string, unknown>) {
    needAdmin(asActor(actor));
    const { profile, credentials } = this.draft(input ?? {});
    const probe = await new HttpPanel(profile, credentials, { event: () => undefined, online: () => undefined }).probe();
    const warnings: string[] = [];
    if (probe.model && !profile.models.some((m) => probe.model!.toUpperCase().includes(m.toUpperCase()))) {
      warnings.push(`the panel says it is "${probe.model}", the chosen model is ${profile.models.join(', ')}`);
    }
    return { ...probe, warnings, setup: profile.setup.map((key) => this.setupText(key)), quirks: profile.quirks ?? [] };
  }

  /** The camera of a new driver panel, for the server to create (ТЗ 14.3, 14.4). */
  async panelCameraConfig(actor: unknown, input: Record<string, unknown>) {
    needAdmin(asActor(actor));
    const { profile, credentials } = this.draft(input ?? {});
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : profile.vendor;
    const config = cameraConfig(profile, credentials, name, typeof input.rtspUrl === 'string' ? input.rtspUrl.trim() : undefined);
    if (typeof config === 'string') throw new IntercomError('invalid', config);
    return config;
  }

  /** An event a panel sent to the server's hook address; the token is checked here. */
  async panelHook(panelId: string, token: string, request: { query?: Record<string, string>; body?: string; contentType?: string }) {
    const panel = this.store.panel(panelId);
    if (!panel?.enabled || !(await this.intercom.hookTokenMatches(panel, token))) throw new IntercomError('not_found', 'no such hook');
    const engine = this.engines.get(panel.id);
    if (!engine) throw new IntercomError('unavailable', 'the panel is not connected');
    const kinds = engine.engine.hook({ query: request?.query ?? {}, body: request?.body, contentType: request?.contentType });
    return { events: kinds };
  }
}
