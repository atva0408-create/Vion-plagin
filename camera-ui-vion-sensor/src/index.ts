import { API_EVENT, BasePlugin, SensorType } from '@camera.ui/sdk';

import { SensorClient, SensorRequestError } from './device.js';
import { SensorFinder } from './discovery.js';
import { DEFAULT_MANIFEST_URL, newer, readManifest } from './firmware.js';
import { VionMotionSensor } from './sensor.js';

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
import type { SensorConfigPatch, SensorInfo, SensorState } from './device.js';
import type { FoundSensor } from './discovery.js';
import type { FirmwareRelease } from './firmware.js';

export interface VionSensorConfig {
  /** Addresses typed by hand, for networks where the mDNS search does not reach. */
  addresses?: string;
  manifestUrl?: string;
  /** The token each board gave this ViON when it was added, by board id. Kept after a removal: adding it again works. */
  tokens?: Record<string, string>;
}

const SENSOR_PREFIX = 'vs:';
const CAMERA_PREFIX = 'vs-cam:';
const POLL_MS = 1000;
/** Polls that may fail before the sensor is shown as unavailable: one lost answer on Wi-Fi is not an outage. */
const FAILURES_BEFORE_OFFLINE = 3;
const PULSE_MS = 2000;
const ADDRESS_PROBE_MS = 60_000;
const MANIFEST_MS = 6 * 60 * 60_000;

interface Bound {
  id: string;
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
}

function boardId(nativeId: string): string {
  return nativeId.startsWith(SENSOR_PREFIX) ? nativeId.slice(SENSOR_PREFIX.length) : nativeId;
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
    const result: DiscoveredSensor[] = [];
    for (const found of this.finder.found.values()) {
      let info: SensorInfo | undefined;
      try {
        info = await new SensorClient(found.address).info();
      } catch {
        continue;
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
    }
    return result;
  }

  async configureAdoptedSensors(records: AdoptedSensor[]): Promise<Sensor<any, any, any>[]> {
    return records.map((record) => this.bind(record).sensor);
  }

  async onSensorAdopted(record: AdoptedSensor): Promise<Sensor<any, any, any>> {
    const id = boardId(record.nativeId);
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
    const bound: Bound = { id, client, failures: 0, motion: false } as Bound;
    bound.sensor = new VionMotionSensor(record.name, record.nativeId, {
      configure: (patch) => this.configure(bound, patch),
      recalibrate: async () => {
        await bound.client.recalibrate();
        this.logger.log(`${record.name}: calibrating for 30 s, keep the room empty`);
      },
      update: () => this.updateFirmware(bound),
      reset: () => this.reset(bound),
    });
    if (address) bound.sensor.setAddress(address.split(':')[0]);
    this.bound.set(id, bound);
    if (this.started) this.startPolling(bound);
    return bound;
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
      if (!bound.info || (bound.state && bound.state.uptime_s < 5)) bound.info = await bound.client.info();
      const state = await bound.client.state();
      if (bound.failures >= FAILURES_BEFORE_OFFLINE) this.logger.log(`${sensor.name} is back`);
      bound.failures = 0;
      const restarted = bound.state !== undefined && state.uptime_s < bound.state.uptime_s;
      if (restarted) bound.events = undefined;
      bound.state = state;
      sensor.setSourceState(state.blind ? 'unavailable' : 'connected');
      this.applyMotion(bound, state);
      sensor.show(bound.info, state, this.release);
    } catch (error) {
      bound.failures++;
      if (bound.failures === FAILURES_BEFORE_OFFLINE) {
        this.logger.warn(`${sensor.name} does not answer: ${errorText(error)}`);
        sensor.setSourceState('unavailable');
        this.applyMotion(bound, undefined);
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
    const motion = !!state && !state.calibrating && !state.blind && state.motion;
    const missed = !!state && bound.events !== undefined && state.events > bound.events && !motion;
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
