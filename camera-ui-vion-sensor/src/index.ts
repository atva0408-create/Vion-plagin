import { API_EVENT, BasePlugin, SensorType } from '@camera.ui/sdk';

import { SensorClient, SensorRequestError } from './device.js';
import { SensorFinder } from './discovery.js';
import { DEFAULT_MANIFEST_URL, newer, readManifest } from './firmware.js';
import { VionMotionSensor, VionPresenceSensor } from './sensor.js';

import type {
  AdoptedSensor,
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveredSensor,
  DiscoveryProvider,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
  Sensor,
  SensorDiscoveryProvider,
  SnapshotInterface,
  StreamingInterface,
} from '@camera.ui/sdk';
import type { RadarTarget, SensorConfigPatch, SensorInfo, SensorState } from './device.js';
import type { FoundSensor } from './discovery.js';
import type { FirmwareRelease } from './firmware.js';
import type { MotionSource } from './sensor.js';

export interface VionSensorConfig {
  /** Addresses typed by hand, for networks where the mDNS search does not reach. */
  addresses?: string;
  manifestUrl?: string;
  /** The token each board gave this ViON when it was added, by board id. Kept after a removal: adding it again works. */
  tokens?: Record<string, string>;
  /** Which algorithm of each board makes its motion, by board id; none — ViON's own. */
  motionSources?: Record<string, MotionSource>;
}

export interface VionSensorLive {
  sensorId: string;
  cameraId: string | null;
  state: 'quiet' | 'motion' | 'calibrating' | 'blind' | 'offline';
  calibrationLeftS: number;
  level: number;
  threshold: number;
  rssi: number;
  packetsPerS: number;
  /** Presence by the Espressif algorithm; null — the firmware has none (before 1.1.0) or the board is not read yet. */
  presence: { state: 'present' | 'absent' | 'learning' | 'untrained'; level: number; threshold: number } | null;
  /** The HLK-LD2450 radar; null — none is wired. Targets in millimetres from the radar: x to the side, y ahead. */
  radar: { targets: RadarTarget[] } | null;
}

const SENSOR_PREFIX = 'vs:';
const PRESENCE_PREFIX = 'vp:';
/** The first firmware with presence (Espressif esp-radar) and the radar. */
const PRESENCE_FIRMWARE = '1.1.0';
const CAMERA_PREFIX = 'vs-cam:';
const POLL_MS = 1000;
const MOTION_SOURCE_NAMES: Record<MotionSource, string> = { vion: 'ViON', espressif: 'Espressif', any: 'either algorithm' };
/** Polls that may fail before the sensor is shown as unavailable: one lost answer on Wi-Fi is not an outage. */
const FAILURES_BEFORE_OFFLINE = 3;
const PULSE_MS = 2000;
const ADDRESS_PROBE_MS = 60_000;
const MANIFEST_MS = 6 * 60 * 60_000;

interface Bound {
  id: string;
  sensorId: string;
  sensor: VionMotionSensor;
  client: SensorClient;
  timer?: NodeJS.Timeout;
  polling?: boolean;
  failures: number;
  events?: number;
  motion: boolean;
  pulse?: NodeJS.Timeout;
  info?: SensorInfo;
  state?: SensorState;
  /** Said once per learning: presence was not learned. */
  untrainedTold?: boolean;
  /** Said once per failed version: the update did not start. */
  failedTold?: string;
}

function boardId(nativeId: string): string {
  for (const prefix of [SENSOR_PREFIX, PRESENCE_PREFIX]) if (nativeId.startsWith(prefix)) return nativeId.slice(prefix.length);
  return nativeId;
}

function hasPresence(info: SensorInfo): boolean {
  return !newer(PRESENCE_FIRMWARE, info.firmware);
}

function presenceLive(state: SensorState | undefined): VionSensorLive['presence'] {
  const p = state?.presence;
  if (!p) return null;
  const kind = p.training ? 'learning' : !p.trained ? 'untrained' : p.present ? 'present' : 'absent';
  return { state: kind, level: Number.isFinite(p.level) ? p.level : 0, threshold: Number.isFinite(p.wander_threshold) ? p.wander_threshold : 0 };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class VionSensorPlugin extends BasePlugin<VionSensorConfig> implements SensorDiscoveryProvider, DiscoveryProvider {
  private finder = new SensorFinder(
    (found) => this.onFound(found),
    (message) => this.logger.warn(message),
  );

  private bound = new Map<string, Bound>();
  /** The presence sensors, by board id: kept apart from the motion ones, which can be removed while these stay. */
  private presences = new Map<string, VionPresenceSensor>();
  private cameras = new Map<string, CameraDevice>();
  private probeTimer?: NodeJS.Timeout;
  private manifestTimer?: NodeJS.Timeout;
  private release?: FirmwareRelease;
  private started = false;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<VionSensorConfig>) {
    super(logger, api, storage);
    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'addresses',
        title: 'Sensor addresses',
        description:
          'Sensors are found in the network by themselves. If yours does not appear in Sensors, Found, ' +
          'type its address here (several separated by commas), e.g. 192.168.1.50.',
        placeholder: '192.168.1.50',
        store: true,
        onSet: async () => this.probeAddresses(),
      },
      {
        type: 'string',
        key: 'manifestUrl',
        title: 'Firmware updates',
        description: 'Where the list of firmware versions is read from.',
        defaultValue: DEFAULT_MANIFEST_URL,
        store: true,
        onSet: async () => this.checkFirmware(),
      },
    ];
  }

  private start(): void {
    this.started = true;
    this.finder.start();
    void this.probeAddresses();
    this.probeTimer = setInterval(() => void this.probeAddresses(), ADDRESS_PROBE_MS);
    void this.checkFirmware();
    this.manifestTimer = setInterval(() => void this.checkFirmware(), MANIFEST_MS);
    for (const bound of this.bound.values()) this.startPolling(bound);
  }

  private stop(): void {
    this.started = false;
    this.finder.stop();
    clearInterval(this.probeTimer);
    clearInterval(this.manifestTimer);
    for (const bound of this.bound.values()) {
      clearTimeout(bound.timer);
      clearTimeout(bound.pulse);
    }
  }

  // ---- finding boards ------------------------------------------------------------------------------------------------

  private addresses(): string[] {
    return (this.storage.values.addresses ?? '')
      .split(/[,\s;]+/)
      .map((a) => a.trim())
      .filter(Boolean);
  }

  private async probeAddresses(): Promise<void> {
    await Promise.all(
      this.addresses().map(async (address) => {
        try {
          const info = await new SensorClient(address).info();
          if (info.kind === 'vion-sensor') this.finder.remember({ id: info.id.toUpperCase(), address, name: info.name, firmware: info.firmware });
        } catch {
          // not there now: the next probe tries again
        }
      }),
    );
  }

  /** A board was seen, maybe at a new address: a bound sensor follows it. */
  private onFound(found: FoundSensor): void {
    const bound = this.bound.get(found.id);
    if (bound && bound.client.address !== found.address) {
      this.logger.log(`${found.name} is now at ${found.address}`);
      bound.client.address = found.address;
    }
  }

  private token(id: string): string | undefined {
    return this.storage.values.tokens?.[id];
  }

  private async saveToken(id: string, token: string): Promise<void> {
    await this.storage.setInternalValue('tokens', { ...(this.storage.values.tokens ?? {}), [id]: token });
  }

  // ---- sensors -------------------------------------------------------------------------------------------------------

  async onDiscoverSensors(): Promise<DiscoveredSensor[]> {
    await this.probeAddresses();
    // an added board is polled at its known address: it stays a candidate when its mDNS answer does not come again
    // (a weak Wi-Fi, a restart of the plugin), or its presence would never be offered
    const candidates = new Map<string, { id: string; address: string; name: string }>();
    for (const bound of this.bound.values()) {
      if (bound.client.address) candidates.set(bound.id, { id: bound.id, address: bound.client.address, name: bound.sensor.name });
    }
    for (const found of this.finder.found.values()) candidates.set(found.id, found);
    const result: DiscoveredSensor[] = [];
    for (const found of candidates.values()) {
      // what the polls already know: no extra request to a board on a weak Wi-Fi
      let info: SensorInfo | undefined = this.bound.get(found.id)?.info;
      if (!info) {
        try {
          info = await new SensorClient(found.address).info();
        } catch {
          continue;
        }
      }
      // a board added to another ViON answers only that one: offering it here would end in a refusal
      if (info.paired && !this.token(found.id)) continue;
      result.push({
        id: `${SENSOR_PREFIX}${found.id}`,
        address: found.address,
        name: info.name || found.name,
        type: SensorType.Motion,
        room: info.room || undefined,
        manufacturer: 'ViON',
        model: info.model,
      });
      // presence reads the same board as its motion sensor: it is offered once that one is added
      if (this.bound.has(found.id) && !this.presences.has(found.id) && hasPresence(info)) {
        result.push({
          id: `${PRESENCE_PREFIX}${found.id}`,
          address: found.address,
          name: `${info.name || found.name} presence`,
          type: SensorType.Occupancy,
          room: info.room || undefined,
          manufacturer: 'ViON',
          model: info.model,
        });
      }
    }
    return result;
  }

  async configureAdoptedSensors(records: AdoptedSensor[]): Promise<Sensor<any, any, any>[]> {
    const isPresence = (record: AdoptedSensor) => record.nativeId.startsWith(PRESENCE_PREFIX);
    // motion first: a presence sensor finds its board through it
    const motion = records.filter((record) => !isPresence(record)).map((record) => this.bind(record).sensor);
    const presence = records.filter(isPresence).map((record) => this.bindPresence(record));
    return [...motion, ...presence];
  }

  async onSensorAdopted(record: AdoptedSensor): Promise<Sensor<any, any, any>> {
    const id = boardId(record.nativeId);
    if (record.nativeId.startsWith(PRESENCE_PREFIX)) {
      if (!this.bound.has(id)) throw new Error(`Add the motion sensor of ${record.name} first: presence reads the same board`);
      this.logger.log(`Added sensor ${record.name}`);
      return this.bindPresence(record);
    }
    if (!this.token(id)) {
      const address = this.finder.found.get(id)?.address ?? record.address;
      if (!address) throw new Error(`The sensor ${record.name} is not in the network now`);
      try {
        const paired = await new SensorClient(address).pair();
        await this.saveToken(id, paired.token);
      } catch (error) {
        if (error instanceof SensorRequestError && error.status === 409) {
          throw new Error(`${record.name} belongs to another ViON. Reset it (three quick power-ons) to add it here`);
        }
        throw error;
      }
    }
    this.logger.log(`Added sensor ${record.name}`);
    return this.bind(record).sensor;
  }

  async onSensorUnadopted(nativeId: string): Promise<void> {
    const id = boardId(nativeId);
    if (nativeId.startsWith(PRESENCE_PREFIX)) {
      this.presences.delete(id);
      return;
    }
    // presence without its board says nothing: unknown, not "nobody"
    this.presences.get(id)?.setSourceState('unavailable');
    const bound = this.bound.get(id);
    if (!bound) return;
    clearTimeout(bound.timer);
    clearTimeout(bound.pulse);
    this.bound.delete(id);
  }

  private bind(record: AdoptedSensor): Bound {
    const id = boardId(record.nativeId);
    const existing = this.bound.get(id);
    if (existing) return existing;
    const address = this.finder.found.get(id)?.address ?? record.address ?? '';
    const client = new SensorClient(address, this.token(id));
    const bound: Bound = { id, sensorId: record.id, client, failures: 0, motion: false } as Bound;
    bound.sensor = new VionMotionSensor(record.name, record.nativeId, {
      configure: (patch) => this.configure(bound, patch),
      recalibrate: async () => {
        await bound.client.recalibrate();
        this.logger.log(`${record.name}: calibrating for 30 s, keep the room empty`);
      },
      update: () => this.updateFirmware(bound),
      reset: () => this.reset(bound),
      motionSource: () => this.motionSource(id),
      setMotionSource: async (source) => {
        await this.storage.setInternalValue('motionSources', { ...(this.storage.values.motionSources ?? {}), [id]: source });
        this.logger.log(`${record.name}: motion now from ${MOTION_SOURCE_NAMES[source]}`);
        if (bound.state) this.applyMotion(bound, bound.state);
      },
    });
    if (address) bound.sensor.setAddress(address.split(':')[0]);
    this.bound.set(id, bound);
    if (this.started) this.startPolling(bound);
    // a sensor added now shows a newer firmware at once, not after the next scheduled reading of the list
    if (this.started && !this.release) void this.checkFirmware();
    return bound;
  }

  private bindPresence(record: AdoptedSensor): VionPresenceSensor {
    const id = boardId(record.nativeId);
    let sensor = this.presences.get(id);
    if (!sensor) {
      sensor = new VionPresenceSensor(record.name, record.nativeId);
      this.presences.set(id, sensor);
    }
    const bound = this.bound.get(id);
    if (bound?.client.address) sensor.setAddress(bound.client.address.split(':')[0]);
    this.applyPresence(id, bound?.state);
    return sensor;
  }

  private motionSource(id: string): MotionSource {
    return this.storage.values.motionSources?.[id] ?? 'vion';
  }

  private startPolling(bound: Bound): void {
    clearTimeout(bound.timer);
    const tick = async () => {
      if (!this.bound.has(bound.id)) return;
      await this.poll(bound);
      if (this.bound.has(bound.id)) bound.timer = setTimeout(tick, POLL_MS);
    };
    bound.timer = setTimeout(tick, 0);
  }

  private async poll(bound: Bound): Promise<void> {
    const sensor = bound.sensor;
    try {
      bound.client.token ??= this.token(bound.id);
      if (!bound.client.address) throw new SensorRequestError('no address yet');
      // the settings show the board's own values: read them once, and again after it restarted
      if (!bound.info || (bound.state && bound.state.uptime_s < 5)) {
        bound.info = await bound.client.info();
        const failed = bound.info.update_failed;
        if (failed && failed !== bound.failedTold) {
          this.logger.warn(`${sensor.name}: firmware ${failed} did not start, the board went back to ${bound.info.firmware}`);
        }
        bound.failedTold = failed;
      }
      const state = await bound.client.state();
      if (bound.failures >= FAILURES_BEFORE_OFFLINE) this.logger.log(`${sensor.name} is back`);
      bound.failures = 0;
      const restarted = bound.state !== undefined && state.uptime_s < bound.state.uptime_s;
      if (restarted) bound.events = undefined;
      bound.state = state;
      sensor.setSourceState(state.blind ? 'unavailable' : 'connected');
      this.applyMotion(bound, state);
      this.applyPresence(bound.id, state);
      sensor.show(bound.info, state, this.release);
    } catch (error) {
      bound.failures++;
      if (bound.failures === FAILURES_BEFORE_OFFLINE) {
        this.logger.warn(`${sensor.name} does not answer: ${errorText(error)}`);
        sensor.setSourceState('unavailable');
        this.applyMotion(bound, undefined);
        this.applyPresence(bound.id, undefined);
      }
      if (error instanceof SensorRequestError && error.status === 401) {
        // the board was reset and added nowhere: its old token no longer opens it
        if (bound.failures === FAILURES_BEFORE_OFFLINE) this.logger.warn(`${sensor.name} no longer knows this ViON: remove the sensor and add it again`);
      }
      const found = this.finder.found.get(bound.id);
      if (found && found.address !== bound.client.address) bound.client.address = found.address;
    }
  }

  /** Motion as ViON sees it: on while the board says so, and a short pulse for a motion that started and ended between two polls. */
  private applyMotion(bound: Bound, state: SensorState | undefined): void {
    const source = this.motionSource(bound.id);
    const espressif = !!state?.presence?.trained && state.presence.motion;
    const vion = !!state?.motion;
    const raw = source === 'espressif' ? espressif : source === 'any' ? vion || espressif : vion;
    const motion = !!state && !state.calibrating && !state.blind && raw;
    // the events counter is ViON's: a motion too short for a poll is caught only for it
    const missed = source !== 'espressif' && !!state && bound.events !== undefined && state.events > bound.events && !motion;
    if (state) bound.events = state.events;
    if (missed && !bound.pulse) {
      bound.sensor.reportDetections(true);
      bound.pulse = setTimeout(() => {
        bound.pulse = undefined;
        if (!bound.motion) bound.sensor.reportDetections(false);
      }, PULSE_MS);
    }
    if (motion !== bound.motion) {
      bound.motion = motion;
      if (!bound.pulse) bound.sensor.reportDetections(motion);
    }
  }

  /** Presence as ViON sees it: unknown while the board learns, could not learn, sees nothing or does not answer. */
  private applyPresence(id: string, state: SensorState | undefined): void {
    const presence = state?.presence;
    const bound = this.bound.get(id);
    if (bound && presence) {
      if (presence.training) bound.untrainedTold = false;
      else if (!presence.trained && !bound.untrainedTold) {
        bound.untrainedTold = true;
        const why = `the Wi-Fi signal was too uneven (${presence.windows_per_s} readings/s)`;
        this.logger.warn(`${bound.sensor.name}: presence did not learn the empty room, ${why}; motion works as before. Calibrate again when the room is empty.`);
      }
    }
    const sensor = this.presences.get(id);
    if (!sensor) return;
    if (!state || state.blind || !presence?.trained || presence.training) {
      sensor.setSourceState('unavailable');
      return;
    }
    sensor.setSourceState('connected');
    if (sensor.detected !== presence.present) sensor.setDetected(presence.present);
  }

  private async configure(bound: Bound, patch: SensorConfigPatch): Promise<void> {
    try {
      const info = await bound.client.configure(patch);
      bound.info = info;
      bound.sensor.show(info, bound.state, this.release);
      if (info.restarting) this.logger.log(`${bound.sensor.name} restarts with the new settings and calibrates for 30 s`);
      if (patch.camera === true) setTimeout(() => void this.offerCameras(), 15_000);
    } catch (error) {
      this.logger.error(`${bound.sensor.name}: the settings were not applied: ${errorText(error)}`);
      // the form shows the board's values again, not the refused one
      bound.sensor.show(bound.info, bound.state, this.release, true);
      throw error;
    }
  }

  private async reset(bound: Bound): Promise<void> {
    await bound.client.reset();
    const tokens = { ...(this.storage.values.tokens ?? {}) };
    delete tokens[bound.id];
    await this.storage.setInternalValue('tokens', tokens);
    bound.client.token = undefined;
    this.logger.log(`${bound.sensor.name} was reset: it shows its own Wi-Fi network for a new setup. Remove the sensor here.`);
  }

  // ---- firmware -------------------------------------------------------------------------------------------------------

  private async checkFirmware(): Promise<void> {
    // an emptied field means the default list, not none
    const url = this.storage.values.manifestUrl?.trim() ? this.storage.values.manifestUrl : DEFAULT_MANIFEST_URL;
    try {
      this.release = await readManifest(url);
      for (const bound of this.bound.values()) bound.sensor.show(bound.info, bound.state, this.release);
    } catch (error) {
      this.logger.debug(`Firmware list not read: ${errorText(error)}`);
    }
  }

  private async updateFirmware(bound: Bound): Promise<void> {
    await this.checkFirmware();
    const release = this.release;
    if (!release) throw new Error('The list of firmware versions could not be read');
    if (bound.info && !newer(release.version, bound.info.firmware)) {
      this.logger.log(`${bound.sensor.name} already has firmware ${bound.info.firmware}`);
      return;
    }
    await bound.client.update(release.url, release.sha256);
    this.logger.log(`${bound.sensor.name}: installing firmware ${release.version}`);
  }

  // ---- cameras of the boards ------------------------------------------------------------------------------------------

  /** Cached telemetry only. Calling this method never starts a board request. */
  public async vionSensorLive(): Promise<VionSensorLive[]> {
    return [...this.bound.values()].map((bound) => {
      const cached = bound.state;
      const state: VionSensorLive['state'] =
        !cached || bound.failures >= FAILURES_BEFORE_OFFLINE
          ? 'offline'
          : cached.calibrating
            ? 'calibrating'
            : cached.blind
              ? 'blind'
              : bound.motion || bound.pulse
                ? 'motion'
                : 'quiet';
      const finite = (value: number | undefined, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
      return {
        sensorId: bound.sensorId,
        cameraId: this.cameras.get(bound.id)?.id ?? null,
        state,
        calibrationLeftS: state === 'calibrating' ? Math.max(0, Math.ceil(finite(cached?.calibration_left_s))) : 0,
        level: cached && cached.baseline > 0 ? finite(cached.score / cached.baseline, 1) : 1,
        threshold: finite(cached?.threshold ?? bound.info?.config.threshold, 1.4),
        rssi: finite(cached?.rssi ?? bound.info?.rssi),
        presence: presenceLive(cached),
        radar: cached?.ld2450?.connected ? { targets: cached.ld2450.targets.map((t) => ({ x: t.x, y: t.y, speed: t.speed })) } : null,
        packetsPerS: Math.max(0, finite(cached?.packets_per_s)),
      };
    });
  }

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.initializeCamera(camera);
  }

  async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.initializeCamera(camera);
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    for (const [id, camera] of this.cameras) if (camera.id === cameraId) this.cameras.delete(id);
  }

  async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    return this.notAddedCameras();
  }

  async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  async onAdoptCamera(discovered: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const id = discovered.id.slice(CAMERA_PREFIX.length);
    const bound = this.bound.get(id);
    if (!bound) throw new Error('Add the sensor first, then its camera');
    return {
      name: discovered.name,
      nativeId: id,
      isCloud: false,
      info: { manufacturer: 'ViON', model: bound.info?.model ?? 'ESP32-CAM', serialNumber: id, firmwareVersion: bound.info?.firmware },
      // the address is asked from the plugin for every connection: the router may give the board another one
      sources: [{ name: 'MJPEG', role: 'high-resolution', useForSnapshot: false, hotMode: false, preload: false }],
    };
  }

  private notAddedCameras(): DiscoveredCamera[] {
    const result: DiscoveredCamera[] = [];
    for (const bound of this.bound.values()) {
      if (bound.info?.camera.state !== 'on' || this.cameras.has(bound.id)) continue;
      result.push({ id: `${CAMERA_PREFIX}${bound.id}`, name: `${bound.sensor.name}`, manufacturer: 'ViON', model: bound.info.model, address: bound.client.address });
    }
    return result;
  }

  private async offerCameras(): Promise<void> {
    const fresh = this.notAddedCameras();
    if (fresh.length) await this.api.deviceManager.pushDiscoveredCameras(fresh);
  }

  private async initializeCamera(device: CameraDevice): Promise<void> {
    const id = device.nativeId;
    if (!id || this.cameras.has(id)) return;
    this.cameras.set(id, device);
    const sensorOf = (cameraId: string) => this.bound.get(cameraId);
    const implementation: StreamingInterface & SnapshotInterface = {
      async streamUrl(): Promise<string> {
        const bound = sensorOf(id);
        if (!bound?.client.token) throw new Error(`The sensor of camera ${device.name} is not added in this ViON`);
        // the board sends MJPEG; ffmpeg makes H.264 of it for the player and the recording
        return `ffmpeg:${bound.client.streamUrl()}#video=h264`;
      },
      async snapshot(): Promise<ArrayBuffer | undefined> {
        const bound = sensorOf(id);
        if (!bound?.client.token) return undefined;
        return bound.client.snapshot();
      },
    };
    try {
      await device.implement(implementation);
      device.connect();
    } catch (error) {
      this.cameras.delete(id);
      this.logger.error(`Could not set up camera ${device.name}: ${errorText(error)}`);
    }
  }
}
