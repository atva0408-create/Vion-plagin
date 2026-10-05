/**
 * A board running the ESPectre firmware (https://github.com/francescopace/espectre, GPLv3, by Francesco Pace), as is:
 * its Direct HTTP API and event stream (docs/API.md, protocol 1.0). The plugin only talks to the board over the network,
 * so it is a separate program, not part of ESPectre (ESPectre LICENSING.md says the same).
 */

export const ESPECTRE_PORT = 62587;
export const ESPECTRE_PATH = '/espectre/v1';
/**
 * The Native firmware answers 403 to a request without an Origin, and takes only the origins of the ESPectre portals
 * (DirectHttpServiceConfig::for_first_party_portals); its own CLI sends one of them too.
 */
const ORIGIN = 'https://espectre.dev';

export interface EspectreDevice {
  device_id: string;
  name: string;
  label: string;
  frontend: string;
  firmware: string;
  chip: string;
}

export type EspectreDetector = 'lightweight' | 'high_accuracy';

export interface EspectreSensing {
  enabled: boolean;
  /** Detector output may be used: calibrated, a full window, fresh packets. */
  ready: boolean;
  calibrating: boolean;
  mode: 'sensing' | 'csi_collection';
  derived_events_paused: boolean;
  detector: EspectreDetector;
  /** The probability of motion above which the board reports it, 0..1. */
  threshold: number;
  motion_on_hits: number;
  motion_off_hits: number;
  traffic_generator_mode: string;
  csi_target_pps: number;
}

export interface EspectreWifi {
  connected: boolean;
  ssid?: string;
  channel?: number;
  rssi_dbm: number | null;
  ip?: string;
}

export interface EspectreOta {
  state: string;
  busy: boolean;
  update_available: boolean;
  current_version: string;
  target_version: string;
  message: string;
}

export interface EspectreMotion {
  timestamp_ms: number;
  state: 'idle' | 'motion';
  /** The probability of motion of this evaluation, 0..1. */
  score: number;
}

export type EspectreSensingPatch = Partial<Pick<EspectreSensing, 'detector' | 'threshold' | 'motion_on_hits' | 'motion_off_hits' | 'traffic_generator_mode'>>;

const TIMEOUT_MS = 4000;

export class EspectreRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A board found by mDNS ("_espectre._tcp", docs/DISCOVERY.md) or at a typed address. */
export interface FoundEspectre {
  id: string;
  /** host:port of the Direct HTTP endpoint. */
  address: string;
  name: string;
  firmware?: string;
  chip?: string;
  /** native, esphome, matter or micro. */
  frontend?: string;
  seenAt: number;
}

export const DEVICE_ID = /^[0-9a-f]{16}$/;
const FRONTENDS = ['native', 'esphome', 'matter', 'micro'];

/**
 * The TXT record of an ESPectre service, by the rules of its discovery reference: anything else is another protocol
 * version or not ESPectre at all, and is not offered.
 */
export function espectreFromTxt(
  txt: Record<string, unknown>,
  address: string | undefined,
  port: number | undefined,
  name: string,
): Omit<FoundEspectre, 'seenAt'> | undefined {
  const value = (key: string) => {
    const found = Object.keys(txt).find((k) => k.toLowerCase() === key);
    const v = found === undefined ? undefined : txt[found];
    return typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
  };
  const id = value('device_id');
  if (!address || !/^\d+\.\d+\.\d+\.\d+$/.test(address) || !port) return undefined;
  if (value('txtvers') !== '1' || value('protovers') !== '1.0' || value('transport') !== 'http' || value('path') !== ESPECTRE_PATH) return undefined;
  if (!id || !DEVICE_ID.test(id) || !FRONTENDS.includes(value('frontend') ?? '')) return undefined;
  // an empty name is no name: the service name stands in
  const label = value('name');
  return { id, address: `${address}:${port}`, name: label?.trim() ? label : name, firmware: value('firmware'), chip: value('chip'), frontend: value('frontend') };
}

export class EspectreClient {
  constructor(public address: string) {}

  get base(): string {
    return `http://${this.address}${ESPECTRE_PATH}`;
  }

  device(): Promise<EspectreDevice> {
    return this.request('GET', '/device');
  }

  sensing(): Promise<EspectreSensing> {
    return this.request('GET', '/sensing');
  }

  wifi(): Promise<EspectreWifi> {
    return this.request('GET', '/wifi');
  }

  /** Only the Native firmware updates itself: on the others the board answers 404. */
  async ota(): Promise<EspectreOta | undefined> {
    try {
      return await this.request<EspectreOta>('GET', '/ota');
    } catch (error) {
      if (error instanceof EspectreRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * Packets per second the detector really gets — the first thing to look at when it misbehaves — and the signal now:
   * the board publishes its Wi-Fi resource only when the connection changes, not when the signal does.
   */
  async diagnostics(): Promise<{ packetsPerS?: number; rssi?: number }> {
    const fields = encodeURIComponent(JSON.stringify(['csi_accepted_pps', 'wifi_rssi_dbm']));
    const values = await this.request<{ csi_accepted_pps?: number | null; wifi_rssi_dbm?: number | null }>('GET', `/diagnostics?fields=${fields}`);
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    return { packetsPerS: number(values.csi_accepted_pps), rssi: number(values.wifi_rssi_dbm) };
  }

  configure(patch: EspectreSensingPatch): Promise<unknown> {
    return this.request('PATCH', '/sensing', patch);
  }

  calibrate(): Promise<unknown> {
    return this.request('POST', '/sensing/calibrations');
  }

  checkUpdate(): Promise<unknown> {
    return this.request('POST', '/ota/checks');
  }

  update(): Promise<unknown> {
    return this.request('POST', '/ota/updates');
  }

  private async request<T>(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? { origin: ORIGIN } : { origin: ORIGIN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error: any) {
      throw new EspectreRequestError(`${this.address} is not reachable: ${error?.cause?.code ?? error?.name ?? error}`);
    }
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new EspectreRequestError(`${path}: not JSON (HTTP ${response.status})`, response.status);
    }
    // mutations answer {accepted, code, message}; a refusal carries the reason in message
    if (!response.ok || data?.accepted === false) {
      throw new EspectreRequestError(data?.message ?? `HTTP ${response.status}`, response.status, data?.code);
    }
    return data as T;
  }
}

/** How long a stream may stay silent: the board sends a heartbeat every 10 s and motion several times a second. */
const SILENCE_MS = 15_000;
const CONNECT_MS = 5_000;
const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * The event stream of a board (SSE, GET /events), reopened whenever it ends: the board keeps no missed events, so the
 * owner reads the resources again on every open. A board accepts two streams at most: a quick retry after a failure
 * slows down so a stream the board has not closed yet is not counted twice.
 */
export class EspectreStream {
  private running = false;
  /** The connection loop that may still act: a stop or a restart leaves the old one to end by itself, quietly. */
  private generation = 0;
  private opened = false;
  private abort?: AbortController;
  private retry?: NodeJS.Timeout;
  private attempt = 0;

  constructor(
    private readonly client: EspectreClient,
    private readonly handlers: {
      open(): void;
      event(name: string, data: unknown): void;
      close(error: string): void;
    },
  ) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.opened = false;
    clearTimeout(this.retry);
    this.abort?.abort();
  }

  /** Drops the connection now and opens a new one at once: the board went silent, or it is at another address. */
  restart(reason: string): void {
    if (!this.running) return this.start();
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.abort?.abort();
    if (this.opened) {
      this.opened = false;
      this.handlers.close(`${this.client.address}: ${reason}`);
    }
    this.attempt = 0;
    void this.connect(generation);
  }

  private async connect(generation: number): Promise<void> {
    const current = () => this.running && generation === this.generation;
    if (!current()) return;
    const abort = new AbortController();
    this.abort = abort;
    let watchdog: NodeJS.Timeout | undefined;
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), ms);
    };
    let reason = 'the stream ended';
    let opened = false;
    try {
      arm(CONNECT_MS);
      const response = await fetch(`${this.client.base}/events`, { headers: { accept: 'text/event-stream', origin: ORIGIN }, signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if (!current()) return;
      opened = true;
      this.opened = true;
      this.attempt = 0;
      arm(SILENCE_MS);
      this.handlers.open();
      const decoder = new TextDecoder();
      let buffer = '';
      let event = 'message';
      let data: string[] = [];
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!current()) break;
        arm(SILENCE_MS);
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (line === '') {
            if (data.length) this.dispatch(event, data.join('\n'));
            event = 'message';
            data = [];
          } else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          // ": heartbeat" and other comments only keep the watchdog quiet
        }
      }
    } catch (error: any) {
      reason = abort.signal.aborted && this.running ? (opened ? 'the board went silent' : 'no answer') : `${error?.cause?.code ?? error?.message ?? error}`;
    } finally {
      clearTimeout(watchdog);
    }
    // stopped or restarted: whoever did it has told the owner already
    if (!current()) return;
    this.opened = false;
    this.handlers.close(`${this.client.address}: ${reason}`);
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt++;
    this.retry = setTimeout(() => void this.connect(generation), delay);
  }

  private dispatch(event: string, text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return; // not ours to understand: the protocol lets a board add events
    }
    this.handlers.event(event, data);
  }
}
