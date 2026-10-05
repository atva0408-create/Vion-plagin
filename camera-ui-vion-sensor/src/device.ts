/** The HTTP API of a ViON Sensor board (firmware: "sensor esp VION", src/api.h). */

export interface SensorInfo {
  id: string;
  kind: string;
  model: string;
  firmware: string;
  name: string;
  room: string;
  paired: boolean;
  ip: string;
  rssi: number;
  uptime_s: number;
  camera: { enabled: boolean; state: 'off' | 'on' | 'error' };
  config: { threshold: number; hold_s: number };
}

export interface SensorState {
  motion: boolean;
  /** Counts the starts of motion: a poll that missed a short one still sees it. */
  events: number;
  calibrating: boolean;
  calibration_left_s: number;
  /** No packets from the router: the sensor sees nothing, which is not the same as quiet. */
  blind: boolean;
  score: number;
  baseline: number;
  threshold: number;
  packets_per_s: number;
  rssi: number;
  uptime_s: number;
  camera: 'off' | 'on' | 'error';
  update: { state: 'idle' | 'downloading' | 'done' | 'failed'; progress: number; error?: string };
}

export interface SensorConfigPatch {
  name?: string;
  room?: string;
  threshold?: number;
  hold_s?: number;
  camera?: boolean;
}

const TIMEOUT_MS = 4000;

export class SensorRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class SensorClient {
  constructor(
    public address: string,
    public token?: string,
  ) {}

  get base(): string {
    return `http://${this.address}`;
  }

  info(): Promise<SensorInfo> {
    return this.request('GET', '/api/info', undefined, false);
  }

  /** The first caller gets the token; a sensor that has an owner answers 409. */
  pair(): Promise<SensorInfo & { token: string }> {
    return this.request('POST', '/api/pair', undefined, false);
  }

  state(): Promise<SensorState> {
    return this.request('GET', '/api/state');
  }

  configure(patch: SensorConfigPatch): Promise<SensorInfo & { restarting: boolean }> {
    return this.request('POST', '/api/config', patch);
  }

  recalibrate(): Promise<{ ok: boolean; calibration_s: number }> {
    return this.request('POST', '/api/recalibrate');
  }

  update(url: string, sha256: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/update', { url, sha256 });
  }

  reset(): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/reset');
  }

  snapshotUrl(): string {
    return `${this.base}/snapshot?token=${encodeURIComponent(this.token ?? '')}`;
  }

  /** The video has its own port, 81, on the board's host: an address typed with a port keeps only its host. */
  streamUrl(): string {
    const host = this.address.replace(/:\d+$/, '');
    return `http://${host}:81/stream?token=${encodeURIComponent(this.token ?? '')}`;
  }

  async snapshot(): Promise<ArrayBuffer> {
    const response = await fetch(this.snapshotUrl(), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new SensorRequestError(`snapshot: HTTP ${response.status}`, response.status);
    return response.arrayBuffer();
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (auth) {
      if (!this.token) throw new SensorRequestError('the sensor is not paired with this ViON');
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? (method === 'POST' ? '' : undefined) : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error: any) {
      throw new SensorRequestError(`${this.address} is not reachable: ${error?.cause?.code ?? error?.name ?? error}`);
    }
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new SensorRequestError(`${path}: not JSON (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) throw new SensorRequestError(data?.error ?? `HTTP ${response.status}`, response.status);
    return data as T;
  }
}
