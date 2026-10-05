import { MotionSensor, OccupancySensor } from '@camera.ui/sdk';

import { newer } from './firmware.js';

import type { JsonSchema } from '@camera.ui/sdk';
import type { SensorInfo, SensorState } from './device.js';
import type { FirmwareRelease } from './firmware.js';

export const ORIGIN = 'vion-sensor';

/** Which algorithm of the board makes the motion of this sensor in ViON. */
export type MotionSource = 'vion' | 'espressif' | 'any';

/** What the settings of one sensor can do; the plugin carries it out on the board. */
export interface SensorActions {
  configure(patch: { threshold?: number; hold_s?: number; camera?: boolean; presence_sensitivity?: number }): Promise<void>;
  recalibrate(): Promise<void>;
  update(): Promise<void>;
  reset(): Promise<void>;
  motionSource(): MotionSource;
  setMotionSource(source: MotionSource): Promise<void>;
}

/** Presence of a person in the room, a person standing still too: the second sensor of a board (firmware 1.1.0+). */
export class VionPresenceSensor extends OccupancySensor {
  constructor(name: string, nativeId: string) {
    super(name, { nativeId, origin: ORIGIN });
  }
}

/** The motion sensor of a board, with the board's own settings in its settings in ViON. */
export class VionMotionSensor extends MotionSensor {
  private info?: SensorInfo;
  private state?: SensorState;
  private release?: FirmwareRelease;
  private schemaKey = '';

  constructor(
    name: string,
    nativeId: string,
    private readonly actions: SensorActions,
  ) {
    super(name, { nativeId, origin: ORIGIN });
  }

  override get storageSchema(): JsonSchema[] {
    return this.schema();
  }

  /** New readings of the board: the settings show them, and are sent again only when something in them changed. */
  show(info?: SensorInfo, state?: SensorState, release?: FirmwareRelease, force = false): void {
    if (force) this.schemaKey = '';
    if (info) this.info = info;
    if (state) this.state = state;
    if (release) this.release = release;
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

  private status(): string {
    const info = this.info;
    const state = this.state;
    if (!info) return 'Not reachable yet';
    const parts = [`Firmware ${info.firmware}`, info.ip, `signal ${state?.rssi ?? info.rssi} dBm`];
    if (state?.calibrating) parts.push(`calibrating, ${state.calibration_left_s} s left: keep the room empty`);
    else if (state?.blind) parts.push('no packets from the router: the sensor sees nothing');
    else if (state) parts.push(`level ${(state.baseline > 0 ? state.score / state.baseline : 0).toFixed(2)} of ${state.threshold.toFixed(2)}`);
    const presence = state?.presence;
    if (presence?.training) parts.push(`presence: learning the empty room, ${presence.training_left_s} s left`);
    else if (presence && !presence.trained) parts.push(`presence: not learned, the Wi-Fi signal was too uneven (${presence.windows_per_s} readings/s)`);
    else if (presence)
      parts.push(`presence: ${presence.present ? 'someone is here' : 'nobody'} (${presence.level.toFixed(4)} of ${presence.wander_threshold.toFixed(4)})`);
    if (state?.ld2450?.connected) parts.push(`radar: ${state.ld2450.targets.length} of 3 people`);
    return parts.join(' · ');
  }

  private schema(): JsonSchema[] {
    const info = this.info;
    const fields: JsonSchema[] = [
      { type: 'string', key: 'status', title: 'Sensor', description: 'What the board reports now.', readonly: true, defaultValue: this.status() },
      {
        type: 'number',
        key: 'threshold',
        title: 'Sensitivity threshold',
        description: 'How many times the Wi-Fi signal has to change more than in an empty room. Lower is more sensitive and gives more false alarms.',
        minimum: 1.05,
        maximum: 5,
        step: 0.05,
        defaultValue: info?.config.threshold ?? 1.4,
        store: true,
        onSet: async (value) => this.actions.configure({ threshold: Number(value) }),
      },
      {
        type: 'number',
        key: 'holdS',
        title: 'Motion lasts, seconds',
        description: 'How long the sensor stays in motion after the last movement.',
        minimum: 1,
        maximum: 600,
        step: 1,
        defaultValue: info?.config.hold_s ?? 8,
        store: true,
        onSet: async (value) => this.actions.configure({ hold_s: Number(value) }),
      },
      {
        type: 'boolean',
        key: 'camera',
        title: 'Camera',
        description:
          info?.camera.state === 'error'
            ? 'The board found no camera module: the sensor works without it.'
            : 'Turns the camera of the board on: it then appears in Cameras, Found. The board restarts and calibrates again.',
        defaultValue: info?.camera.enabled ?? false,
        store: true,
        onSet: async (value) => this.actions.configure({ camera: Boolean(value) }),
      },
      ...this.presenceFields(),
      {
        type: 'button',
        key: 'recalibrate',
        title: 'Calibrate',
        description: 'The sensor learns the empty room for 30 seconds: leave the room before pressing.',
        onSet: async () => this.actions.recalibrate(),
      },
    ];
    const release = this.release;
    // only a newer one: a board flashed by USB can be ahead of the list, and the update refuses to go back
    if (release && info && newer(release.version, info.firmware)) {
      fields.push({
        type: 'button',
        key: 'update',
        title: `Update the firmware to ${release.version}`,
        description: release.notes ?? 'A new firmware of the sensor is out.',
        onSet: async () => this.actions.update(),
      });
    }
    if (info?.update_failed) {
      fields.push({
        type: 'string',
        key: 'updateFailed',
        title: 'Firmware update',
        description: 'The new firmware did not start, and the board went back to the one it had.',
        readonly: true,
        defaultValue: `${info.update_failed} did not start: the board runs ${info.firmware}`,
      });
    }
    const update = this.state?.update;
    if (update && update.state !== 'idle') {
      fields.push({
        type: 'string',
        key: 'updateStatus',
        title: 'Firmware update',
        description: '',
        readonly: true,
        defaultValue: update.state === 'downloading' ? `${update.progress}%` : update.state === 'failed' ? `Failed: ${update.error ?? ''}` : 'Done, restarting',
      });
    }
    fields.push({
      type: 'button',
      key: 'reset',
      title: 'Reset the sensor',
      description: 'The board forgets the Wi-Fi and this ViON and shows its own network for a new setup.',
      color: 'danger',
      onSet: async () => this.actions.reset(),
    });
    return fields;
  }

  /** The settings of presence, on a board whose firmware has it. */
  private presenceFields(): JsonSchema[] {
    if (!this.state?.presence) return [];
    return [
      {
        type: 'number',
        key: 'presenceSensitivity',
        title: 'Presence sensitivity',
        description: 'How readily a person standing still counts as present (the Espressif algorithm). Higher is more sensitive.',
        minimum: 0,
        maximum: 1,
        step: 0.05,
        defaultValue: this.info?.config.presence_sensitivity ?? this.state.presence.sensitivity,
        store: true,
        onSet: async (value) => this.actions.configure({ presence_sensitivity: Number(value) }),
      },
      {
        type: 'string',
        key: 'motionSource',
        title: 'Motion from',
        description: 'Which algorithm of the board makes motion in ViON. Both run all the time: switch to compare them.',
        defaultValue: this.actions.motionSource(),
        enum: ['vion', 'espressif', 'any'],
        enumLabels: { vion: 'ViON (signal changes)', espressif: 'Espressif (esp-radar)', any: 'Either of them' },
        store: true,
        onSet: async (value) => this.actions.setMotionSource(value as MotionSource),
      },
    ];
  }
}
