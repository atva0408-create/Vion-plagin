import { Bonjour } from 'bonjour-service';

import { espectreFromTxt } from './espectre.js';

import type { Browser, Service } from 'bonjour-service';
import type { FoundEspectre } from './espectre.js';

/** A sensor seen in the network: by mDNS ("_vion-sensor._tcp") or at an address typed in the settings. */
export interface FoundSensor {
  id: string;
  address: string;
  name: string;
  firmware?: string;
  seenAt: number;
}

/**
 * Looks for sensors in the network and keeps where each one is now: the router may hand out another address. Boards with
 * the ESPectre firmware announce "_espectre._tcp" and are kept apart: they speak another API.
 */
export class SensorFinder {
  private bonjour?: Bonjour;
  private browser?: Browser;
  private espectreBrowser?: Browser;
  private timer?: NodeJS.Timeout;
  readonly found = new Map<string, FoundSensor>();
  readonly espectre = new Map<string, FoundEspectre>();

  constructor(
    private readonly onFound: (sensor: FoundSensor) => void,
    private readonly log: (message: string) => void,
    private readonly onFoundEspectre: (board: FoundEspectre) => void = () => {},
  ) {}

  start(): void {
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: 'vion-sensor' }, (service) => this.fromService(service));
      this.espectreBrowser = this.bonjour.find({ type: 'espectre' }, (service) => this.fromEspectreService(service));
      // mDNS answers are not repeated by themselves: ask again so a sensor that came later or moved is seen
      this.timer = setInterval(() => {
        this.browser?.update();
        // a board back at another address after a power cut sent no goodbye, and a browser reports a service it already
        // knows only once: a new browser hears every ESPectre board again, where it is now
        this.espectreBrowser?.stop();
        this.espectreBrowser = this.bonjour?.find({ type: 'espectre' }, (service) => this.fromEspectreService(service));
      }, 30_000);
    } catch (error: any) {
      this.log(`mDNS search is not available here (${error?.message ?? error}): add sensors by address in the settings`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.browser?.stop();
    this.espectreBrowser?.stop();
    this.bonjour?.destroy();
    this.browser = undefined;
    this.espectreBrowser = undefined;
    this.bonjour = undefined;
  }

  /** A sensor answered at this address (mDNS, a typed address or a poll that found it moved). */
  remember(sensor: Omit<FoundSensor, 'seenAt'>): void {
    const known = this.found.get(sensor.id);
    const next = { ...sensor, seenAt: Date.now() };
    this.found.set(sensor.id, next);
    if (known?.address !== next.address || known.name !== next.name) this.onFound(next);
  }

  /** An ESPectre board answered at this address (mDNS or a typed address). */
  rememberEspectre(board: Omit<FoundEspectre, 'seenAt'>): void {
    const known = this.espectre.get(board.id);
    const next = { ...board, seenAt: Date.now() };
    this.espectre.set(board.id, next);
    if (known?.address !== next.address || known.name !== next.name) this.onFoundEspectre(next);
  }

  fromEspectreService(service: Service): void {
    const address = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.referer?.address;
    const board = espectreFromTxt((service.txt ?? {}) as Record<string, unknown>, address, service.port, service.name);
    if (board) this.rememberEspectre(board);
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
