import {
  GarageControl,
  GarageProperty,
  GarageState,
  LightControl,
  LightProperty,
  LockControl,
  LockProperty,
  LockState,
  SecuritySystem,
  SecuritySystemProperty,
  SecuritySystemState,
  SirenControl,
  SirenProperty,
  SwitchControl,
  SwitchProperty,
} from '@camera.ui/sdk';

import { importOptions } from './types.js';

import type { HaState } from './types.js';

export type ControlKind = 'lock' | 'garage' | 'securitySystem' | 'switch' | 'light' | 'siren';

/**
 * Carries the command out in Home Assistant and gives the value as the control keeps it («locked» from the assistant
 * is kept as LockState.Secured). Throws when it was not done; the value is written only after, so a refused command
 * does not stand on the page as done.
 */
export type CommandFn = (property: string, value: unknown) => Promise<unknown>;

export interface ServiceCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  /** The value as the control keeps it. */
  value: unknown;
}

export class HaLockControl extends LockControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export class HaGarageControl extends GarageControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export class HaSecuritySystem extends SecuritySystem {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export class HaSwitchControl extends SwitchControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export class HaLightControl extends LightControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export class HaSirenControl extends SirenControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: await this.command(property, value) });
  }
}

export type HaControl = HaLockControl | HaGarageControl | HaSecuritySystem | HaSwitchControl | HaLightControl | HaSirenControl;

export function controlKindForEntity(state: HaState): ControlKind | undefined {
  const domain = state.entity_id.split('.')[0];
  const deviceClass = state.attributes.device_class ?? '';

  if (domain === 'lock') return 'lock';
  if (domain === 'cover' && ['garage', 'garage_door', 'gate'].includes(deviceClass)) return 'garage';
  if (domain === 'alarm_control_panel') return 'securitySystem';
  if (domain === 'switch' || domain === 'input_boolean') return 'switch';
  if (domain === 'light') return 'light';
  if (domain === 'siren') return 'siren';
  return undefined;
}

export function applyControlState(kind: ControlKind, control: HaControl, state: HaState): void {
  switch (kind) {
    case 'lock': {
      const locked = state.state === 'locked' || state.state === 'locking';
      const current = state.state === 'jammed' ? LockState.Unknown : locked ? LockState.Secured : LockState.Unsecured;
      control.writeStates({ [LockProperty.CurrentState]: current, [LockProperty.TargetState]: current === LockState.Unknown ? LockState.Unsecured : current });
      break;
    }
    case 'garage': {
      const current =
        state.state === 'open'
          ? GarageState.Open
          : state.state === 'opening'
            ? GarageState.Opening
            : state.state === 'closing'
              ? GarageState.Closing
              : GarageState.Closed;
      const target = current === GarageState.Open || current === GarageState.Opening ? GarageState.Open : GarageState.Closed;
      control.writeStates({ [GarageProperty.CurrentState]: current, [GarageProperty.TargetState]: target });
      break;
    }
    case 'securitySystem': {
      const map: Record<string, SecuritySystemState> = {
        armed_home: SecuritySystemState.StayArm,
        armed_away: SecuritySystemState.AwayArm,
        armed_night: SecuritySystemState.NightArm,
        armed_vacation: SecuritySystemState.AwayArm,
        disarmed: SecuritySystemState.Disarmed,
        triggered: SecuritySystemState.AlarmTriggered,
      };
      const current = map[state.state];
      if (current === undefined) return;
      const target = current === SecuritySystemState.AlarmTriggered ? SecuritySystemState.Disarmed : current;
      control.writeStates({ [SecuritySystemProperty.CurrentState]: current, [SecuritySystemProperty.TargetState]: target });
      break;
    }
    case 'switch': {
      control.writeStates({ [SwitchProperty.On]: state.state === 'on' });
      break;
    }
    case 'light': {
      const on = state.state === 'on';
      const brightness = state.attributes.brightness;
      const partial: Record<string, unknown> = { [LightProperty.On]: on };
      if (typeof brightness === 'number') {
        partial[LightProperty.Brightness] = Math.round((brightness / 255) * 100);
      }
      control.writeStates(partial);
      break;
    }
    case 'siren': {
      control.writeStates({ [SirenProperty.Active]: state.state === 'on' });
      break;
    }
  }
}

const LOCK_TARGET: string = LockProperty.TargetState;
const GARAGE_TARGET: string = GarageProperty.TargetState;
const SECURITY_TARGET: string = SecuritySystemProperty.TargetState;
const SWITCH_ON: string = SwitchProperty.On;
const LIGHT_ON: string = LightProperty.On;
const LIGHT_BRIGHTNESS: string = LightProperty.Brightness;
const SIREN_ACTIVE: string = SirenProperty.Active;

/**
 * A target state comes as the number of the SDK's enum (VION's page, HomeKit, MQTT, automations) or as a name: the
 * assistant reads the names of the sensor's semantics in list_sensors («locked», «armed_away») and passes them as they
 * are. `value === LockState.Secured ? 'lock' : 'unlock'` unlocked the door asked to be «locked». Anything that is not
 * one of these is refused, a boolean too: true does not say whether a door is to be locked or opened.
 */
const LOCK_SERVICES: Record<number, string> = { [LockState.Secured]: 'lock', [LockState.Unsecured]: 'unlock' };
const LOCK_NAMES: Record<string, LockState> = {
  locked: LockState.Secured,
  lock: LockState.Secured,
  secured: LockState.Secured,
  unlocked: LockState.Unsecured,
  unlock: LockState.Unsecured,
  unsecured: LockState.Unsecured,
};
const GARAGE_SERVICES: Record<number, string> = { [GarageState.Open]: 'open_cover', [GarageState.Closed]: 'close_cover' };
const GARAGE_NAMES: Record<string, GarageState> = { open: GarageState.Open, closed: GarageState.Closed, close: GarageState.Closed };
const SECURITY_SERVICES: Record<number, string> = {
  [SecuritySystemState.StayArm]: 'alarm_arm_home',
  [SecuritySystemState.AwayArm]: 'alarm_arm_away',
  [SecuritySystemState.NightArm]: 'alarm_arm_night',
  [SecuritySystemState.Disarmed]: 'alarm_disarm',
};
// the names of the semantics (armed_home), of the SDK's property values (stay_arm) and of the services (arm_home)
const SECURITY_NAMES: Record<string, SecuritySystemState> = {
  armed_home: SecuritySystemState.StayArm,
  stay_arm: SecuritySystemState.StayArm,
  arm_home: SecuritySystemState.StayArm,
  armed_away: SecuritySystemState.AwayArm,
  away_arm: SecuritySystemState.AwayArm,
  arm_away: SecuritySystemState.AwayArm,
  armed_night: SecuritySystemState.NightArm,
  night_arm: SecuritySystemState.NightArm,
  arm_night: SecuritySystemState.NightArm,
  disarmed: SecuritySystemState.Disarmed,
  disarm: SecuritySystemState.Disarmed,
};

/** The state by its number or its name, undefined for anything else; own keys only («constructor» is not a state). */
function targetOf(value: unknown, services: Record<number, string>, names: Record<string, number>): number | undefined {
  if (typeof value === 'number') return Object.hasOwn(services, value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return Object.hasOwn(names, name) ? names[name] : undefined;
}

/**
 * On or off: a boolean, 1 or 0 (an automation's "1"), or the words the assistant reads, on and off. `value ? 'turn_on'`
 * turned a siren on for «off».
 */
function onOff(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  return word === 'on' || word === 'true' ? true : word === 'off' || word === 'false' ? false : undefined;
}

function refused(value: unknown, what: string, accepted: string): Error {
  const shown = typeof value === 'string' ? `"${value}"` : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return new Error(`${shown} is not a state of ${what}: ${accepted}`);
}

function switching(domain: string, entityId: string, value: unknown): ServiceCall {
  const on = onOff(value);
  if (on === undefined) throw refused(value, entityId, 'on or off');
  return { domain, service: on ? 'turn_on' : 'turn_off', data: { entity_id: entityId }, value: on };
}

/** The service a command calls; undefined for a property Home Assistant is not told. Throws on a value it cannot carry out. */
export function commandToService(kind: ControlKind, entityId: string, property: string, value: unknown): ServiceCall | undefined {
  const data = { entity_id: entityId };

  switch (kind) {
    case 'lock': {
      if (property !== LOCK_TARGET) return undefined;
      const target = targetOf(value, LOCK_SERVICES, LOCK_NAMES);
      if (target === undefined) throw refused(value, `the lock ${entityId}`, 'locked or unlocked (LockState 0 or 1)');
      return { domain: 'lock', service: LOCK_SERVICES[target], data, value: target };
    }
    case 'garage': {
      if (property !== GARAGE_TARGET) return undefined;
      const target = targetOf(value, GARAGE_SERVICES, GARAGE_NAMES);
      if (target === undefined) throw refused(value, `the garage door ${entityId}`, 'open or closed (GarageState 0 or 1)');
      return { domain: 'cover', service: GARAGE_SERVICES[target], data, value: target };
    }
    case 'securitySystem': {
      if (property !== SECURITY_TARGET) return undefined;
      const target = targetOf(value, SECURITY_SERVICES, SECURITY_NAMES);
      if (target === undefined) {
        throw refused(value, `the alarm panel ${entityId}`, 'armed_home, armed_away, armed_night or disarmed (SecuritySystemState 0 to 3)');
      }
      return { domain: 'alarm_control_panel', service: SECURITY_SERVICES[target], data, value: target };
    }
    case 'switch':
      if (property !== SWITCH_ON) return undefined;
      // homeassistant.turn_on covers switch and input_boolean alike
      return switching('homeassistant', entityId, value);
    case 'light':
      if (property === LIGHT_BRIGHTNESS) {
        return { domain: 'light', service: 'turn_on', data: { ...data, brightness_pct: value }, value };
      }
      if (property === LIGHT_ON) return switching('light', entityId, value);
      return undefined;
    case 'siren':
      if (property !== SIREN_ACTIVE) return undefined;
      return switching('siren', entityId, value);
  }
}

export function createControl(kind: ControlKind, name: string, nativeId: string, command: CommandFn): HaControl {
  switch (kind) {
    case 'lock':
      return new HaLockControl(name, nativeId, command);
    case 'garage':
      return new HaGarageControl(name, nativeId, command);
    case 'securitySystem':
      return new HaSecuritySystem(name, nativeId, command);
    case 'switch':
      return new HaSwitchControl(name, nativeId, command);
    case 'light':
      return new HaLightControl(name, nativeId, command);
    case 'siren':
      return new HaSirenControl(name, nativeId, command);
  }
}
