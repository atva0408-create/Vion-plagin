import { DoorbellTrigger, LightCapability, LightControl, LightProperty, MotionSensor, Sensor, SwitchControl, SwitchProperty, sensorMeta } from '@camera.ui/sdk';

import type { SensorCategory, SensorType } from '@camera.ui/sdk';
import type { Slot } from './mapping.js';
import type { YDevice } from './yandex/home.js';

export const ORIGIN = 'yandex';
/** A vibration is an event without an end: the sensor shows it this long. */
export const PULSE_MS = 10_000;
/** A scenario switch turns itself off after this. */
export const SCENARIO_RESET_MS = 1_500;

export type CommandFn = (property: string, value: unknown) => Promise<void>;

function options(nativeId: string) {
  return { nativeId, origin: ORIGIN };
}

/** Any binary or measured sensor of the catalog, by the property its type keeps the state in. */
export class YandexStateSensor extends Sensor<Record<string, unknown>> {
  readonly type: SensorType;
  readonly category: SensorCategory;
  private readonly stateProperty: string;

  constructor(type: SensorType, name: string, nativeId: string) {
    super(name, options(nativeId));
    const meta = sensorMeta(type);
    if (!meta?.semantics) throw new Error(`No sensor type ${type}`);
    this.type = meta.type;
    this.category = meta.category;
    this.stateProperty = meta.semantics.stateProperty;
    const initial = meta.properties[this.stateProperty]?.type === 'number' ? 0 : false;
    this._writeState({ [this.stateProperty]: initial });
  }

  write(value: boolean | number): void {
    this._writeState({ [this.stateProperty]: value });
  }

  updateValue(): void {}
}

export class YandexSwitch extends SwitchControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, options(nativeId));
  }

  write(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class YandexLight extends LightControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, options(nativeId));
  }

  write(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  /** The interface shows the brightness slider only to a light with this capability. */
  dimmable(yes: boolean): void {
    // each set goes to the server, and the state of the device is applied at every reading: only a change is sent
    if (this.hasCapability(LightCapability.Brightness) !== yes) this.capabilities = yes ? [LightCapability.Brightness] : [];
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export type RuntimeSensor = YandexStateSensor | MotionSensor | DoorbellTrigger | YandexSwitch | YandexLight;

export interface Bound {
  slot: Slot;
  sensor: RuntimeSensor;
  /** The last value seen and when it changed: a button counts a press only when one of them is new. */
  last?: { value: unknown; updatedAt?: number };
  pulseTimer?: NodeJS.Timeout;
}

export function createSensor(slot: Slot, command: CommandFn): RuntimeSensor {
  const b = slot.binding;
  let sensor: RuntimeSensor;
  if (b.kind === 'onoff' || b.kind === 'scenario') {
    sensor = b.kind === 'onoff' && b.light ? new YandexLight(slot.name, slot.nativeId, command) : new YandexSwitch(slot.name, slot.nativeId, command);
  } else if (b.kind === 'button') {
    sensor = new DoorbellTrigger(slot.name, options(slot.nativeId));
  } else if (b.kind === 'event' && b.instance === 'motion') {
    sensor = new MotionSensor(slot.name, options(slot.nativeId));
  } else {
    sensor = new YandexStateSensor(slot.type, slot.name, slot.nativeId);
  }
  sensor.setAddress(slot.deviceId);
  return sensor;
}

/**
 * The state of the Yandex device on the sensor. `live` says the device was read for a change, not on a start or
 * a new connection: only then is a new value of a button a press.
 */
export function applyDevice(bound: Bound, device: YDevice, live: boolean): void {
  const { binding: b } = bound.slot;
  const sensor = bound.sensor;

  if (b.kind === 'scenario') return;

  if (b.kind === 'onoff') {
    const brightness = b.light ? device.capabilities.find((c) => c.type === 'devices.capabilities.range' && c.instance === 'brightness') : undefined;
    if (b.light) (sensor as YandexLight).dimmable(!!brightness);
    const on = device.capabilities.find((c) => c.type === 'devices.capabilities.on_off')?.value;
    if (typeof on !== 'boolean') return;
    const partial: Record<string, unknown> = { [b.light ? LightProperty.On : SwitchProperty.On]: on };
    if (typeof brightness?.value === 'number') partial[LightProperty.Brightness] = Math.round(brightness.value);
    (sensor as YandexSwitch | YandexLight).write(partial);
    return;
  }

  const property = device.properties.find(
    (p) => p.instance === b.instance && (b.kind === 'float' ? p.type === 'devices.properties.float' : p.type === 'devices.properties.event'),
  );
  if (property?.value === null || property?.value === undefined) return;
  const previous = bound.last;
  bound.last = { value: property.value, updatedAt: property.updatedAt };
  const changed = !!previous && (previous.value !== property.value || (property.updatedAt !== undefined && previous.updatedAt !== property.updatedAt));

  switch (b.kind) {
    case 'float': {
      const value = Number(property.value);
      if (!Number.isNaN(value)) (sensor as YandexStateSensor).write(value);
      return;
    }
    case 'event': {
      const detected = typeof property.value === 'string' && b.detected.includes(property.value);
      if (sensor instanceof MotionSensor) sensor.reportDetections(detected);
      else (sensor as YandexStateSensor).write(detected);
      return;
    }
    case 'button':
      if (live && changed) (sensor as DoorbellTrigger).trigger();
      return;
    case 'pulse':
      if (!live || !changed) return;
      (sensor as YandexStateSensor).write(true);
      clearTimeout(bound.pulseTimer);
      bound.pulseTimer = setTimeout(() => (sensor as YandexStateSensor).write(false), PULSE_MS);
      bound.pulseTimer.unref?.();
      return;
  }
}

/** The command of the Smart Home for a write to a control; nothing for a property it does not know. */
export function commandFor(slot: Slot, property: string, value: unknown): { type: string; state: { instance: string; value: unknown } } | undefined {
  const b = slot.binding;
  if (b.kind !== 'onoff') return undefined;
  if (property === String(SwitchProperty.On) || property === String(LightProperty.On)) {
    return { type: 'devices.capabilities.on_off', state: { instance: 'on', value: !!value } };
  }
  if (b.light && property === String(LightProperty.Brightness) && typeof value === 'number') {
    // the Smart Home has no brightness 0: the slider at its start means off, not the faintest light
    if (Math.round(value) <= 0) return { type: 'devices.capabilities.on_off', state: { instance: 'on', value: false } };
    return { type: 'devices.capabilities.range', state: { instance: 'brightness', value: Math.min(100, Math.round(value)) } };
  }
  return undefined;
}
