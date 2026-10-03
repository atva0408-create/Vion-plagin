// The web API of the Yandex Smart Home app. It is what the app and the site use, not an official API: it gives
// the devices with live updates, cameras' streams, and lets a station say any text through a scenario of the
// account (see LICENSE.md for where this comes from).
import WebSocket from 'ws';

import { YandexApiError, messageText } from './http.js';
import { parseQuasarDevice, parseQuasarDevices } from './home.js';

import type { YDevice, YScenario } from './home.js';
import type { YAction } from './iot.js';
import type { YandexSession } from './session.js';

export const QUASAR_URL = 'https://iot.quasar.yandex.ru';
export const GLAGOL_URL = 'https://quasar.yandex.net/glagol';

/** The longest text a scenario says, as the app allows it. */
export const CLOUD_TEXT_LIMIT = 100;
/** Scenarios the plugin keeps, one per station, start with this name. */
export const SCENARIO_PREFIX = 'ViON ';

const MASK_EN = '0123456789abcdef-';
const MASK_RU = 'оеаинтсрвлкмдпуяы';

/** The id of a station written in Russian letters: the voice phrase of its scenario, which no one says by chance. */
export function scenarioTrigger(deviceId: string): string {
  return [...deviceId.toLowerCase()].map((ch) => MASK_RU[MASK_EN.indexOf(ch)] ?? '').join('');
}

export function cloudText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, CLOUD_TEXT_LIMIT);
}

function scenarioBody(deviceId: string, capability: { type: string; state: { instance: string; value: unknown } }) {
  return {
    name: SCENARIO_PREFIX + deviceId,
    icon: 'home',
    triggers: [{ trigger: { type: 'scenario.trigger.voice', value: scenarioTrigger(deviceId) } }],
    steps: [
      {
        type: 'scenarios.steps.actions.v2',
        parameters: {
          items: [{ id: deviceId, type: 'step.action.item.device', value: { id: deviceId, item_type: 'device', capabilities: [capability] } }],
        },
      },
    ],
  };
}

export function ttsScenario(deviceId: string, text: string) {
  return scenarioBody(deviceId, { type: 'devices.capabilities.quasar', state: { instance: 'tts', value: { text: cloudText(text) } } });
}

export function commandScenario(deviceId: string, text: string) {
  return scenarioBody(deviceId, { type: 'devices.capabilities.quasar.server_action', state: { instance: 'text_action', value: cloudText(text) } });
}

export interface GlagolDevice {
  id: string;
  name: string;
  platform: string;
  host?: string;
  port?: number;
}

export class YandexQuasar {
  private scenarioIds = new Map<string, string>();

  constructor(
    private readonly session: YandexSession,
    private readonly baseUrl = QUASAR_URL,
  ) {}

  async devices(): Promise<{ devices: YDevice[]; updatesUrl?: string }> {
    const answer = await this.session.quasar('GET', `${this.baseUrl}/m/v3/user/devices`);
    return { devices: parseQuasarDevices(answer), updatesUrl: answer.updates_url };
  }

  async scenarios(): Promise<YScenario[]> {
    const answer = await this.session.quasar('GET', `${this.baseUrl}/m/user/scenarios`);
    return (answer.scenarios ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id) }));
  }

  async device(id: string): Promise<YDevice> {
    return parseQuasarDevice(await this.session.quasar('GET', `${this.baseUrl}/m/user/devices/${encodeURIComponent(id)}`));
  }

  async action(deviceId: string, actions: YAction[]): Promise<any> {
    return this.session.quasar('POST', `${this.baseUrl}/m/user/devices/${encodeURIComponent(deviceId)}/actions`, { actions });
  }

  async runScenario(id: string): Promise<void> {
    await this.session.quasar('POST', `${this.baseUrl}/m/user/scenarios/${encodeURIComponent(id)}/actions`);
  }

  /** The HLS address of a camera of the Smart Home; it is made for this one request. */
  async streamUrl(deviceId: string): Promise<string> {
    const answer = await this.action(deviceId, [{ type: 'devices.capabilities.video_stream', state: { instance: 'get_stream', value: { protocols: ['hls'] } } }]);
    const url = answer?.devices?.[0]?.capabilities?.[0]?.state?.value?.stream_url;
    if (typeof url !== 'string') throw new YandexApiError('Yandex gave no stream for the camera');
    return url;
  }

  /** The station says the text; the cloud way works wherever the station is, up to 100 characters. */
  async say(deviceId: string, text: string): Promise<void> {
    await this.runOwnScenario(deviceId, ttsScenario(deviceId, text));
  }

  /** The station does what the text asks, as if it were said to Alice. */
  async command(deviceId: string, text: string): Promise<void> {
    await this.runOwnScenario(deviceId, commandScenario(deviceId, text));
  }

  private async runOwnScenario(deviceId: string, body: ReturnType<typeof ttsScenario>): Promise<void> {
    const id = await this.ownScenario(deviceId);
    await this.session.quasar('PUT', `${this.baseUrl}/m/v4/user/scenarios/${encodeURIComponent(id)}`, body);
    await this.session.quasar('POST', `${this.baseUrl}/m/user/scenarios/${encodeURIComponent(id)}/actions`);
  }

  /** The scenario of the plugin for this station: found by its voice phrase, made when there is none. */
  private async ownScenario(deviceId: string): Promise<string> {
    const known = this.scenarioIds.get(deviceId);
    if (known) return known;
    const trigger = scenarioTrigger(deviceId);
    const answer = await this.session.quasar('GET', `${this.baseUrl}/m/user/scenarios`);
    for (const scenario of answer.scenarios ?? []) {
      const value = scenario?.triggers?.[0]?.value ?? scenario?.triggers?.[0]?.trigger?.value;
      if (value === trigger || scenario?.name === SCENARIO_PREFIX + deviceId) {
        this.scenarioIds.set(deviceId, String(scenario.id));
        return String(scenario.id);
      }
    }
    const created = await this.session.quasar('POST', `${this.baseUrl}/m/v4/user/scenarios`, ttsScenario(deviceId, 'ViON'));
    if (!created.scenario_id) throw new YandexApiError('Yandex did not create the scenario for the station');
    this.scenarioIds.set(deviceId, String(created.scenario_id));
    return String(created.scenario_id);
  }

  /** Stations that speak the local protocol, with their address in the home network when Yandex knows it. */
  async glagolDevices(): Promise<GlagolDevice[]> {
    const answer = await this.session.glagol(`${GLAGOL_URL}/device_list`);
    return (answer.devices ?? []).map((d: any) => {
      const info = d.networkInfo ?? d.network_info ?? {};
      const host = Array.isArray(info.ip_addresses) ? info.ip_addresses.find((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) : undefined;
      return { id: String(d.id), name: String(d.name ?? d.id), platform: String(d.platform ?? ''), host, port: Number(info.external_port) || undefined };
    });
  }

  /** The token a station accepts on its local connection; it is made for one station. */
  async glagolToken(deviceId: string, platform: string): Promise<string> {
    const answer = await this.session.glagol(`${GLAGOL_URL}/token?device_id=${encodeURIComponent(deviceId)}&platform=${encodeURIComponent(platform)}`);
    if (answer.status !== 'ok' || !answer.token) throw new YandexApiError('Yandex gave no token for the station');
    return String(answer.token);
  }
}

/**
 * Live state of the devices: the app keeps a socket open, and Yandex sends there what changed. The socket is
 * opened again after it closes; between, the list is read once, so nothing that changed meanwhile is missed.
 */
export class QuasarUpdates {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly quasar: YandexQuasar,
    private readonly onDevices: (devices: YDevice[]) => void,
    private readonly onUpdate: (update: any) => void,
    private readonly log: (message: string, error?: unknown) => void,
    private readonly retryMs = 30_000,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const { devices, updatesUrl } = await this.quasar.devices();
      this.onDevices(devices);
      if (!updatesUrl || this.stopped) return this.retry();
      const socket = new WebSocket(updatesUrl);
      this.socket = socket;
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(messageText(data));
          if (message.operation !== 'update_states') return;
          const payload = typeof message.message === 'string' ? JSON.parse(message.message) : message.message;
          for (const device of payload?.updated_devices ?? []) this.onUpdate(device);
        } catch (error) {
          this.log('Could not read an update of the Smart Home', error);
        }
      });
      socket.on('error', (error) => this.log('The live updates of the Smart Home failed', error));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        this.retry();
      });
    } catch (error) {
      this.log('Could not read the devices of the Smart Home', error);
      this.retry();
    }
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), this.retryMs);
    this.timer.unref?.();
  }
}
