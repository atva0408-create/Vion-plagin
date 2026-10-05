import { Bonjour } from 'bonjour-service';

import type { Browser, Service } from 'bonjour-service';

/** A sensor seen in the network: by mDNS ("_vion-sensor._tcp") or at an address typed in the settings. */
export interface FoundSensor {
  id: string;
  address: string;
  name: string;
  firmware?: string;
  seenAt: number;
}

/** Looks for sensors in the network and keeps where each one is now: the router may hand out another address. */
export class SensorFinder {
  private bonjour?: Bonjour;
  private browser?: Browser;
  private timer?: NodeJS.Timeout;
  readonly found = new Map<string, FoundSensor>();

  constructor(
    private readonly onFound: (sensor: FoundSensor) => void,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: 'vion-sensor' }, (service) => this.fromService(service));
      // mDNS answers are not repeated by themselves: ask again so a sensor that came later or moved is seen
      this.timer = setInterval(() => this.browser?.update(), 30_000);
    } catch (error: any) {
      this.log(`mDNS search is not available here (${error?.message ?? error}): add sensors by address in the settings`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = undefined;
    this.bonjour = undefined;
  }

  /** A sensor answered at this address (mDNS, a typed address or a poll that found it moved). */
  remember(sensor: Omit<FoundSensor, 'seenAt'>): void {
    const known = this.found.get(sensor.id);
    const next = { ...sensor, seenAt: Date.now() };
    this.found.set(sensor.id, next);
    if (known?.address !== next.address || known.name !== next.name) this.onFound(next);
  }

  private fromService(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, string>;
    const id = typeof txt.id === 'string' ? txt.id.toUpperCase() : undefined;
    const address = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.referer?.address;
    if (!id || !address) return;
    const port = service.port && service.port !== 80 ? `:${service.port}` : '';
    this.remember({ id, address: `${address}${port}`, name: service.name, firmware: txt.fw });
  }
}
