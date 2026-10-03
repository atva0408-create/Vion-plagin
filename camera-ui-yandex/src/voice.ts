// Speech on the Yandex stations: through the local protocol when ViON reaches the station in the home network,
// through a scenario of the account otherwise. Both need the sign-in by QR code or x_token.
import { GlagolClient, GLAGOL_PORT, commandPayload, sayPayload } from './yandex/glagol.js';
import { cloudText } from './yandex/quasar.js';

import type { YDevice } from './yandex/home.js';
import type { GlagolDevice, YandexQuasar } from './yandex/quasar.js';

export type VoiceMode = 'auto' | 'local' | 'cloud';
export type VoiceRoute = 'local' | 'cloud';

/** How long the list of the stations in the home network is trusted. */
const LOCAL_LIST_MS = 10 * 60_000;

/** "Hall = 192.168.1.20" lines of the settings: a name or id of a station and its address. */
export function parseHosts(raw: string | undefined): Map<string, { host: string; port: number }> {
  const result = new Map<string, { host: string; port: number }>();
  for (const line of (raw ?? '').split(/[\n,;]/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const [host = '', port] = line
      .slice(i + 1)
      .trim()
      .split(':');
    if (key && host) result.set(key, { host, port: Number(port) || GLAGOL_PORT });
  }
  return result;
}

export class StationVoice {
  private clients = new Map<string, GlagolClient>();
  private tokens = new Map<string, string>();
  private local?: { at: number; devices: GlagolDevice[] };

  constructor(
    private readonly quasar: () => YandexQuasar | undefined,
    private readonly settings: () => { mode: VoiceMode; hosts: string | undefined; secure?: boolean },
    private readonly debug: (message: string, error?: unknown) => void,
  ) {}

  async say(station: YDevice, text: string): Promise<VoiceRoute> {
    return this.deliver(station, text, 'say');
  }

  async command(station: YDevice, text: string): Promise<VoiceRoute> {
    return this.deliver(station, text, 'command');
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.tokens.clear();
    this.local = undefined;
  }

  private async deliver(station: YDevice, text: string, what: 'say' | 'command'): Promise<VoiceRoute> {
    const quasar = this.quasar();
    if (!quasar) throw new Error('The station speaks after the sign-in by QR code or x_token in the settings of the plugin');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to say');
    const { mode } = this.settings();

    if (mode !== 'cloud') {
      try {
        await this.sendLocal(quasar, station, what === 'say' ? sayPayload(clean) : commandPayload(clean));
        return 'local';
      } catch (error) {
        if (mode === 'local') throw error;
        this.debug(`${station.name}: the local connection failed, speaking through the cloud`, error);
      }
    }
    if (what === 'say') await quasar.say(station.id, cloudText(clean));
    else await quasar.command(station.id, cloudText(clean));
    return 'cloud';
  }

  private async sendLocal(quasar: YandexQuasar, station: YDevice, payload: Record<string, unknown>): Promise<void> {
    const info = station.quasar;
    if (!info) throw new Error(`${station.name} has no local connection`);
    const target = await this.target(quasar, station);
    if (!target) throw new Error(`The address of ${station.name} in the home network is unknown`);

    let client = this.clients.get(info.deviceId);
    const secure = this.settings().secure ?? true;
    if (client) client.retarget({ ...target, secure });
    else {
      client = new GlagolClient({ ...target, secure }, async () => {
        const known = this.tokens.get(info.deviceId);
        if (known) return known;
        const token = await quasar.glagolToken(info.deviceId, info.platform);
        this.tokens.set(info.deviceId, token);
        return token;
      });
      this.clients.set(info.deviceId, client);
    }

    try {
      await client.send(payload);
    } catch (error) {
      // a token of the station lives for a while; a refused one is made anew once
      this.tokens.delete(info.deviceId);
      client.close();
      this.debug(`${station.name}: retrying the local connection with a new token`, error);
      await client.send(payload);
    }
  }

  private async target(quasar: YandexQuasar, station: YDevice): Promise<{ host: string; port: number } | undefined> {
    const hosts = parseHosts(this.settings().hosts);
    const manual =
      hosts.get(station.name.toLowerCase()) ?? (station.quasar ? hosts.get(station.quasar.deviceId.toLowerCase()) : undefined) ?? hosts.get(station.id.toLowerCase());
    if (manual) return manual;

    if (!this.local || Date.now() - this.local.at > LOCAL_LIST_MS) {
      this.local = { at: Date.now(), devices: await quasar.glagolDevices() };
    }
    const found = this.local.devices.find((d) => d.id === station.quasar?.deviceId);
    return found?.host ? { host: found.host, port: found.port ?? GLAGOL_PORT } : undefined;
  }
}
