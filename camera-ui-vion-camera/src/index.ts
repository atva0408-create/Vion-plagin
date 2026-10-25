import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { CameraClient, CameraRequestError } from './device.js';
import { CameraFinder } from './discovery.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
  StreamingInterface,
} from '@camera.ui/sdk';
import type { RtspAccess } from './device.js';
import type { FoundCamera } from './discovery.js';

export interface VionCameraConfig {
  /** Addresses typed by hand, for networks where the mDNS search does not reach. */
  addresses?: string;
  /** What each camera gave this VION when it was added, by camera id. Kept after a removal: adding it again works. */
  access?: Record<string, { token: string; rtsp: RtspAccess }>;
  /** Where each camera was seen last, by id: after a restart VION reaches it before mDNS answers. */
  places?: Record<string, string>;
}

const ADDRESS_PROBE_MS = 60_000;
const HEALTH_MS = 30_000;
const OWNED_ELSEWHERE = 'The camera is added to another VION: remove it there, or reset it with its button';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class VionCameraPlugin extends BasePlugin<VionCameraConfig> implements DiscoveryProvider {
  private finder = new CameraFinder(
    (found) => this.onFound(found),
    (message) => this.logger.warn(message),
  );

  /** The cameras of this plugin in VION, by camera id (their nativeId). */
  private cameras = new Map<string, CameraDevice>();
  /** Cameras that did not answer the last check: told once, and once when they are back. */
  private silent = new Set<string>();
  private probeTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<VionCameraConfig>) {
    super(logger, api, storage);
    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'addresses',
        title: 'Camera addresses',
        description:
          'Cameras are found in the network by themselves. If yours does not appear in Cameras, Found, ' +
          'type its address here (several separated by commas), e.g. 192.168.1.60.',
        placeholder: '192.168.1.60',
        store: true,
        onSet: async () => this.probeAddresses(),
      },
    ];
  }

  private start(): void {
    this.finder.start();
    void this.probeAddresses();
    this.probeTimer = setInterval(() => void this.probeAddresses(), ADDRESS_PROBE_MS);
    this.healthTimer = setInterval(() => void this.checkCameras(), HEALTH_MS);
  }

  private stop(): void {
    this.finder.stop();
    clearInterval(this.probeTimer);
    clearInterval(this.healthTimer);
  }

  // ---- finding cameras -----------------------------------------------------------------------------------------------

  private addresses(): string[] {
    return (this.storage.values.addresses ?? '')
      .split(/[,\s;]+/)
      .map((a) => a.trim())
      .filter(Boolean);
  }

  private async probeAddresses(): Promise<void> {
    await Promise.all(
      this.addresses().map(async (typed) => {
        const client = new CameraClient(typed);
        try {
          const info = await client.info();
          if (info.kind === 'camera') this.finder.remember({ id: info.id.toUpperCase(), address: typed, name: info.name, firmware: info.firmware, model: info.model });
        } catch {
          // not there now: the next probe tries again
        }
      }),
    );
  }

  /** A camera was seen, maybe at a new address: one in VION follows it there, a new one is offered in «Найденные». */
  private onFound(found: FoundCamera): void {
    // the place kept, not this.place(): the finder holds the new address already
    const before = this.storage.values.places?.[found.id];
    if (before !== found.address) {
      void this.storage.setInternalValue('places', { ...(this.storage.values.places ?? {}), [found.id]: found.address });
      if (before && this.cameras.has(found.id)) this.logger.log(`${found.name} is now at ${found.address}`);
    }
    void this.offerCameras();
  }

  private place(id: string): string | undefined {
    return this.finder.found.get(id)?.address ?? this.storage.values.places?.[id];
  }

  private access(id: string): { token: string; rtsp: RtspAccess } | undefined {
    return this.storage.values.access?.[id];
  }

  private notAdded(): DiscoveredCamera[] {
    const result: DiscoveredCamera[] = [];
    for (const found of this.finder.found.values()) {
      if (this.cameras.has(found.id)) continue;
      result.push({ id: found.id, name: found.name, manufacturer: 'VION', model: found.model, address: new CameraClient(found.address).host });
    }
    return result;
  }

  private async offerCameras(): Promise<void> {
    const fresh = this.notAdded();
    if (fresh.length) await this.api.deviceManager.pushDiscoveredCameras(fresh);
  }

  // ---- adding a camera -----------------------------------------------------------------------------------------------

  async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    return this.notAdded();
  }

  async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  async onAdoptCamera(discovered: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const id = discovered.id.toUpperCase();
    const address = this.place(id);
    if (!address) throw new Error('The camera is not in the network now: check that it is on and in the same network');
    await this.accessFor(id, address);
    const info = await new CameraClient(address).info();
    return {
      name: discovered.name,
      nativeId: id,
      isCloud: false,
      info: { manufacturer: 'VION', model: info.model, serialNumber: id, firmwareVersion: info.firmware },
      // the address is asked from the plugin for every connection: the router may give the camera another one
      sources: [
        { name: 'main', role: 'high-resolution', useForSnapshot: false, hotMode: false, preload: false },
        { name: 'sub', role: 'low-resolution', useForSnapshot: true, hotMode: false, preload: false },
      ],
    };
  }

  /**
   * The token and the RTSP access of a camera: the ones kept when this VION had it before and it still takes them,
   * else a new pairing. A camera reset with its button takes no old token and pairs anew; one another VION has
   * answers 409.
   */
  private async accessFor(id: string, address: string): Promise<{ token: string; rtsp: RtspAccess }> {
    const kept = this.access(id);
    if (kept) {
      try {
        await new CameraClient(address, kept.token).state();
        return kept;
      } catch (error) {
        if (!(error instanceof CameraRequestError) || error.status !== 401) throw error;
      }
    }
    let paired: Awaited<ReturnType<CameraClient['pair']>>;
    try {
      paired = await new CameraClient(address).pair();
    } catch (error) {
      if (error instanceof CameraRequestError && error.status === 409) throw new Error(OWNED_ELSEWHERE);
      throw error;
    }
    const access = { token: paired.token, rtsp: paired.rtsp };
    await this.storage.setInternalValue('access', { ...(this.storage.values.access ?? {}), [id]: access });
    this.logger.log(`${paired.info.name} is added to this VION`);
    return access;
  }

  // ---- cameras in VION -----------------------------------------------------------------------------------------------

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.initializeCamera(camera);
  }

  async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.initializeCamera(camera);
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    for (const [id, camera] of this.cameras) if (camera.id === cameraId) this.cameras.delete(id);
  }

  private async initializeCamera(device: CameraDevice): Promise<void> {
    const id = device.nativeId?.toUpperCase();
    if (!id || this.cameras.has(id)) return;
    this.cameras.set(id, device);
    const implementation: StreamingInterface = {
      streamUrl: async (sourceId: string): Promise<string> => {
        const access = this.access(id);
        const address = this.place(id);
        if (!access) throw new Error(`Camera ${device.name} is not added to this VION: add it again from Cameras, Found`);
        if (!address) throw new Error(`Camera ${device.name} is not in the network now`);
        const source = device.sources.find((s) => s._id === sourceId);
        // the camera has two streams: the main one, and a small one for the views of many cameras and the phone
        const path = source?.role === 'low-resolution' || source?.role === 'mid-resolution' ? '/sub' : '/main';
        return new CameraClient(address).streamUrl(access.rtsp, path);
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

  /** Each camera in VION, asked how it is: one that stops answering, or whose picture stops, is told once. */
  private async checkCameras(): Promise<void> {
    await Promise.all(
      [...this.cameras].map(async ([id, device]) => {
        const access = this.access(id);
        const address = this.place(id);
        if (!access || !address) return;
        try {
          const { health } = await new CameraClient(address, access.token).state();
          const down = Object.entries(health.streams)
            .filter(([, s]) => !s.up)
            .map(([name]) => name);
          if (down.length) throw new Error(`no picture in ${down.join(', ')}`);
          if (this.silent.delete(id)) this.logger.log(`${device.name} answers again`);
        } catch (error) {
          if (!this.silent.has(id)) this.logger.warn(`${device.name}: ${errorText(error)}`);
          this.silent.add(id);
        }
      }),
    );
  }
}
