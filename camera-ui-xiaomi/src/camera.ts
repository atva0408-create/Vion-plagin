import { XiaomiPtz } from './ptz.js';
import { errorText } from './xiaomi/text.js';

import type { CameraDevice, DeviceStorage, StreamingInterface } from '@camera.ui/sdk';
import type { OpenSession } from './ptz.js';

export interface CameraValues {
  ptz?: boolean;
}

/** The switch of a camera that turns its motor from ViON. The camera settings show it next to autotracking. */
export const PTZ_KEY = 'ptz';

/**
 * A camera of the plugin: its stream address is asked from the plugin for every connection. Pan and tilt are switched
 * on per camera: the Mi Home device list does not say which models have a motor.
 */
export class Camera implements StreamingInterface {
  private readonly storage: DeviceStorage<CameraValues>;
  private ptz?: XiaomiPtz;

  constructor(
    public readonly device: CameraDevice,
    private readonly resolve: (nativeId: string) => Promise<string>,
    private readonly openMotor: (nativeId: string) => OpenSession,
  ) {
    this.storage = device.createStorage<CameraValues>([
      {
        type: 'boolean',
        key: PTZ_KEY,
        title: 'Pan and tilt (PTZ)',
        description: 'Turns the camera from ViON: arrows in the player and autotracking. For cameras with a motor, such as the Mi 360°, C200 and C300.',
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
    await this.applyPtz(this.storage.values.ptz === true);
  }

  public async streamUrl(_sourceId: string): Promise<string> {
    if (!this.device.nativeId) throw new Error(`Camera ${this.device.name} has no Xiaomi device id`);
    return this.resolve(this.device.nativeId);
  }

  /** The camera left the plugin: its motor session is closed. */
  public dispose(): void {
    this.ptz?.dispose();
  }

  private async applyPtz(on: boolean): Promise<void> {
    const nativeId = this.device.nativeId;
    if (on && !this.ptz && nativeId) {
      const ptz = new XiaomiPtz(this.openMotor(nativeId), this.device.logger);
      try {
        await this.device.addSensor(ptz);
        this.ptz = ptz;
      } catch (error) {
        this.device.logger.error('Could not add pan and tilt:', errorText(error));
        throw error;
      }
    } else if (!on && this.ptz) {
      const ptz = this.ptz;
      this.ptz = undefined;
      ptz.dispose();
      await this.device.removeSensor(ptz.id);
    }
  }
}
