// What an air conditioner, a TV on an IR remote and a remote of learned buttons can do in ViON besides on and off:
// the fields of their settings, the commands the fields send, and the settings replaced only when they change.
// Run: npx tsx spec/extras.spec.ts
import assert from 'node:assert/strict';

import { SensorType } from '@camera.ui/sdk';

import { extraSchema, hasExtras, schemaKey } from '../src/extras.js';
import { slotFromRecord, slotsOf } from '../src/mapping.js';
import { YandexSwitch, applyDevice, createSensor } from '../src/sensors.js';
import { parseUserInfo } from '../src/yandex/home.js';

import type { YAction } from '../src/yandex/iot.js';

const ac = {
  id: 'ac-1',
  name: 'Кондиционер',
  type: 'devices.types.thermostat.ac',
  capabilities: [
    { type: 'devices.capabilities.on_off', retrievable: true, parameters: {}, state: { instance: 'on', value: true } },
    {
      type: 'devices.capabilities.range',
      retrievable: true,
      parameters: { instance: 'temperature', unit: 'unit.temperature.celsius', random_access: true, range: { min: 16, max: 30, precision: 1 } },
      state: { instance: 'temperature', value: 22 },
    },
    {
      type: 'devices.capabilities.mode',
      retrievable: true,
      parameters: { instance: 'thermostat', modes: [{ value: 'cool' }, { value: 'heat' }, { value: 'auto' }] },
      state: { instance: 'thermostat', value: 'cool' },
    },
    {
      type: 'devices.capabilities.mode',
      retrievable: true,
      parameters: { instance: 'fan_speed', modes: [{ value: 'low' }, { value: 'high' }] },
      state: { instance: 'fan_speed', value: 'low' },
    },
  ],
  properties: [],
};

// a TV learned on the IR transmitter of a station: Yandex only sends, nothing is read back
const tv = {
  id: 'tv-1',
  name: 'Телевизор',
  type: 'devices.types.media_device.tv',
  capabilities: [
    { type: 'devices.capabilities.on_off', retrievable: false, parameters: { split: true }, state: null },
    { type: 'devices.capabilities.range', retrievable: false, parameters: { instance: 'volume', random_access: false, range: { min: 0, max: 100, precision: 1 } }, state: null },
    { type: 'devices.capabilities.range', retrievable: false, parameters: { instance: 'channel', random_access: true, range: { min: 0, max: 999, precision: 1 } }, state: null },
    { type: 'devices.capabilities.toggle', retrievable: false, parameters: { instance: 'mute' }, state: null },
    { type: 'devices.capabilities.mode', retrievable: false, parameters: { instance: 'input_source', modes: [{ value: 'one' }, { value: 'two' }] }, state: null },
    { type: 'devices.capabilities.custom.button', retrievable: false, parameters: { instance: '42', instance_names: ['Netflix'] }, state: null },
  ],
  properties: [],
};

const remote = {
  id: 'remote-1',
  name: 'Пульт люстры',
  type: 'devices.types.other',
  capabilities: [{ type: 'devices.capabilities.custom.button', retrievable: false, parameters: { instance: '7', instance_names: ['Ночник'] }, state: null }],
  properties: [],
};

const lamp = {
  id: 'lamp-1',
  name: 'Лампа',
  type: 'devices.types.light',
  capabilities: [
    { type: 'devices.capabilities.on_off', retrievable: true, parameters: {}, state: { instance: 'on', value: true } },
    { type: 'devices.capabilities.range', retrievable: true, parameters: { instance: 'brightness', range: { min: 1, max: 100, precision: 1 } }, state: { instance: 'brightness', value: 40 } },
  ],
  properties: [],
};

const [acDevice, tvDevice, remoteDevice, lampDevice] = parseUserInfo({ devices: [ac, tv, remote, lamp] }).devices as [any, any, any, any];

async function main(): Promise<void> {
  const sent: YAction[] = [];
  const send = async (action: YAction) => void sent.push(action);
  const field = (fields: any[], key: string) => fields.find((f) => f.key === key);

  // ---- an air conditioner: temperature as a number, the mode and the fan as choices, with their current values
  const acFields = extraSchema(acDevice, false, send) as any[];
  assert.deepEqual(
    acFields.map((f) => f.key),
    ['temperature', 'thermostat', 'fan_speed'],
    'on/off is the switch itself',
  );
  const temperature = field(acFields, 'temperature');
  assert.equal(temperature.type, 'number');
  assert.equal(temperature.title, 'Temperature, °C');
  assert.deepEqual([temperature.minimum, temperature.maximum, temperature.step, temperature.defaultValue], [16, 30, 1, 22]);
  const mode = field(acFields, 'thermostat');
  assert.deepEqual(mode.enum, ['cool', 'heat', 'auto']);
  assert.deepEqual(mode.enumLabels, { cool: 'Cooling', heat: 'Heating', auto: 'Auto' });
  assert.equal(mode.defaultValue, 'cool');
  await temperature.onSet(24);
  await mode.onSet('heat');
  await mode.onSet('nonsense');
  await field(acFields, 'fan_speed').onSet('high');
  assert.deepEqual(sent, [
    { type: 'devices.capabilities.range', state: { instance: 'temperature', value: 24 } },
    { type: 'devices.capabilities.mode', state: { instance: 'thermostat', value: 'heat' } },
    { type: 'devices.capabilities.mode', state: { instance: 'fan_speed', value: 'high' } },
  ]);

  // ---- a TV on an IR remote: what cannot be set to a value is stepped, learned buttons press
  sent.length = 0;
  const tvFields = extraSchema(tvDevice, false, send) as any[];
  assert.deepEqual(
    tvFields.map((f) => [f.key, f.type]),
    [
      ['volume_up', 'button'],
      ['volume_down', 'button'],
      ['channel_up', 'button'],
      ['channel_down', 'button'],
      ['mute', 'boolean'],
      ['input_source', 'string'],
      ['button_42', 'button'],
    ],
  );
  assert.equal(field(tvFields, 'button_42').title, 'Netflix');
  assert.equal(field(tvFields, 'button_42').group, 'Remote buttons');
  await field(tvFields, 'volume_up').onSet();
  await field(tvFields, 'channel_down').onSet();
  await field(tvFields, 'mute').onSet(true);
  await field(tvFields, 'button_42').onSet();
  assert.deepEqual(sent, [
    { type: 'devices.capabilities.range', state: { instance: 'volume', value: 1, relative: true } },
    { type: 'devices.capabilities.range', state: { instance: 'channel', value: -1, relative: true } },
    { type: 'devices.capabilities.toggle', state: { instance: 'mute', value: true } },
    { type: 'devices.capabilities.custom.button', state: { instance: '42', value: true } },
  ]);

  // ---- a light: its brightness is the light's own slider, no extras
  assert.equal(hasExtras(lampDevice, true), false);
  assert.equal(slotsOf(lampDevice)[0]!.type, SensorType.Light);

  // ---- a remote of learned buttons only: a switch that holds them
  const remoteSlots = slotsOf(remoteDevice);
  assert.deepEqual(
    remoteSlots.map((s) => [s.nativeId, s.type, s.binding.kind]),
    [['remote-1|panel', SensorType.Switch, 'panel']],
  );
  assert.deepEqual(slotFromRecord('remote-1|panel', 'Пульт', SensorType.Switch)?.binding, { kind: 'panel' });
  assert.deepEqual(
    slotsOf(acDevice).map((s) => s.nativeId),
    ['ac-1|on'],
  );

  // ---- the sensor: its settings are the extras, replaced only when they change
  const defined: unknown[][] = [];
  const slot = slotsOf(acDevice)[0]!;
  const sensor = createSensor(slot, async () => {}) as YandexSwitch;
  sensor.setExtras(extraSchema(acDevice, false, send));
  assert.deepEqual(
    sensor.storageSchema.map((f) => f.key),
    ['temperature', 'thermostat', 'fan_speed'],
    'before registration the host reads them from storageSchema',
  );
  (sensor as any)._setStorage({ defineSchemas: (fields: unknown[]) => defined.push(fields) });
  sensor.setExtras(extraSchema(acDevice, false, send));
  assert.equal(defined.length, 0, 'the same fields are not sent again');
  const warmer = parseUserInfo({ devices: [{ ...ac, capabilities: ac.capabilities.map((c) => (c.parameters.instance === 'temperature' ? { ...c, state: { instance: 'temperature', value: 25 } } : c)) }] }).devices[0]!;
  sensor.setExtras(extraSchema(warmer, false, send));
  assert.equal(defined.length, 1, 'a new current value replaces them');
  assert.equal((defined[0] as any[]).find((f) => f.key === 'temperature').defaultValue, 25);
  assert.notEqual(schemaKey(extraSchema(acDevice, false, send)), schemaKey(extraSchema(warmer, false, send)));

  // a panel keeps no state of its own
  const panel = { slot: remoteSlots[0]!, sensor: createSensor(remoteSlots[0]!, async () => {}) };
  applyDevice(panel, remoteDevice, true);
  assert.equal(panel.sensor.getValue('on'), false);

  console.log('extras.spec: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
