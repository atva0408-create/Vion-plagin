/**
 * A panel that speaks HTTP (Dahua, Hikvision, RUBITEK and Akuvox, or anything that calls an address on a ring), driven
 * by its profile: the engine knows how to keep an event stream open, read a status every so often, take an event the
 * panel sends, and send a command; the profile says which paths, which fields mean a ring, and which request opens a
 * door.
 *
 * Commands are sent once. A failed opening is not tried another way: the door may have opened anyway (a Dahua answering
 * 400 after opening is known), and opening twice is worse than reporting a doubt.
 */
import { systemClock } from '@vionvision/speech';

import { panelRequest, readText } from './http.js';
import { eventsOf, fieldsOf, fill, pick } from './profile.js';
import { MultipartSplitter, boundaryOf, dahuaFields, hikvisionFields } from './stream.js';

import type { Clock } from '@vionvision/speech';
import type { Fetcher, PanelAddress } from './http.js';
import type { Credentials, HttpCommand, PanelCommand, PanelEventKind, PanelProfile } from './profile.js';

export interface PanelListener {
  event(kind: PanelEventKind, fields: Record<string, string>): void;
  /** the panel answers again, or stopped answering (with why) */
  online(ok: boolean, reason?: string): void;
}

export interface CommandResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ProbeResult {
  /** the login works */
  login: boolean;
  model?: string;
  firmware?: string;
  error?: string;
}

/** Pauses before reconnecting an event stream, then the last one again and again. */
export const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000];
const COMMAND_TIMEOUT_MS = 8_000;

/** What the plugin asks of a panel's engine, whatever it speaks (HTTP here, SIP in sip.ts). */
export interface PanelEngine {
  readonly profile: PanelProfile;
  start(): void;
  stop(): void;
  /** an event the panel sent to the intercom's address */
  hook(request: { query: Record<string, string>; body?: string; contentType?: string }): PanelEventKind[];
  open(doorKey: string): Promise<CommandResult>;
  answered(): Promise<CommandResult | undefined>;
  hangUp(): Promise<CommandResult | undefined>;
  probe(): Promise<ProbeResult>;
}

export interface EngineOptions {
  fetcher?: Fetcher;
  clock?: Clock;
  log?: (message: string) => void;
  /** how long an event stream may say nothing before it is opened again; by default from its heartbeat */
  streamIdleMs?: number;
}

/**
 * A stream that says nothing for this long, heartbeats included, is a link that dropped without telling (a panel that
 * rebooted, a cable): three heartbeats when the path asks for them (Dahua's `heartbeat=5`), else two minutes.
 */
export function streamIdleMs(path: string): number {
  const heartbeat = Number(/[?&]heartbeat=(\d+)/i.exec(path)?.[1]);
  return Number.isFinite(heartbeat) && heartbeat > 0 ? Math.max(15_000, heartbeat * 3_000) : 120_000;
}

export class HttpPanel implements PanelEngine {
  private readonly address: PanelAddress;
  private readonly fetcher: Fetcher;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private readonly idleMs: number | undefined;
  private abort: AbortController | undefined;
  private timer: unknown;
  private stopped = true;
  private failures = 0;
  private isOnline: boolean | undefined;
  /** of a status read every so often: the events it showed last time, so a ring that lasts is told once */
  private lastPolled = new Set<PanelEventKind>();

  constructor(
    readonly profile: PanelProfile,
    private readonly credentials: Credentials,
    private readonly listener: PanelListener,
    options: EngineOptions = {},
  ) {
    this.address = {
      host: credentials.host,
      port: credentials.httpPort ?? profile.ports.http,
      username: credentials.username,
      password: credentials.password,
      auth: profile.auth,
    };
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
    this.idleMs = options.streamIdleMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const events = this.profile.events;
    if (events.via === 'stream') void this.stream(events.path, events.format);
    else if (events.via === 'poll') this.poll(events.path, events.everyMs);
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.clock.clearTimeout(this.timer);
  }

  /** An event the panel sent to the intercom's address (Action URL): its query and body as fields. */
  hook(request: { query: Record<string, string>; body?: string; contentType?: string }): PanelEventKind[] {
    const fields: Record<string, string> = { ...request.query };
    if (request.body) {
      if (request.contentType?.includes('application/x-www-form-urlencoded')) {
        for (const [key, value] of new URLSearchParams(request.body)) fields[key] = value;
      } else Object.assign(fields, fieldsOf(request.body));
    }
    const kinds = eventsOf(fields, this.profile.rules);
    for (const kind of kinds) this.listener.event(kind, fields);
    this.setOnline(true);
    return kinds;
  }

  async open(doorKey: string): Promise<CommandResult> {
    const door = this.profile.doors.find((d) => d.key === doorKey);
    if (!door) return { ok: false, error: `the panel has no door "${doorKey}"` };
    return this.send(door.open, doorKey);
  }

  /** Tells the panel the call was answered in ViON (its own monitors stop ringing). */
  async answered(): Promise<CommandResult | undefined> {
    return this.profile.answered ? this.send(this.profile.answered) : undefined;
  }

  async hangUp(): Promise<CommandResult | undefined> {
    return this.profile.hangUp ? this.send(this.profile.hangUp) : undefined;
  }

  async probe(): Promise<ProbeResult> {
    const probe = this.profile.probe;
    if (!probe) {
      // a panel without a probe: any answer that is not "login wrong" counts
      try {
        const response = await this.request({ method: 'GET', path: '/' });
        await response.body?.cancel().catch(() => undefined);
        return { login: response.status !== 401 && response.status !== 403 };
      } catch (error) {
        return { login: false, error: (error as Error).message };
      }
    }
    try {
      const response = await this.request(probe.command);
      const text = await readText(response);
      if (response.status === 401 || response.status === 403) return { login: false, error: 'the login or password is wrong' };
      if (!response.ok) return { login: false, error: `HTTP ${response.status}` };
      const fields = fieldsOf(text);
      return { login: true, model: pick(fields, probe.model), firmware: pick(fields, probe.firmware) };
    } catch (error) {
      return { login: false, error: (error as Error).message };
    }
  }

  private async send(command: PanelCommand, door?: string): Promise<CommandResult> {
    if ('dtmf' in command) return { ok: false, error: 'a DTMF command goes into a SIP call, not over HTTP' };
    try {
      const response = await this.request(command, door);
      await response.body?.cancel().catch(() => undefined);
      const ok = command.okStatus ? command.okStatus.includes(response.status) : response.ok;
      return ok ? { ok, status: response.status } : { ok, status: response.status, error: `the panel answered HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private request(command: HttpCommand, door?: string, signal?: AbortSignal): Promise<Response> {
    return panelRequest(
      this.address,
      {
        method: command.method,
        path: fill(command.path, this.profile, this.credentials, door),
        body: command.body === undefined ? undefined : fill(command.body, this.profile, this.credentials, door),
        contentType: command.contentType,
        signal: signal ?? AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      },
      this.fetcher,
    );
  }

  private setOnline(ok: boolean, reason?: string): void {
    if (this.isOnline === ok) return;
    this.isOnline = ok;
    this.listener.online(ok, reason);
  }

  private retry(run: () => void, reason: string): void {
    if (this.stopped) return;
    const pause = RECONNECT_MS[Math.min(this.failures, RECONNECT_MS.length - 1)];
    this.failures++;
    // a stream that drops once is not a panel gone: offline only after the pauses ran out
    if (this.failures > RECONNECT_MS.length) this.setOnline(false, reason);
    this.timer = this.clock.setTimeout(run, pause);
  }

  private async stream(path: string, format: 'dahua' | 'hikvision'): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.abort = abort;
    const parse = format === 'dahua' ? dahuaFields : hikvisionFields;
    let reason = 'the event stream ended';
    let silent = false;
    let idle: unknown;
    const idleMs = this.idleMs ?? streamIdleMs(path);
    const watch = () => {
      this.clock.clearTimeout(idle);
      idle = this.clock.setTimeout(() => {
        silent = true;
        abort.abort();
      }, idleMs);
    };
    watch();
    try {
      const response = await this.request({ method: 'GET', path }, undefined, abort.signal);
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'the login or password is wrong' : `HTTP ${response.status}`);
      const boundary = boundaryOf(response.headers.get('content-type'));
      if (!boundary) throw new Error('the panel did not answer with an event stream');
      this.failures = 0;
      this.setOnline(true);
      const splitter = new MultipartSplitter(boundary);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        watch();
        for (const body of splitter.push(value)) {
          for (const fields of parse(body)) for (const kind of eventsOf(fields, this.profile.rules)) this.listener.event(kind, fields);
        }
      }
    } catch (error) {
      if (this.stopped) return;
      reason = silent ? `the event stream said nothing for ${Math.round(idleMs / 1000)} s` : (error as Error).message;
      this.log(`${this.profile.id} at ${this.credentials.host}: ${reason}`);
    } finally {
      this.clock.clearTimeout(idle);
    }
    this.retry(() => void this.stream(path, format), reason);
  }

  private poll(path: string, everyMs: number): void {
    const once = async () => {
      if (this.stopped) return;
      try {
        const response = await this.request({ method: 'GET', path });
        const text = await readText(response);
        if (!response.ok) throw new Error(response.status === 401 ? 'the login or password is wrong' : `HTTP ${response.status}`);
        this.failures = 0;
        this.setOnline(true);
        const fields = fieldsOf(text);
        const now = new Set(eventsOf(fields, this.profile.rules));
        for (const kind of now) if (!this.lastPolled.has(kind)) this.listener.event(kind, fields);
        this.lastPolled = now;
        if (!this.stopped) this.timer = this.clock.setTimeout(() => void once(), everyMs);
      } catch (error) {
        if (this.stopped) return;
        this.retry(() => void once(), (error as Error).message);
      }
    };
    void once();
  }
}
