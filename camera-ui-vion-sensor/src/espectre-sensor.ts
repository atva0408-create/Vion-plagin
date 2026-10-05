import { MotionSensor } from '@camera.ui/sdk';

import { ORIGIN } from './sensor.js';

import type { JsonSchema } from '@camera.ui/sdk';
import type { EspectreDetector, EspectreDevice, EspectreOta, EspectreSensing, EspectreSensingPatch, EspectreWifi } from './espectre.js';

/** What the settings of an ESPectre board can do; the plugin carries it out on the board. */
export interface EspectreActions {
  configure(patch: EspectreSensingPatch): Promise<void>;
  calibrate(): Promise<void>;
  checkUpdate(): Promise<void>;
  update(): Promise<void>;
}

/** What the plugin knows of the board now, for the settings. */
export interface EspectreView {
  device?: EspectreDevice;
  sensing?: EspectreSensing;
  wifi?: EspectreWifi;
  ota?: EspectreOta;
  score?: number;
  packetsPerS?: number;
  address: string;
  connected: boolean;
}

/** The traffic sources a board makes by itself; "external" needs another host to send it packets. */
const TRAFFIC: Record<string, string> = {
  ping: 'Pings to the router',
  dns: 'DNS queries to the router',
  dns_tcp: 'DNS over TCP to the router',
};

/** The motion sensor of a board with the ESPectre firmware, with the board's own settings in its settings in ViON. */
export class EspectreMotionSensor extends MotionSensor {
  private view?: EspectreView;
  private schemaKey = '';
  /** The counts the latest calls asked for, while some of them are still on their way to the board. */
  private hits?: { on: number; off: number };
  private hitsQueue: Promise<unknown> = Promise.resolve();
  private hitsPending = 0;

  constructor(
    name: string,
    nativeId: string,
    private readonly actions: EspectreActions,
  ) {
    super(name, { nativeId, origin: ORIGIN });
  }

  override get storageSchema(): JsonSchema[] {
    return this.schema();
  }

  /** New readings of the board: the settings show them, and are sent again only when something in them changed. */
  show(view: EspectreView, force = false): void {
    if (force) this.schemaKey = '';
    this.view = view;
    const fields = this.schema();
    const key = JSON.stringify(fields, (_key, v) => (typeof v === 'function' ? undefined : v));
    if (key === this.schemaKey) return;
    this.schemaKey = key;
    try {
      this.storage.defineSchemas(fields);
    } catch {
      // not registered yet: the host reads storageSchema when it registers the sensor
    }
  }

  /**
   * The board takes the two counts only together, and one save of both calls both fields at the same time: each call
   * sends the pair as all calls so far left it, one request after another, so neither count is lost.
   */
  private setHits(change: { on?: number; off?: number }): Promise<void> {
    const sensing = this.view?.sensing;
    if (!sensing) return Promise.reject(new Error('The sensor has not answered yet: try again in a few seconds'));
    this.hits = { on: change.on ?? this.hits?.on ?? sensing.motion_on_hits, off: change.off ?? this.hits?.off ?? sensing.motion_off_hits };
    this.hitsPending++;
    const sent = this.hitsQueue.then(() => this.actions.configure({ motion_on_hits: this.hits!.on, motion_off_hits: this.hits!.off }));
    const done = sent.finally(() => {
      if (--this.hitsPending === 0) this.hits = undefined;
    });
    // the next pair goes after a refused one too: the caller of this one hears the refusal from `done`
    this.hitsQueue = done.catch(() => undefined);
    return done;
  }

  private status(): string {
    const view = this.view;
    if (!view?.device || !view.connected) return 'Not reachable yet';
    const { device, sensing, wifi } = view;
    const parts = [`ESPectre ${device.firmware}`, device.chip, view.address.replace(/:\d+$/, '')];
    if (typeof wifi?.rssi_dbm === 'number') parts.push(`signal ${wifi.rssi_dbm} dBm`);
    if (sensing) {
      if (!sensing.enabled || sensing.mode !== 'sensing') parts.push('sensing is off');
      else if (sensing.calibrating) parts.push('calibrating: keep the room empty');
      else if (!sensing.ready) parts.push('not ready: too few packets from the router');
      else parts.push(`motion probability ${(view.score ?? 0).toFixed(2)} of ${sensing.threshold.toFixed(2)}`);
    }
    if (view.packetsPerS !== undefined) parts.push(`${Math.round(view.packetsPerS)} packets/s`);
    return parts.join(' · ');
  }

  private schema(): JsonSchema[] {
    const sensing = this.view?.sensing;
    const ota = this.view?.ota;
    const traffic = { ...TRAFFIC };
    // a mode set elsewhere (the ESPectre tools) is shown as it is, not replaced by a default
    if (sensing && !traffic[sensing.traffic_generator_mode]) traffic[sensing.traffic_generator_mode] = sensing.traffic_generator_mode;
    // The values below are the board's (a calibration and the ESPectre tools change them too): they are not stored in
    // ViON, so the form always shows what the board has — a stored value would win over it after the first save.
    const fields: JsonSchema[] = [
      { type: 'string', key: 'status', title: 'Sensor', description: 'What the board reports now.', readonly: true, defaultValue: this.status() },
      {
        type: 'string',
        key: 'detector',
        title: 'Detection',
        description:
          'Lightweight: two signal features, learns the empty room for 10-30 s after a start. ' +
          'High accuracy: a small neural network over eight features, trained by ESPectre, needs no calibration.',
        defaultValue: sensing?.detector ?? 'lightweight',
        enum: ['lightweight', 'high_accuracy'],
        enumLabels: { lightweight: 'Lightweight', high_accuracy: 'High accuracy (neural network)' },
        store: false,
        onSet: async (value) => this.actions.configure({ detector: value as EspectreDetector }),
      },
      {
        type: 'number',
        key: 'threshold',
        title: 'Motion threshold',
        description: 'The probability of motion above which the sensor reports it. Lower is more sensitive and gives more false alarms. Calibration sets it again.',
        minimum: 0.05,
        maximum: 0.99,
        step: 0.01,
        defaultValue: sensing ? Number(sensing.threshold.toFixed(2)) : 0.66,
        store: false,
        onSet: async (value) => this.actions.configure({ threshold: Number(value) }),
      },
      {
        type: 'number',
        key: 'motionOnHits',
        title: 'Readings to start motion',
        description: 'How many readings in a row must see motion before the sensor reports it. More is fewer false alarms and a later alarm.',
        minimum: 1,
        maximum: 20,
        step: 1,
        defaultValue: sensing?.motion_on_hits ?? 1,
        store: false,
        onSet: async (value) => this.setHits({ on: Number(value) }),
      },
      {
        type: 'number',
        key: 'motionOffHits',
        title: 'Readings to end motion',
        description: 'How many quiet readings in a row end the motion.',
        minimum: 1,
        maximum: 20,
        step: 1,
        defaultValue: sensing?.motion_off_hits ?? 1,
        store: false,
        onSet: async (value) => this.setHits({ off: Number(value) }),
      },
      {
        type: 'string',
        key: 'traffic',
        title: 'Signal source',
        description: 'What the board sends to the router to get the answers it measures.',
        defaultValue: sensing?.traffic_generator_mode ?? 'ping',
        enum: Object.keys(traffic),
        enumLabels: traffic,
        store: false,
        onSet: async (value) => this.actions.configure({ traffic_generator_mode: String(value) }),
      },
      {
        type: 'button',
        key: 'calibrate',
        title: 'Calibrate',
        description: 'The sensor learns the empty room again (Lightweight): leave the room before pressing.',
        onSet: async () => this.actions.calibrate(),
      },
    ];
    // only the Native firmware updates itself, from the ESPectre releases
    if (ota) {
      if (ota.update_available && !ota.busy) {
        fields.push({
          type: 'button',
          key: 'update',
          title: `Update the firmware to ${ota.target_version}`,
          description: 'An official ESPectre release. Sensing stops while it installs; the board restarts.',
          onSet: async () => this.actions.update(),
        });
      } else if (!ota.busy) {
        fields.push({
          type: 'button',
          key: 'checkUpdate',
          title: 'Check for a new firmware',
          description: 'Asks the ESPectre releases for a newer version.',
          onSet: async () => this.actions.checkUpdate(),
        });
      }
      if (ota.busy || ota.state === 'error' || ota.state === 'up_to_date' || ota.state === 'reboot_scheduled') {
        fields.push({
          type: 'string',
          key: 'updateStatus',
          title: 'Firmware update',
          description: '',
          readonly: true,
          defaultValue: ota.message || ota.state,
        });
      }
    }
    return fields;
  }
}
