import { API_EVENT, BasePlugin, SensorType } from '@camera.ui/sdk';

import { SensorClient, SensorRequestError } from './device.js';
import { SensorFinder } from './discovery.js';
import { DEVICE_ID, ESPECTRE_PORT, EspectreClient, EspectreRequestError, EspectreStream } from './espectre.js';
import { EspectreMotionSensor } from './espectre-sensor.js';
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
import type { EspectreDevice, EspectreMotion, EspectreOta, EspectreSensing, EspectreSensingPatch, EspectreWifi, FoundEspectre } from './espectre.js';
import type { EspectreView } from './espectre-sensor.js';
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
  /** Motion triggers at level / threshold = 1. An ESPectre board gives its probability over its threshold, against 1. */
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
/** A board with the ESPectre firmware, by its device_id. */
const ESPECTRE_PREFIX = 'es:';
/** A closed event stream that does not open again within this long makes the sensor unavailable: one lost connection on Wi-Fi is not an outage. */
const ESPECTRE_OFFLINE_MS = 5_000;
/** The board sends motion several times a second: a motion with no reading this long is over, whatever the last one said. */
const ESPECTRE_MOTION_STALE_MS = 5_000;
/** Settings, signal and packet rate are read again this often; motion comes by the event stream. */
const ESPECTRE_REFRESH_MS = 10_000;
/**
 * A ready board sends motion several times a second: this long without it, it went away without closing the stream
 * (power, Wi-Fi), which the connection itself notices only much later.
 */
const ESPECTRE_SILENT_MS = 8_000;
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

interface EspectreBound {
  id: string;
  sensorId: string;
  sensor: EspectreMotionSensor;
  client: EspectreClient;
  stream: EspectreStream;
  connected: boolean;
  /**
   * The board on this connection said it is this one. The ESPectre API has no key: after a power cut the router may give
   * the address to another board, and only its device_id tells them apart.
   */
  verified: boolean;
  /** What a new connection has to read again: the board publishes these only when they change. */
  stale: { wifi: boolean; ota: boolean };
  /** The stream stayed closed past ESPECTRE_OFFLINE_MS, or another board answers at the address; it was said. */
  unavailable: boolean;
  /** Said once per address and board: another board answers there. */
  wrongTold?: string;
  /** The last event of any kind, for the silence check. */
  eventAt: number;
  /** Counts the connections: a reading begun on an earlier one does not speak for the current one. */
  session: number;
  offlineTimer?: NodeJS.Timeout;
  ticker?: NodeJS.Timeout;
  ticks: number;
  device?: EspectreDevice;
  sensing?: EspectreSensing;
  wifi?: EspectreWifi;
  ota?: EspectreOta;
  last?: EspectreMotion;
  lastAt: number;
  motion: boolean;
  packetsPerS?: number;
  faultTold?: string;
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

/** The board measures and its motion events may be read: then it sends them several times a second. */
function espectreSensing(sensing: EspectreSensing | undefined): boolean {
  return !!sensing && sensing.enabled && sensing.mode === 'sensing' && sensing.ready && !sensing.calibrating && !sensing.derived_events_paused;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class VionSensorPlugin extends BasePlugin<VionSensorConfig> implements SensorDiscoveryProvider, DiscoveryProvider {
  private finder = new SensorFinder(
    (found) => this.onFound(found),
    (message) => this.logger.warn(message),
    (found) => this.onFoundEspectre(found),
  );

  private bound = new Map<string, Bound>();
  private espectre = new Map<string, EspectreBound>();
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
    for (const bound of this.espectre.values()) this.startEspectre(bound);
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
    for (const bound of this.espectre.values()) this.stopEspectre(bound);
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
      this.addresses().flatMap((address) => [
        (async () => {
          try {
            const info = await new SensorClient(address).info();
            if (info.kind === 'vion-sensor') this.finder.remember({ id: info.id.toUpperCase(), address, name: info.name, firmware: info.firmware });
          } catch {
            // not there now: the next probe tries again
          }
        })(),
        (async () => {
          // an ESPectre board listens on its own port; a typed port is taken as it is
          const target = /:\d+$/.test(address) ? address : `${address}:${ESPECTRE_PORT}`;
          try {
            const device = await new EspectreClient(target).device();
            if (DEVICE_ID.test(device.device_id)) {
              this.finder.rememberEspectre({
                id: device.device_id,
                address: target,
                name: device.name,
                firmware: device.firmware,
                chip: device.chip,
                frontend: device.frontend,
              });
            }
          } catch {
            // no ESPectre there (a ViON board, or nothing now): the next probe tries again
          }
        })(),
      ]),
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

  /**
   * An ESPectre board was seen, maybe at a new address: a bound sensor follows it there at once, and one that waited (no
   * address yet, or another board at its old one) opens its stream.
   */
  private onFoundEspectre(found: FoundEspectre): void {
    const bound = this.espectre.get(found.id);
    if (!bound) return;
    const moved = bound.client.address !== found.address;
    if (moved) {
      this.logger.log(`${found.name} is now at ${found.address}`);
      bound.client.address = found.address;
      bound.sensor.setAddress(found.address.split(':')[0]);
    }
    if (this.started && (moved || !bound.stream.active)) bound.stream.restart('the board is at another address');
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
    // ESPectre boards have no owner to ask. An added one is offered from what its stream knows; another is asked who it is
    // first: an announced or typed address may belong to another board by now, or to no ESPectre at all
    const espectre = new Map<string, Omit<FoundEspectre, 'seenAt'>>();
    for (const found of this.finder.espectre.values()) {
      // Micro-ESPectre only reads (no settings) and takes one event stream, which ViON would hold: not offered
      if (this.espectre.has(found.id) || found.frontend === 'micro') continue;
      try {
        const device = await new EspectreClient(found.address).device();
        if (device.device_id !== found.id || device.frontend === 'micro') continue;
        espectre.set(found.id, { ...found, name: device.name || found.name, chip: device.chip });
      } catch {
        continue;
      }
    }
    for (const bound of this.espectre.values()) {
      if (bound.client.address)
        espectre.set(bound.id, { id: bound.id, address: bound.client.address, name: bound.device?.name ?? bound.sensor.name, chip: bound.device?.chip });
    }
    for (const found of espectre.values()) {
      result.push({
        id: `${ESPECTRE_PREFIX}${found.id}`,
        address: found.address,
        name: found.name,
        type: SensorType.Motion,
        manufacturer: 'ESPectre',
        model: found.chip ?? 'ESP32',
      });
    }
    return result;
  }

  async configureAdoptedSensors(records: AdoptedSensor[]): Promise<Sensor<any, any, any>[]> {
    const isPresence = (record: AdoptedSensor) => record.nativeId.startsWith(PRESENCE_PREFIX);
    const isEspectre = (record: AdoptedSensor) => record.nativeId.startsWith(ESPECTRE_PREFIX);
    // motion first: a presence sensor finds its board through it
    const motion = records.filter((record) => !isPresence(record) && !isEspectre(record)).map((record) => this.bind(record).sensor);
    const presence = records.filter(isPresence).map((record) => this.bindPresence(record));
    const espectre = records.filter(isEspectre).map((record) => this.bindEspectre(record).sensor);
    return [...motion, ...presence, ...espectre];
  }

  async onSensorAdopted(record: AdoptedSensor): Promise<Sensor<any, any, any>> {
    if (record.nativeId.startsWith(ESPECTRE_PREFIX)) {
      // before anything runs: a refused sensor must leave no stream behind
      if (!this.espectreAddress(record)) throw new Error(`The sensor ${record.name} is not in the network now`);
      const bound = this.bindEspectre(record);
      this.logger.log(`Added sensor ${record.name}`);
      return bound.sensor;
    }
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
    if (nativeId.startsWith(ESPECTRE_PREFIX)) {
      const bound = this.espectre.get(nativeId.slice(ESPECTRE_PREFIX.length));
      if (!bound) return;
      this.stopEspectre(bound);
      this.espectre.delete(bound.id);
      return;
    }
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

  // ---- ESPectre boards --------------------------------------------------------------------------------------------------

  private espectreAddress(record: AdoptedSensor): string {
    const id = record.nativeId.slice(ESPECTRE_PREFIX.length);
    // an empty address is none: the next place is asked
    for (const address of [this.espectre.get(id)?.client.address, this.finder.espectre.get(id)?.address, record.address]) if (address) return address;
    return '';
  }

  private bindEspectre(record: AdoptedSensor): EspectreBound {
    const id = record.nativeId.slice(ESPECTRE_PREFIX.length);
    const existing = this.espectre.get(id);
    if (existing) return existing;
    const client = new EspectreClient(this.espectreAddress(record));
    const bound = {
      id,
      sensorId: record.id,
      client,
      connected: false,
      verified: false,
      stale: { wifi: true, ota: true },
      unavailable: false,
      eventAt: 0,
      session: 0,
      ticks: 0,
      lastAt: 0,
      motion: false,
    } as EspectreBound;
    bound.sensor = new EspectreMotionSensor(record.name, record.nativeId, {
      configure: (patch) => this.configureEspectre(bound, patch),
      calibrate: async () => {
        await this.espectreAction(bound, () => bound.client.calibrate(), 'Calibration is already running');
        this.logger.log(`${record.name}: calibrating, keep the room empty`);
      },
      checkUpdate: async () => {
        await this.espectreAction(bound, () => bound.client.checkUpdate(), 'The firmware is already being checked or installed');
      },
      update: async () => {
        await this.espectreAction(bound, () => bound.client.update(), 'The firmware is already being checked or installed');
        this.logger.log(`${record.name}: installing ESPectre ${bound.ota?.target_version ?? ''}, the board restarts after it`);
      },
    });
    bound.stream = new EspectreStream(client, {
      open: () => void this.onEspectreOpen(bound),
      event: (name, data) => this.onEspectreEvent(bound, name, data),
      close: (reason) => this.onEspectreClose(bound, reason),
    });
    if (client.address) bound.sensor.setAddress(client.address.split(':')[0]);
    this.espectre.set(id, bound);
    if (this.started) this.startEspectre(bound);
    return bound;
  }

  private startEspectre(bound: EspectreBound): void {
    // without an address there is nowhere to go: the stream opens when the board is found
    if (bound.client.address) bound.stream.start();
    clearInterval(bound.ticker);
    // every second: a motion whose readings stopped ends, a silent board is dropped; every ESPECTRE_REFRESH_MS: a reading
    bound.ticker = setInterval(() => {
      if (++bound.ticks % (ESPECTRE_REFRESH_MS / 1000) === 0) void this.refreshEspectre(bound);
      if (bound.connected && bound.verified && espectreSensing(bound.sensing) && Date.now() - bound.eventAt > ESPECTRE_SILENT_MS) {
        bound.eventAt = Date.now();
        bound.stream.restart('the board went silent');
      }
      this.applyEspectre(bound);
    }, 1000);
  }

  private stopEspectre(bound: EspectreBound): void {
    bound.stream.stop();
    clearInterval(bound.ticker);
    clearTimeout(bound.offlineTimer);
  }

  private espectreView(bound: EspectreBound): EspectreView {
    const { device, sensing, wifi, ota, packetsPerS } = bound;
    return { device, sensing, wifi, ota, packetsPerS, connected: bound.connected && bound.verified, score: bound.last?.score, address: bound.client.address };
  }

  /** The stream is open: who the board is comes first, then everything is read again — it keeps no missed events. */
  private async onEspectreOpen(bound: EspectreBound): Promise<void> {
    bound.connected = true;
    bound.verified = false;
    bound.session++;
    bound.stale = { wifi: true, ota: true };
    bound.eventAt = Date.now();
    clearTimeout(bound.offlineTimer);
    bound.offlineTimer = undefined;
    await this.refreshEspectre(bound);
  }

  private onEspectreClose(bound: EspectreBound, reason: string): void {
    bound.connected = false;
    bound.verified = false;
    if (bound.unavailable || bound.offlineTimer) return;
    bound.offlineTimer = setTimeout(() => {
      bound.offlineTimer = undefined;
      if (bound.connected) return;
      bound.unavailable = true;
      this.logger.warn(`${bound.sensor.name} does not answer: ${reason}`);
      this.applyEspectre(bound);
      bound.sensor.show(this.espectreView(bound));
    }, ESPECTRE_OFFLINE_MS);
  }

  /** Another board answers at the address: nothing of it is this sensor's, and the sensor waits to be found again. */
  private onWrongEspectre(bound: EspectreBound, device: EspectreDevice): void {
    bound.stream.stop();
    bound.connected = false;
    bound.verified = false;
    clearTimeout(bound.offlineTimer);
    bound.offlineTimer = undefined;
    bound.unavailable = true;
    // the finder must announce the board again, wherever it is, for the sensor to follow it
    if (this.finder.espectre.get(bound.id)?.address === bound.client.address) this.finder.espectre.delete(bound.id);
    const told = `${bound.client.address} ${device.device_id}`;
    if (bound.wrongTold !== told) {
      bound.wrongTold = told;
      const stranger = `${bound.client.address} now answers as another ESPectre board, ${device.name} (${device.device_id})`;
      this.logger.warn(`${bound.sensor.name}: ${stranger}; the sensor waits until ${bound.sensor.name} is found again`);
    }
    this.applyEspectre(bound);
    bound.sensor.show(this.espectreView(bound));
  }

  private onEspectreEvent(bound: EspectreBound, name: string, data: unknown): void {
    bound.eventAt = Date.now();
    // before the board said who it is, its events may be another board's
    if (!bound.verified) return;
    const value = data as any;
    switch (name) {
      case 'motion':
        if ((value?.state === 'motion' || value?.state === 'idle') && typeof value.score === 'number') {
          bound.last = value as EspectreMotion;
          bound.lastAt = Date.now();
          this.applyEspectre(bound);
        }
        return;
      case 'sensing':
        if (typeof value?.threshold !== 'number' || typeof value.ready !== 'boolean' || typeof value.enabled !== 'boolean') return;
        this.setEspectreSensing(bound, value as EspectreSensing);
        this.applyEspectre(bound);
        break;
      case 'device':
        if (value?.device_id !== bound.id) return;
        bound.device = value as EspectreDevice;
        break;
      case 'wifi':
        if (typeof value !== 'object' || value === null) return;
        bound.wifi = value as EspectreWifi;
        break;
      case 'ota':
        if (typeof value?.state !== 'string') return;
        this.onEspectreOta(bound, value as EspectreOta);
        break;
      case 'fault':
        // a board in trouble repeats itself: each different fault is told once
        if (value?.message && value.message !== bound.faultTold) {
          bound.faultTold = value.message;
          this.logger.warn(`${bound.sensor.name}: ${value.message}`);
        }
        return;
      default:
        return;
    }
    bound.sensor.show(this.espectreView(bound));
  }

  private onEspectreOta(bound: EspectreBound, ota: EspectreOta): void {
    const before = bound.ota?.state;
    bound.ota = ota;
    if (ota.state === before) return;
    const name = bound.sensor.name;
    if (ota.state === 'up_to_date') this.logger.log(`${name} has the newest ESPectre, ${ota.current_version}`);
    else if (ota.state === 'update_available') this.logger.log(`${name}: ESPectre ${ota.target_version} is out`);
    else if (ota.state === 'reboot_scheduled') this.logger.log(`${name}: ESPectre ${ota.target_version} installed, the board restarts`);
    else if (ota.state === 'error') this.logger.warn(`${name}: firmware update failed: ${ota.message}`);
  }

  /**
   * One reading of an open connection, each part on its own: who the board is (until it said), the settings, what a new
   * connection has not read yet, the signal and packet rate. A part lost on Wi-Fi is read at the next refresh.
   */
  private async refreshEspectre(bound: EspectreBound): Promise<void> {
    if (!bound.connected) return;
    const name = bound.sensor.name;
    const session = bound.session;
    const current = () => bound.connected && bound.session === session;
    const quietly = async (what: string, read: () => Promise<void>) => {
      try {
        await read();
      } catch (error) {
        // availability is the stream's to decide: one lost answer is read again in ESPECTRE_REFRESH_MS
        this.logger.debug(`${name}: ${what} not read: ${errorText(error)}`);
      }
    };
    // one request after another: the board answers four at a time, from all its clients together
    if (!bound.verified) {
      let device: EspectreDevice | undefined;
      await quietly('device', async () => {
        device = await bound.client.device();
      });
      if (!device || !current()) return;
      if (device.device_id !== bound.id) return this.onWrongEspectre(bound, device);
      bound.device = device;
      bound.verified = true;
      bound.wrongTold = undefined;
      if (bound.unavailable) this.logger.log(`${name} is back`);
      bound.unavailable = false;
    }
    await quietly('settings', async () => {
      this.setEspectreSensing(bound, await bound.client.sensing());
    });
    if (bound.stale.wifi) {
      await quietly('Wi-Fi', async () => {
        bound.wifi = await bound.client.wifi();
        bound.stale.wifi = false;
      });
    }
    if (bound.stale.ota) {
      await quietly('firmware', async () => {
        bound.ota = await bound.client.ota();
        bound.stale.ota = false;
      });
    }
    await quietly('diagnostics', async () => {
      const { packetsPerS, rssi } = await bound.client.diagnostics();
      bound.packetsPerS = packetsPerS;
      if (rssi !== undefined) bound.wifi = { ...(bound.wifi ?? { connected: true }), rssi_dbm: rssi };
    });
    this.applyEspectre(bound);
    bound.sensor.show(this.espectreView(bound));
  }

  /**
   * The detector's output may be used only while the board is ready: a reading from before (calibrating, too few packets)
   * says nothing about the room now, and is dropped when the board stops or starts being ready.
   */
  private setEspectreSensing(bound: EspectreBound, sensing: EspectreSensing): void {
    if (!espectreSensing(sensing) || !espectreSensing(bound.sensing)) bound.last = undefined;
    bound.sensing = sensing;
  }

  /** What ViON is told: unknown while the board is gone, off, collecting or not ready; no motion while it calibrates. */
  private applyEspectre(bound: EspectreBound): void {
    // nothing is known of a board that has not said who it is
    const sensing = bound.verified ? bound.sensing : undefined;
    const running = !!sensing && sensing.enabled && sensing.mode === 'sensing' && (sensing.ready || sensing.calibrating);
    if (bound.unavailable || (sensing && !running)) bound.sensor.setSourceState('unavailable');
    else if (sensing) bound.sensor.setSourceState('connected');
    const fresh = !!bound.last && Date.now() - bound.lastAt < ESPECTRE_MOTION_STALE_MS;
    const motion = !bound.unavailable && running && !sensing.calibrating && fresh && bound.last!.state === 'motion';
    if (motion !== bound.motion) {
      bound.motion = motion;
      bound.sensor.reportDetections(motion);
    }
  }

  private espectreLiveState(bound: EspectreBound): VionSensorLive['state'] {
    const sensing = bound.sensing;
    if (bound.unavailable || !sensing) return 'offline';
    if (sensing.calibrating) return 'calibrating';
    if (!sensing.enabled || sensing.mode !== 'sensing' || !sensing.ready) return 'blind';
    return bound.motion ? 'motion' : 'quiet';
  }

  private async configureEspectre(bound: EspectreBound, patch: EspectreSensingPatch): Promise<void> {
    try {
      // a board not yet known to be this one is not told anything
      if (!bound.verified) throw new Error(`${bound.sensor.name} is not reachable now`);
      await bound.client.configure(patch);
      this.setEspectreSensing(bound, await bound.client.sensing());
      bound.sensor.show(this.espectreView(bound));
    } catch (error) {
      this.logger.error(`${bound.sensor.name}: the settings were not applied: ${errorText(error)}`);
      // the form shows the board's values again, not the refused one
      bound.sensor.show(this.espectreView(bound), true);
      throw error;
    }
  }

  /** A board busy with the same thing answers 409: said in words, not as a code. */
  private async espectreAction(bound: EspectreBound, action: () => Promise<unknown>, busy: string): Promise<void> {
    try {
      if (!bound.verified) throw new Error(`${bound.sensor.name} is not reachable now`);
      await action();
    } catch (error) {
      const message = error instanceof EspectreRequestError && error.status === 409 ? busy : errorText(error);
      this.logger.error(`${bound.sensor.name}: ${message}`);
      throw new Error(message);
    }
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
    const vion = [...this.bound.values()].map((bound): VionSensorLive => {
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
    const espectre = [...this.espectre.values()].map((bound): VionSensorLive => {
      const sensing = bound.sensing;
      const score = bound.last?.score;
      return {
        sensorId: bound.sensorId,
        cameraId: null,
        state: this.espectreLiveState(bound),
        calibrationLeftS: 0,
        level: sensing && sensing.threshold > 0 && typeof score === 'number' && Number.isFinite(score) ? score / sensing.threshold : 0,
        threshold: 1,
        rssi: typeof bound.wifi?.rssi_dbm === 'number' ? bound.wifi.rssi_dbm : 0,
        packetsPerS: Math.max(0, bound.packetsPerS ?? 0),
        presence: null,
        radar: null,
      };
    });
    return [...vion, ...espectre];
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
