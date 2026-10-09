import { XiaomiPtz } from './ptz.js';
import { errorText } from './xiaomi/text.js';

import type { CameraDevice, DeviceStorage, JsonSchema, StreamingInterface } from '@camera.ui/sdk';
import type { Lens } from './optics.js';
import type { OpenSession } from './ptz.js';
import type { ConnectionMode } from './xiaomi/p2p.js';

export interface CameraValues {
  ptz?: boolean;
  connectionMode?: ConnectionMode;
}

/** The switch of a camera that turns its motor from ViON. The camera settings show it next to autotracking. */
export const PTZ_KEY = 'ptz';

/** The focus of a camera with a zoom lens, next to the switch: shown only for a camera that has one. */
export const FOCUS_KEYS = { near: 'focusNear', far: 'focusFar', auto: 'focusAuto' } as const;

/** What the lens of a camera does; asked when pan and tilt are switched on. */
export type LensOf = (nativeId: string) => Promise<Lens>;

/**
 * A camera of the plugin: its stream address is asked from the plugin for every connection. Pan and tilt are switched
 * on per camera: the Mi Home device list does not say which models have a motor. Zoom and focus come with them where
 * the MIoT description of the camera has a zoom lens.
 */
export class Camera implements StreamingInterface {
  private readonly storage: DeviceStorage<CameraValues>;
  private ptz?: XiaomiPtz;
  /** switching on reads the lens first: a second switch waits for the first instead of adding a second control */
  private ptzChange: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    public readonly device: CameraDevice,
    private readonly resolve: (nativeId: string, mode: ConnectionMode) => Promise<string>,
    private readonly openMotor: (nativeId: string, mode: ConnectionMode) => OpenSession,
    private readonly lensOf?: LensOf,
  ) {
    this.storage = device.createStorage<CameraValues>([
      {
        type: 'string',
        key: 'connectionMode',
        title: 'Connection',
        description:
          'Auto uses the local network when available, otherwise Xiaomi P2P. Remote P2P connects CS2 cameras in another network. Applies on the next connection.',
        store: true,
        defaultValue: 'auto',
        enum: ['auto', 'lan', 'remote'],
        enumLabels: { auto: 'Auto', lan: 'Local network', remote: 'Remote P2P' },
      },
      {
        type: 'boolean',
        key: PTZ_KEY,
        title: 'Pan, tilt and zoom (PTZ)',
        description:
          'Turns the camera from ViON: arrows in the player and autotracking. For cameras with a motor, such as the Mi 360°, C200 and C300. ' +
          'A camera with a zoom lens also zooms, and its focus is set here.',
        store: true,
        defaultValue: false,
        onSet: async (value: unknown) => {
          await this.applyPtz(value === true);
        },
      },
    ]);
  }

  public async initialize(): Promise<void> {
    await this.device.implement(this);
    this.device.connect();
    // the lens is read over the network: the camera does not wait for it, and neither does the list of cameras
    this.applyPtz(this.storage.values.ptz === true).catch((error) => this.device.logger.error('Could not set up pan and tilt:', errorText(error)));
  }

  public async streamUrl(_sourceId: string): Promise<string> {
    if (this.disposed) throw new Error('The Xiaomi camera has been released');
    if (!this.device.nativeId) throw new Error(`Camera ${this.device.name} has no Xiaomi device id`);
    const url = await this.resolve(this.device.nativeId, this.connectionMode());
    if (this.disposed) throw new Error('The Xiaomi camera has been released');
    return url;
  }

  /** The camera left the plugin: its motor session is closed. */
  public dispose(): void {
    this.disposed = true;
    this.ptz?.dispose();
  }

  private applyPtz(on: boolean): Promise<void> {
    const change = this.ptzChange.then(() => this.switchPtz(on));
    this.ptzChange = change.catch(() => undefined);
    return change;
  }

  private async switchPtz(on: boolean): Promise<void> {
    const nativeId = this.device.nativeId;
    if (on && !this.ptz && nativeId) {
      const lens = await this.readLens(nativeId);
      // the camera left the plugin while its lens was read
      if (this.disposed) return;
      const ptz = new XiaomiPtz((answer) => this.openMotor(nativeId, this.connectionMode())(answer), this.device.logger, {}, lens.zoom);
      try {
        await this.device.addSensor(ptz);
        if (this.disposed) {
          ptz.dispose();
          await this.device.removeSensor(ptz.id);
          return;
        }
        this.ptz = ptz;
      } catch (error) {
        this.device.logger.error('Could not add pan and tilt:', errorText(error));
        throw error;
      }
      await this.applyFocus(lens).catch((error) => this.device.logger.warn('Could not show the focus of the camera:', errorText(error)));
    } else if (!on && this.ptz) {
      const ptz = this.ptz;
      this.ptz = undefined;
      ptz.dispose();
      await this.device.removeSensor(ptz.id);
      await this.applyFocus({}).catch((error) => this.device.logger.warn('Could not hide the focus of the camera:', errorText(error)));
    }
  }

  private connectionMode(): ConnectionMode {
    const mode = this.storage.values.connectionMode;
    return mode === 'lan' || mode === 'remote' ? mode : 'auto';
  }

  /** The lens of the camera; a camera whose description cannot be read turns without zoom and focus. */
  private async readLens(nativeId: string): Promise<Lens> {
    if (!this.lensOf) return {};
    try {
      const lens = await this.lensOf(nativeId);
      const parts = [lens.zoom && 'zoom', (lens.focus ?? lens.autoFocus) && 'focus'].filter(Boolean);
      if (parts.length) this.device.logger.log(`The camera has a lens ViON can drive: ${parts.join(' and ')}`);
      return lens;
    } catch (error) {
      this.device.logger.warn('Could not read whether the camera can zoom (switch pan and tilt off and on to try again):', errorText(error));
      return {};
    }
  }

  /** The focus fields of the camera: there while the lens can be focused and pan and tilt are on. */
  private async applyFocus(lens: Lens): Promise<void> {
    const fields: JsonSchema[] = [];
    const focus = lens.focus;
    if (focus) {
      fields.push(
        {
          type: 'button',
          key: FOCUS_KEYS.near,
          title: 'Focus nearer',
          description: 'One step of the focus towards the camera.',
          onSet: async () => this.focus(() => focus.step(-1), 'focus nearer'),
        },
        {
          type: 'button',
          key: FOCUS_KEYS.far,
          title: 'Focus farther',
          description: 'One step of the focus away from the camera.',
          onSet: async () => this.focus(() => focus.step(1), 'focus farther'),
        },
      );
    }
    const auto = lens.autoFocus;
    if (auto?.kind === 'action') {
      fields.push({
        type: 'button',
        key: FOCUS_KEYS.auto,
        title: 'Focus automatically',
        description: 'The camera finds the sharpest focus itself.',
        onSet: async () => this.focus(auto.run, 'focus automatically'),
      });
    } else if (auto?.kind === 'switch') {
      fields.push({
        type: 'boolean',
        key: FOCUS_KEYS.auto,
        title: 'Autofocus',
        description: 'The camera keeps the picture sharp by itself.',
        defaultValue: true,
        onSet: async (value: unknown) => this.focus(() => auto.set(value === true), 'switch autofocus'),
      });
    }

    for (const key of Object.values(FOCUS_KEYS)) {
      if (this.storage.hasSchema(key) && !fields.some((field) => field.key === key)) await this.storage.removeSchema(key);
    }
    for (const field of fields) {
      if (this.storage.hasSchema(field.key)) await this.storage.changeSchema(field.key, field);
      else await this.storage.addSchema(field);
    }
  }

  private async focus(command: () => Promise<void>, what: string): Promise<void> {
    try {
      await command();
    } catch (error) {
      this.device.logger.error(`Could not ${what}:`, errorText(error));
      throw error;
    }
  }
}
