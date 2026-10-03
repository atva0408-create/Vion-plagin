// What a device of the Smart Home can do besides on and off, as the settings of its ViON switch or light: the mode,
// temperature and fan of an air conditioner, the volume, channel, input and mute of a TV, the learned buttons of an
// IR remote. ViON has no sensor type for a climate or a media device, so these are the fields of the sensor's own
// settings, and setting one sends the command to Yandex at once.
import type { JsonSchema } from '@camera.ui/sdk';
import type { YCapability, YDevice } from './yandex/home.js';
import type { YAction } from './yandex/iot.js';

export type SendFn = (action: YAction) => Promise<void>;

// Each text is written as a field of a form (title, enumLabels), so the translations of the plugin find it.
const RANGES: Record<string, { title: string; up: { title: string }; down: { title: string } }> = {
  temperature: { title: 'Temperature, °C', up: { title: 'Warmer' }, down: { title: 'Cooler' } },
  volume: { title: 'Volume', up: { title: 'Volume up' }, down: { title: 'Volume down' } },
  channel: { title: 'Channel', up: { title: 'Next channel' }, down: { title: 'Previous channel' } },
  brightness: { title: 'Brightness', up: { title: 'Brighter' }, down: { title: 'Dimmer' } },
  humidity: { title: 'Humidity', up: { title: 'Humidity up' }, down: { title: 'Humidity down' } },
  open: { title: 'Opening, %', up: { title: 'Open more' }, down: { title: 'Close more' } },
};

const MODES: Record<string, { title: string }> = {
  thermostat: { title: 'Mode' },
  fan_speed: { title: 'Fan speed' },
  input_source: { title: 'Input' },
  program: { title: 'Program' },
  swing: { title: 'Swing' },
  work_speed: { title: 'Speed' },
  heat: { title: 'Heating' },
  cleanup_mode: { title: 'Cleaning mode' },
  coffee_mode: { title: 'Coffee' },
  tea_mode: { title: 'Tea' },
  dishwashing: { title: 'Dishwashing' },
};

const TOGGLES: Record<string, { title: string }> = {
  mute: { title: 'Mute' },
  pause: { title: 'Pause' },
  oscillation: { title: 'Oscillation' },
  ionization: { title: 'Ionization' },
  backlight: { title: 'Backlight' },
  keep_warm: { title: 'Keep warm' },
  controls_locked: { title: 'Child lock' },
};

/** Values of modes, as Yandex names them, in words; an unknown value shows as it is. */
const MODE_VALUES = {
  enumLabels: {
    auto: 'Auto',
    cool: 'Cooling',
    heat: 'Heating',
    dry: 'Drying',
    fan_only: 'Fan only',
    eco: 'Eco',
    turbo: 'Turbo',
    quiet: 'Quiet',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    min: 'Minimum',
    max: 'Maximum',
    normal: 'Normal',
    fast: 'Fast',
    slow: 'Slow',
    horizontal: 'Horizontal',
    vertical: 'Vertical',
    stationary: 'Stationary',
    night: 'Night',
  } as Record<string, string>,
};
const MODE_LABELS = MODE_VALUES.enumLabels;
const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const GROUPS = { controls: { group: 'Controls' }, remote: { group: 'Remote buttons' } };

/** A capability the switch or light already is: on/off, and the brightness of a light. */
function isMain(capability: YCapability, light: boolean): boolean {
  return capability.type === 'devices.capabilities.on_off' || (light && capability.type === 'devices.capabilities.range' && capability.instance === 'brightness');
}

/** Whether the device has anything for the extra controls. */
export function hasExtras(device: YDevice, light: boolean): boolean {
  return extraSchema(device, light, async () => {}).length > 0;
}

/**
 * The fields of the extra controls of a device, with its current values. A range Yandex cannot set to a value (an
 * IR remote: no random access, or no state to show) becomes a pair of buttons that step it.
 */
export function extraSchema(device: YDevice, light: boolean, send: SendFn): JsonSchema[] {
  const fields: JsonSchema[] = [];
  const group = GROUPS.controls.group;

  for (const c of device.capabilities) {
    if (isMain(c, light)) continue;

    if (c.type === 'devices.capabilities.range' && c.instance) {
      const names = RANGES[c.instance];
      const title = names?.title ?? c.instance;
      const range = c.parameters.range ?? {};
      const step = Number(range.precision) || 1;
      const stepOnly = c.parameters.random_access === false || (c.retrievable === false && typeof c.value !== 'number');
      if (stepOnly) {
        fields.push(
          {
            type: 'button',
            key: `${c.instance}_up`,
            title: names?.up.title ?? `${title} +`,
            description: '',
            group,
            onSet: async () => send({ type: c.type, state: { instance: c.instance, value: step, relative: true } }),
          },
          {
            type: 'button',
            key: `${c.instance}_down`,
            title: names?.down.title ?? `${title} −`,
            description: '',
            group,
            onSet: async () => send({ type: c.type, state: { instance: c.instance, value: -step, relative: true } }),
          },
        );
      } else {
        fields.push({
          type: 'number',
          key: c.instance,
          title,
          description: '',
          group,
          minimum: typeof range.min === 'number' ? range.min : undefined,
          maximum: typeof range.max === 'number' ? range.max : undefined,
          step,
          defaultValue: typeof c.value === 'number' ? c.value : undefined,
          onSet: async (value: unknown) => {
            if (typeof value === 'number' && Number.isFinite(value)) await send({ type: c.type, state: { instance: c.instance, value } });
          },
        });
      }
      continue;
    }

    if (c.type === 'devices.capabilities.mode' && c.instance) {
      const modes: string[] = (c.parameters.modes ?? []).map((m: { value?: unknown }) => String(m.value)).filter(Boolean);
      if (!modes.length) continue;
      fields.push({
        type: 'string',
        key: c.instance,
        title: MODES[c.instance]?.title ?? c.instance,
        description: '',
        group,
        enum: modes,
        enumLabels: Object.fromEntries(modes.map((m) => [m, MODE_LABELS[m] ?? (NUMBERS.includes(m) ? String(NUMBERS.indexOf(m) + 1) : m)])),
        defaultValue: typeof c.value === 'string' ? c.value : undefined,
        onSet: async (value: unknown) => {
          if (typeof value === 'string' && modes.includes(value)) await send({ type: c.type, state: { instance: c.instance, value } });
        },
      });
      continue;
    }

    if (c.type === 'devices.capabilities.toggle' && c.instance) {
      fields.push({
        type: 'boolean',
        key: c.instance,
        title: TOGGLES[c.instance]?.title ?? c.instance,
        description: '',
        group,
        defaultValue: typeof c.value === 'boolean' ? c.value : false,
        onSet: async (value: unknown) => send({ type: c.type, state: { instance: c.instance, value: !!value } }),
      });
      continue;
    }

    // the learned buttons of an IR remote: each sends its code
    if (c.type === 'devices.capabilities.custom.button' && c.instance) {
      const names: unknown = c.parameters.instance_names;
      const name = Array.isArray(names) && typeof names[0] === 'string' ? names[0] : `Button ${c.instance}`;
      fields.push({
        type: 'button',
        key: `button_${c.instance}`,
        title: name,
        description: '',
        group: GROUPS.remote.group,
        onSet: async () => send({ type: c.type, state: { instance: c.instance, value: true } }),
      });
    }
  }
  return fields;
}

/** A fingerprint of the fields without their callbacks: the settings are replaced only when it changes. */
export function schemaKey(fields: JsonSchema[]): string {
  return JSON.stringify(fields, (_key, value: unknown) => (typeof value === 'function' ? undefined : value));
}
