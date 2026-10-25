import { Bonjour } from 'bonjour-service';

import type { Browser, Service } from 'bonjour-service';

/** A camera seen in the network: by mDNS ("_vion-camera._tcp") or at an address typed in the settings. */
export interface FoundCamera {
  id: string;
  /** host:port of its API */
  address: string;
  name: string;
  firmware?: string;
  model?: string;
  seenAt: number;
}

/** Looks for cameras in the network and keeps where each one is now: the router may hand out another address. */
export class CameraFinder {
  private bonjour?: Bonjour;
  private browser?: Browser;
  private timer?: NodeJS.Timeout;
  readonly found = new Map<string, FoundCamera>();

  constructor(
    private readonly onFound: (camera: FoundCamera) => void,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: 'vion-camera' }, (service) => this.fromService(service));
      // mDNS answers are not repeated by themselves: ask again so a camera that came later or moved is seen
      this.timer = setInterval(() => this.browser?.update(), 30_000);
    } catch (error: any) {
      this.log(`mDNS search is not available here (${error?.message ?? error}): add cameras by address in the settings`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = undefined;
    this.bonjour = undefined;
  }

  /** A camera answered at this address (mDNS, a typed address or a poll that found it moved). */
  remember(camera: Omit<FoundCamera, 'seenAt'>): void {
    const known = this.found.get(camera.id);
    const next = { ...camera, seenAt: Date.now() };
    this.found.set(camera.id, next);
    if (known?.address !== next.address || known.name !== next.name) this.onFound(next);
  }

  fromService(service: Service): void {
    const address = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.referer?.address;
    const txt = (service.txt ?? {}) as Record<string, string>;
    const id = String(txt.id ?? '').toUpperCase();
    if (!address || !id) return;
    this.remember({ id, address: `${address}:${service.port}`, name: service.name, firmware: txt.fw, model: txt.model });
  }
}
