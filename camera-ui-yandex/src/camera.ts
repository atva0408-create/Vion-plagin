import type { CameraDevice, StreamingInterface } from '@camera.ui/sdk';

/** A camera of the plugin: its stream address is asked from the plugin for every connection. */
export class Camera implements StreamingInterface {
  constructor(
    public readonly device: CameraDevice,
    private readonly resolve: (nativeId: string) => Promise<string>,
  ) {}

  public async initialize(): Promise<void> {
    await this.device.implement(this);
    this.device.connect();
  }

  public async streamUrl(_sourceId: string): Promise<string> {
    if (!this.device.nativeId) throw new Error(`Camera ${this.device.name} has no Yandex device id`);
    return this.resolve(this.device.nativeId);
  }
}
