// Which ViON sensors a device of the Yandex Smart Home becomes. One device can be several: a climate sensor gives
// the temperature and the humidity, a motion sensor often the light level too.
import { SensorType } from '@camera.ui/sdk';

import { hasExtras } from './extras.js';
import { isCamera, isStation } from './yandex/home.js';

import type { YDevice, YScenario } from './yandex/home.js';

export type Binding =
  | { kind: 'event'; instance: string; detected: string[] }
  | { kind: 'pulse'; instance: string }
  | { kind: 'button'; instance: string }
  | { kind: 'float'; instance: string }
  | { kind: 'onoff'; light: boolean }
  /** A device without on/off whose controls are all extras (an IR remote of learned buttons, a curtain): a switch that holds them. */
  | { kind: 'panel' }
  | { kind: 'scenario'; scenarioId: string };

export interface Slot {
  /** Stable id of the sensor: the id of the Yandex device and what of it the sensor shows. */
  nativeId: string;
  deviceId: string;
  name: string;
  type: SensorType;
  room?: string;
  binding: Binding;
}

const SEP = '|';
export const SCENARIO_DEVICE = 'scenario';

/** Events of the Smart Home that are a state, with the values that mean "detected" (or "open"). */
const EVENTS: Record<string, { type: SensorType; detected: string[] }> = {
  motion: { type: SensorType.Motion, detected: ['detected'] },
  open: { type: SensorType.Contact, detected: ['opened'] },
  water_leak: { type: SensorType.Leak, detected: ['leak'] },
  smoke: { type: SensorType.Smoke, detected: ['detected', 'high'] },
  gas: { type: SensorType.Gas, detected: ['detected', 'high'] },
};

const FLOATS: Record<string, SensorType> = {
  temperature: SensorType.Temperature,
  humidity: SensorType.Humidity,
  illumination: SensorType.Illuminance,
  co2_level: SensorType.CarbonDioxide,
};

/**
 * What a sensor of a device with several shows, after the name of the device. In English, as the other plugins name
 * what they make: a plugin is not told the language of the interface, and the user renames a sensor in ViON.
 */
const SUFFIX: Record<string, string> = {
  motion: 'Motion',
  open: 'Opening',
  water_leak: 'Leak',
  smoke: 'Smoke',
  gas: 'Gas',
  vibration: 'Vibration',
  button: 'Button',
  temperature: 'Temperature',
  humidity: 'Humidity',
  illumination: 'Light level',
  co2_level: 'CO₂',
  on: 'Power',
  panel: 'Controls',
};

export function nativeIdOf(deviceId: string, key: string): string {
  return `${deviceId}${SEP}${key}`;
}

export function splitNativeId(nativeId: string): { deviceId: string; key: string } {
  const i = nativeId.lastIndexOf(SEP);
  return i < 0 ? { deviceId: nativeId, key: '' } : { deviceId: nativeId.slice(0, i), key: nativeId.slice(i + 1) };
}

export function slotsOf(device: YDevice): Slot[] {
  // stations speak and cameras are cameras: neither is a sensor
  if (isStation(device) || isCamera(device)) return [];

  const parts: { key: string; type: SensorType; binding: Binding }[] = [];
  for (const property of device.properties) {
    const instance = property.instance;
    if (property.type === 'devices.properties.event') {
      const event = EVENTS[instance];
      if (event) parts.push({ key: instance, type: event.type, binding: { kind: 'event', instance, detected: event.detected } });
      else if (instance === 'vibration') parts.push({ key: instance, type: SensorType.Vibration, binding: { kind: 'pulse', instance } });
      else if (instance === 'button') parts.push({ key: instance, type: SensorType.Doorbell, binding: { kind: 'button', instance } });
    } else if (property.type === 'devices.properties.float') {
      const type = FLOATS[instance];
      if (type) parts.push({ key: instance, type, binding: { kind: 'float', instance } });
    }
  }
  if (device.capabilities.some((c) => c.type === 'devices.capabilities.on_off')) {
    const light = device.type.startsWith('devices.types.light');
    parts.push({ key: 'on', type: light ? SensorType.Light : SensorType.Switch, binding: { kind: 'onoff', light } });
  } else if (hasExtras(device, false)) {
    parts.push({ key: 'panel', type: SensorType.Switch, binding: { kind: 'panel' } });
  }

  const several = parts.length > 1;
  return parts.map((part) => ({
    nativeId: nativeIdOf(device.id, part.key),
    deviceId: device.id,
    name: several ? `${device.name}: ${SUFFIX[part.key] ?? part.key}` : device.name,
    type: part.type,
    room: device.room,
    binding: part.binding,
  }));
}

/** A scenario of the account as a switch: turning it on runs the scenario, then it turns off by itself. */
export function scenarioSlot(scenario: YScenario): Slot {
  return {
    nativeId: nativeIdOf(SCENARIO_DEVICE, scenario.id),
    deviceId: SCENARIO_DEVICE,
    name: `Scenario: ${scenario.name}`,
    type: SensorType.Switch,
    binding: { kind: 'scenario', scenarioId: scenario.id },
  };
}

/** The slot of an adopted sensor from its id and type, when its device is not read yet. */
export function slotFromRecord(nativeId: string, name: string, type: SensorType): Slot | undefined {
  const { deviceId, key } = splitNativeId(nativeId);
  if (!key) return undefined;
  if (deviceId === SCENARIO_DEVICE) return { nativeId, deviceId, name, type, binding: { kind: 'scenario', scenarioId: key } };
  const event = EVENTS[key];
  let binding: Binding | undefined;
  if (event) binding = { kind: 'event', instance: key, detected: event.detected };
  else if (key === 'vibration') binding = { kind: 'pulse', instance: key };
  else if (key === 'button') binding = { kind: 'button', instance: key };
  else if (FLOATS[key]) binding = { kind: 'float', instance: key };
  else if (key === 'on') binding = { kind: 'onoff', light: type === SensorType.Light };
  else if (key === 'panel') binding = { kind: 'panel' };
  return binding ? { nativeId, deviceId, name, type, binding } : undefined;
}
