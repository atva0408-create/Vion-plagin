// A command to an adopted lock, garage door, alarm panel, switch, light or siren of Home Assistant. The value comes
// as the number of the SDK's enum or as the name the assistant reads in list_sensors («locked»); anything else is
// refused, not carried out as something else (`value === LockState.Secured ? 'lock' : 'unlock'` unlocked the door
// asked to be «locked», `value ? 'turn_on'` turned a siren on for «off»). A command not carried out — refused, Home
// Assistant down or saying no — is thrown to the caller and not written to the control as done.
// Run: npx tsx spec/controls.spec.ts
import assert from 'node:assert/strict';

import { GarageProperty, LightProperty, LockProperty, LockState, SecuritySystemProperty, SensorType, SirenProperty, SwitchProperty } from '@camera.ui/sdk';

import { commandToService } from '../src/controls.js';
import HomeAssistant from '../src/index.js';

import type { ControlKind } from '../src/controls.js';

const call = (kind: ControlKind, entityId: string, property: string, value: unknown) => {
  const found = commandToService(kind, entityId, property, value);
  return found && `${found.domain}.${found.service} ${JSON.stringify(found.value)}`;
};
const refusals = (kind: ControlKind, entityId: string, property: string, values: unknown[], text: RegExp) => {
  for (const value of values) assert.throws(() => commandToService(kind, entityId, property, value), text, `${kind} ${JSON.stringify(value)}`);
};
const NOT_STATES = [true, false, '', 'yes', 'constructor', 'toString', null, undefined, {}, Number.NaN];

// a lock: the numbers of LockState and the names, kept as the number; Unknown, a boolean or another word is refused
{
  const lock = (value: unknown) => call('lock', 'lock.front_door', LockProperty.TargetState, value);
  assert.equal(lock(LockState.Secured), 'lock.lock 0');
  assert.equal(lock(LockState.Unsecured), 'lock.unlock 1');
  for (const name of ['locked', ' Locked ', 'lock', 'secured']) assert.equal(lock(name), 'lock.lock 0', name);
  for (const name of ['unlocked', 'unlock', 'unsecured']) assert.equal(lock(name), 'lock.unlock 1', name);
  refusals('lock', 'lock.front_door', LockProperty.TargetState, [LockState.Unknown, 3, -1, 'open', 'jammed', ...NOT_STATES], /not a state of the lock lock\.front_door/);
  assert.equal(call('lock', 'lock.front_door', LockProperty.CurrentState, LockState.Secured), undefined, 'the current state is not a command');
}

// a garage door: open and closed; a moving or stopped state is no target
{
  const garage = (value: unknown) => call('garage', 'cover.garage', GarageProperty.TargetState, value);
  assert.equal(garage(0), 'cover.open_cover 0');
  assert.equal(garage(1), 'cover.close_cover 1');
  assert.equal(garage('open'), 'cover.open_cover 0');
  assert.equal(garage('closed'), 'cover.close_cover 1');
  assert.equal(garage('close'), 'cover.close_cover 1');
  refusals(
    'garage',
    'cover.garage',
    GarageProperty.TargetState,
    [2, 3, 4, 'opening', 'closing', 'stopped', ...NOT_STATES],
    /not a state of the garage door cover\.garage/,
  );
}

// an alarm panel: the four modes by number, by the names of the semantics, of the SDK and of the services
{
  const alarm = (value: unknown) => call('securitySystem', 'alarm_control_panel.home', SecuritySystemProperty.TargetState, value);
  assert.equal(alarm(0), 'alarm_control_panel.alarm_arm_home 0');
  assert.equal(alarm(1), 'alarm_control_panel.alarm_arm_away 1');
  assert.equal(alarm(2), 'alarm_control_panel.alarm_arm_night 2');
  assert.equal(alarm(3), 'alarm_control_panel.alarm_disarm 3');
  for (const name of ['armed_home', 'stay_arm', 'arm_home']) assert.equal(alarm(name), 'alarm_control_panel.alarm_arm_home 0', name);
  for (const name of ['armed_away', 'away_arm', 'arm_away']) assert.equal(alarm(name), 'alarm_control_panel.alarm_arm_away 1', name);
  for (const name of ['armed_night', 'night_arm', 'arm_night']) assert.equal(alarm(name), 'alarm_control_panel.alarm_arm_night 2', name);
  for (const name of ['disarmed', 'DISARM']) assert.equal(alarm(name), 'alarm_control_panel.alarm_disarm 3', name);
  refusals(
    'securitySystem',
    'alarm_control_panel.home',
    SecuritySystemProperty.TargetState,
    [4, 'triggered', 'armed', 'armed_vacation', ...NOT_STATES],
    /not a state of the alarm panel alarm_control_panel\.home/,
  );
}

// a switch, a light, a siren: on and off as a boolean, 1 or 0, or the words; «off» is off
{
  for (const [kind, entityId, property, domain] of [
    ['switch', 'switch.pump', SwitchProperty.On, 'homeassistant'],
    ['light', 'light.kitchen', LightProperty.On, 'light'],
    ['siren', 'siren.yard', SirenProperty.Active, 'siren'],
  ] as const) {
    for (const value of [true, 1, 'on', 'ON', 'true']) assert.equal(call(kind, entityId, property, value), `${domain}.turn_on true`, `${kind} ${value}`);
    for (const value of [false, 0, 'off', ' Off', 'false']) assert.equal(call(kind, entityId, property, value), `${domain}.turn_off false`, `${kind} ${value}`);
    refusals(kind, entityId, property, [2, -1, '', 'yes', 'loud', null, undefined, {}], new RegExp(`not a state of ${entityId.replace('.', '\\.')}`));
  }
  assert.equal(call('light', 'light.kitchen', LightProperty.Brightness, 40), 'light.turn_on 40');
  assert.deepEqual(commandToService('light', 'light.kitchen', LightProperty.Brightness, 40)?.data, { entity_id: 'light.kitchen', brightness_pct: 40 });
  assert.equal(call('siren', 'siren.yard', SirenProperty.Volume, 50), undefined, 'the volume is not sent');
}

// through the plugin: the command reaches Home Assistant and the control keeps the number; a command not carried
// out is thrown and leaves the control as it was
{
  const services: string[] = [];
  let failing: Error | undefined;
  const logger = { log() {}, debug() {}, warn() {}, error() {}, trace() {} };
  const storage = { values: {} as Record<string, unknown>, save: async () => undefined };
  const plugin = new HomeAssistant(logger as never, { on() {} } as never, storage as never);
  const sensor = (await plugin.onSensorAdopted({ type: SensorType.Lock, name: 'Входная дверь', nativeId: 'entry-1', address: 'lock.front_door' } as never)) as any;
  const target = () => sensor.getValue(LockProperty.TargetState);
  const host = plugin as any;

  await assert.rejects(sensor.updateValue(LockProperty.TargetState, 'locked'), /not found in Home Assistant/, 'an entity not resolved yet');
  host.attach(host.bound.get('entry-1'), 'lock.front_door');
  await assert.rejects(sensor.updateValue(LockProperty.TargetState, 'locked'), /not connected/);
  host.client = {
    callService: async (domain: string, service: string, data: Record<string, unknown>) => {
      if (failing) throw failing;
      services.push(`${domain}.${service} ${String(data.entity_id)}`);
    },
  };

  await sensor.updateValue(LockProperty.TargetState, LockState.Unsecured);
  await sensor.updateValue(LockProperty.TargetState, 'locked');
  assert.deepEqual(services.splice(0), ['lock.unlock lock.front_door', 'lock.lock lock.front_door']);
  assert.equal(target(), LockState.Secured, 'kept as the number, not the name');

  await assert.rejects(sensor.updateValue(LockProperty.TargetState, 'open sesame'), /"open sesame" is not a state of the lock/);
  await assert.rejects(sensor.updateValue(LockProperty.TargetState, true), /true is not a state of the lock/);
  assert.deepEqual(services, [], 'nothing called');
  assert.equal(target(), LockState.Secured, 'a refused value is not written');

  failing = new Error('Home Assistant answered 500');
  await assert.rejects(sensor.updateValue(LockProperty.TargetState, 'unlocked'), /answered 500/);
  assert.equal(target(), LockState.Secured, 'a command Home Assistant did not take is not written as done');
  failing = undefined;

  await assert.rejects(sensor.updateValue(LockProperty.CurrentState, LockState.Unsecured), /is not sent to Home Assistant/);
  assert.deepEqual(services, []);
}

console.log('homeassistant controls: ok');
