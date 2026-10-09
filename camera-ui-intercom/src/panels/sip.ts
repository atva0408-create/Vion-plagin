/**
 * A panel that calls ViON over SIP, directly by IP (RUBITEK's path B, ТЗ 14.6 and 14.10): its call is the ring; the
 * agent speaks and listens in that call; a door opens by the panel's HTTP command, or by a DTMF code said into the
 * call; a code the visitor types at the panel during the call comes as keys and is checked like one typed anywhere.
 * ViON answering the call ("a person or the agent took it") stops the panel's own ringing; ViON's end of the visit
 * ends the call.
 *
 * The person's own voice does not go through SIP in this stage: the person hears and sees the panel by its RTSP, and
 * answers through the agent ("Answer in text"), or by the camera's talk channel where the panel has one.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { systemClock } from '@vionvision/speech';

import { HttpPanel } from './engine.js';

import type { Clock } from '@vionvision/speech';
import type { SipCall, SipCallHandler, SipServer } from '../sip/server.js';
import type { CommandResult, EngineOptions, PanelEngine, PanelListener, ProbeResult } from './engine.js';
import type { Credentials, PanelEventKind, PanelProfile } from './profile.js';

/** a code typed at the panel ends with "#" or after this pause; "*" starts it again */
const CODE_PAUSE_MS = 4_000;

export class SipPanel implements PanelEngine {
  private readonly http: HttpPanel;
  private current: SipCall | undefined;
  private off: (() => void) | undefined;
  private digits = '';
  private codeTimer: unknown;
  private readonly clock: Clock;

  constructor(
    readonly profile: PanelProfile,
    private readonly credentials: Credentials,
    private readonly listener: PanelListener,
    /** the plugin's SIP server, once it listens */
    private readonly sip: () => SipServer | undefined,
    options: EngineOptions = {},
  ) {
    // the HTTP side of the same panel: its doors' commands and the login check
    this.http = new HttpPanel(profile, credentials, { event: () => undefined, online: () => undefined }, options);
    this.clock = options.clock ?? systemClock;
  }

  /** The panel's call in progress, ringing or up. */
  get call(): SipCall | undefined {
    return this.current?.state === 'ended' ? undefined : this.current;
  }

  start(): void {
    const server = this.sip();
    if (this.off || !server) return;
    const handler: SipCallHandler = {
      ring: (call) => {
        void this.current?.hangUp();
        this.current = call;
        this.digits = '';
        this.listener.event('ring', { caller: call.caller });
      },
      ended: (call, why) => {
        if (this.current !== call) return;
        this.current = undefined;
        this.flushCode();
        // ViON's own end is not news to ViON
        if (why !== 'local') this.listener.event('call_end', { why });
      },
      dtmf: (call, digit) => {
        if (this.current === call) this.key(digit);
      },
      seen: () => this.listener.online(true),
    };
    const host = this.credentials.host;
    if (isIP(host)) {
      this.off = server.peer(host, handler);
      return;
    }
    // a panel set up by name: its calls come from the address of the name
    let stopped = false;
    this.off = () => (stopped = true);
    lookup(host, { family: 4 })
      .then(({ address }) => {
        if (!stopped) this.off = server.peer(address, handler);
      })
      .catch((error: Error) => this.listener.online(false, `the name ${host} is not known: ${error.message}`));
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    void this.current?.hangUp();
    this.current = undefined;
    this.clock.clearTimeout(this.codeTimer);
  }

  hook(): PanelEventKind[] {
    return [];
  }

  async open(doorKey: string): Promise<CommandResult> {
    const door = this.profile.doors.find((d) => d.key === doorKey);
    if (!door) return { ok: false, error: `the panel has no door "${doorKey}"` };
    if (!('dtmf' in door.open)) return this.http.open(doorKey);
    const call = this.call;
    if (!call) return { ok: false, error: 'the door opens by a code in a call, and the panel is not calling' };
    try {
      // the code goes into a call that is up: a ringing one is answered first
      await call.accept();
      return (await call.dtmf(door.open.dtmf)) ? { ok: true } : { ok: false, error: 'the panel did not take the code' };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** ViON took the call: the panel's call is answered, its ringing stops. */
  async answered(): Promise<CommandResult | undefined> {
    const call = this.call;
    if (!call) return this.profile.answered ? this.http.answered() : undefined;
    try {
      await call.accept();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async hangUp(): Promise<CommandResult | undefined> {
    const call = this.call;
    if (!call) return undefined;
    await call.hangUp();
    return { ok: true };
  }

  probe(): Promise<ProbeResult> {
    return this.http.probe();
  }

  /** Why the agent cannot speak through this panel: the SIP port could not be opened. */
  speakProblem(): string | undefined {
    const server = this.sip();
    return server?.running ? undefined : 'the SIP port is not open';
  }

  private key(digit: string): void {
    this.clock.clearTimeout(this.codeTimer);
    if (digit === '*') {
      this.digits = '';
      return;
    }
    if (digit === '#') {
      this.flushCode();
      return;
    }
    if (!/^\d$/.test(digit)) return;
    this.digits = (this.digits + digit).slice(-8);
    this.codeTimer = this.clock.setTimeout(() => this.flushCode(), CODE_PAUSE_MS);
  }

  private flushCode(): void {
    this.clock.clearTimeout(this.codeTimer);
    const digits = this.digits;
    this.digits = '';
    if (digits.length >= 4) this.listener.event('code', { digits });
  }
}
