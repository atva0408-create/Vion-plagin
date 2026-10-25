/** The HTTP API of a VION camera (VIONN- camera/device: the service on the camera). */

export const API_PORT = 8090;

export interface StreamInfo {
  path: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
}

export interface CameraInfo {
  id: string;
  kind: string;
  model: string;
  board: string;
  firmware: string;
  name: string;
  paired: boolean;
  rtsp_port: number;
  streams: { main: StreamInfo; sub: StreamInfo };
}

/** The picture is behind it: the camera gives it to the VION that pairs, and to no one else. */
export interface RtspAccess {
  port: number;
  username: string;
  password: string;
}

export interface CameraHealth {
  uptime_s: number;
  load1: number;
  temps_c: Record<string, number>;
  streams: Record<string, { up: boolean; consumers: number }>;
  processes: { name: string; running: boolean; restarts: number; last_error?: string; uptime_s: number }[];
}

export interface CameraSettings {
  name: string;
  fps: number;
  main: { width: number; height: number; kbps: number };
  sub: { width: number; height: number; kbps: number };
}

export class CameraRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class CameraClient {
  constructor(
    /** host or host:port of the camera's API */
    public address: string,
    public token?: string,
  ) {}

  get host(): string {
    return this.address.replace(/:\d+$/, '');
  }

  private get base(): string {
    return `http://${/:\d+$/.test(this.address) ? this.address : `${this.address}:${API_PORT}`}`;
  }

  info(): Promise<CameraInfo> {
    return this.request('GET', '/api/info', undefined, false);
  }

  /** The first caller gets the token and the RTSP access; a camera that has an owner answers 409. */
  pair(): Promise<{ token: string; info: CameraInfo; rtsp: RtspAccess }> {
    return this.request('POST', '/api/pair', undefined, false);
  }

  state(): Promise<{ info: CameraInfo; settings: CameraSettings; health: CameraHealth }> {
    return this.request('GET', '/api/state');
  }

  config(patch: Partial<CameraSettings>): Promise<{ settings: CameraSettings }> {
    return this.request('POST', '/api/config', patch);
  }

  /** The camera forgets this VION; its RTSP password changes. */
  reset(): Promise<{ paired: boolean }> {
    return this.request('POST', '/api/reset');
  }

  streamUrl(access: RtspAccess, path: string): string {
    return `rtsp://${encodeURIComponent(access.username)}:${encodeURIComponent(access.password)}@${this.host}:${access.port}${path}`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (auth) {
      if (!this.token) throw new CameraRequestError('the camera is not added to this VION');
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error: any) {
      throw new CameraRequestError(`the camera at ${this.address} does not answer (${error?.cause?.code ?? error?.message ?? error})`);
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new CameraRequestError(data.error ?? `the camera answered ${response.status}`, response.status);
    return data as T;
  }
}
