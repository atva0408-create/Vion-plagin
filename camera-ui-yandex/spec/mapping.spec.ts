// What devices of the Smart Home become in ViON and how their state lands on the sensors: both formats of Yandex
// read into one shape, a button pressed only when the press is new, commands for switches and lights.
// Run: npx tsx spec/mapping.spec.ts
import assert from 'node:assert/strict';

import { DoorbellTrigger, LightProperty, SensorType, SwitchProperty } from '@camera.ui/sdk';

import { scenarioSlot, slotFromRecord, slotsOf, splitNativeId } from '../src/mapping.js';
import { applyDevice, commandFor, createSensor } from '../src/sensors.js';
import { parseHosts } from '../src/voice.js';
import { isCamera, isStation, mergeDevice, parseQuasarDevices, parseUserInfo } from '../src/yandex/home.js';
import { cloudText, scenarioTrigger, ttsScenario } from '../src/yandex/quasar.js';
import { baseDevices } from './fake-yandex.js';

import type { Bound } from '../src/sensors.js';

const noop = async () => {};

// ---- both formats in one shape
const official = parseUserInfo({
  rooms: [{ id: 'room-1', name: 'Прихожая' }],
  households: [{ id: 'h1', name: 'Дом' }],
  devices: baseDevices().map((d) => ({ ...d, room: d.room ? 'room-1' : undefined, household_id: 'h1', quasar_info: undefined })),
  scenarios: [{ id: 'sc-1', name: 'Я ушёл' }],
});
const app = parseQuasarDevices({
  households: [
    { name: 'Дом', all: baseDevices().map((d) => ({ ...d, room_name: d.room ? 'Прихожая' : undefined, room: undefined })) },
    { name: 'Чужой', sharing_info: {}, all: [{ id: 'x', name: 'x', type: 'devices.types.light', capabilities: [], properties: [] }] },
  ],
});

assert.equal(official.devices.length, 7);
assert.equal(app.length, 7, 'a shared house is not read');
assert.deepEqual(official.scenarios, [{ id: 'sc-1', name: 'Я ушёл' }]);
for (const list of [official.devices, app]) {
  const motion = list.find((d) => d.id === 'motion-1')!;
  assert.equal(motion.room, 'Прихожая');
  assert.equal(motion.properties.find((p) => p.instance === 'motion')?.value, 'not_detected');
  assert.equal(motion.properties.find((p) => p.instance === 'motion')?.updatedAt, 1_000_000, 'seconds become milliseconds');
  assert.equal(list.find((d) => d.id === 'lamp-1')!.capabilities.find((c) => c.type === 'devices.capabilities.on_off')?.instance, 'on');
}
assert.deepEqual(
  app.find((d) => d.id === 'station-1')!.quasar,
  { deviceId: 'ST100', platform: 'yandexstation_2' },
  'the app gives the ids of a station for its protocols',
);
assert.ok(isStation(app.find((d) => d.id === 'station-1')!));
assert.ok(isCamera(app.find((d) => d.id === 'cam-1')!));

// ---- what becomes a sensor
const slots = official.devices.flatMap(slotsOf);
const byId = new Map(slots.map((s) => [s.nativeId, s]));
assert.deepEqual([...byId.keys()].sort(), ['button-1|button', 'door-1|open', 'lamp-1|on', 'motion-1|illumination', 'motion-1|motion', 'relay-1|on'].sort(), 'stations and cameras are not sensors');
assert.equal(byId.get('motion-1|motion')!.type, SensorType.Motion);
assert.equal(byId.get('motion-1|motion')!.name, 'Датчик в прихожей: движение', 'a device with several sensors names each');
assert.equal(byId.get('motion-1|illumination')!.type, SensorType.Illuminance);
assert.equal(byId.get('door-1|open')!.name, 'Входная дверь', 'a device with one sensor keeps its name');
assert.equal(byId.get('door-1|open')!.type, SensorType.Contact);
assert.equal(byId.get('button-1|button')!.type, SensorType.Doorbell);
assert.equal(byId.get('relay-1|on')!.type, SensorType.Switch);
assert.equal(byId.get('lamp-1|on')!.type, SensorType.Light);
assert.equal(scenarioSlot({ id: 'sc-1', name: 'Я ушёл' }).nativeId, 'scenario|sc-1');
assert.deepEqual(splitNativeId('a|b|c'), { deviceId: 'a|b', key: 'c' });

// an adopted sensor is bound again from its record, before the device is read
assert.deepEqual(slotFromRecord('door-1|open', 'Дверь', SensorType.Contact)?.binding, byId.get('door-1|open')!.binding);
assert.equal(slotFromRecord('lamp-1|on', 'Лампа', SensorType.Light)?.binding.kind, 'onoff');
assert.equal(slotFromRecord('scenario|sc-1', 'S', SensorType.Switch)?.binding.kind, 'scenario');
assert.equal(slotFromRecord('lamp-1', 'S', SensorType.Switch), undefined);

// ---- state on the sensors
function bind(nativeId: string): Bound {
  const slot = byId.get(nativeId)!;
  return { slot, sensor: createSensor(slot, noop) };
}
function device(id: string, patch: (d: any) => void) {
  const raw = baseDevices().find((d) => d.id === id)!;
  patch(raw);
  return parseUserInfo({ devices: [raw] }).devices[0]!;
}

const motion = bind('motion-1|motion');
applyDevice(motion, device('motion-1', () => {}), false);
assert.equal(motion.sensor.getValue('detected'), false);
applyDevice(motion, device('motion-1', (d) => (d.properties[0].state.value = 'detected')), true);
assert.equal(motion.sensor.getValue('detected'), true);

const door = bind('door-1|open');
applyDevice(door, device('door-1', (d) => (d.properties[0].state.value = 'opened')), true);
assert.equal(door.sensor.getValue('detected'), true, 'an open door is a detected contact');

const light = bind('motion-1|illumination');
applyDevice(light, device('motion-1', () => {}), false);
assert.equal(light.sensor.getValue('current'), 42);

// a button: the value stays "click", only a new time of it is a new press, and never the first reading
const button = bind('button-1|button');
let rings = 0;
(button.sensor as DoorbellTrigger).trigger = () => void rings++;
applyDevice(button, device('button-1', () => {}), true);
assert.equal(rings, 0, 'the first reading is not a press');
applyDevice(button, device('button-1', () => {}), true);
assert.equal(rings, 0, 'the same press read again is not a new one');
applyDevice(button, device('button-1', (d) => (d.properties[0].last_updated = 2000)), true);
assert.equal(rings, 1, 'a new time of the click is a press');
applyDevice(button, device('button-1', (d) => (d.properties[0].last_updated = 3000)), false);
assert.equal(rings, 1, 'a reading after a reconnect is not a press');

const relay = bind('relay-1|on');
applyDevice(relay, device('relay-1', (d) => (d.capabilities[0].state.value = true)), true);
assert.equal(relay.sensor.getValue(SwitchProperty.On), true);
const lamp = bind('lamp-1|on');
applyDevice(lamp, device('lamp-1', () => {}), true);
assert.equal(lamp.sensor.getValue(LightProperty.On), true);
assert.equal(lamp.sensor.getValue(LightProperty.Brightness), 60);

// an update of the app may carry only what changed
const merged = mergeDevice(app.find((d) => d.id === 'motion-1')!, {
  id: 'motion-1',
  properties: [{ type: 'devices.properties.event', parameters: { instance: 'motion' }, state: { instance: 'motion', value: 'detected' } }],
});
assert.equal(merged.properties.find((p) => p.instance === 'motion')?.value, 'detected');
assert.equal(merged.properties.find((p) => p.instance === 'illumination')?.value, 42, 'what the update does not carry stays');
assert.equal(merged.name, 'Датчик в прихожей');

// ---- commands
assert.deepEqual(commandFor(byId.get('relay-1|on')!, SwitchProperty.On, true), { type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } });
assert.deepEqual(commandFor(byId.get('lamp-1|on')!, LightProperty.Brightness, 140), { type: 'devices.capabilities.range', state: { instance: 'brightness', value: 100 } });
assert.equal(commandFor(byId.get('relay-1|on')!, LightProperty.Brightness, 10), undefined, 'a relay has no brightness');
assert.equal(commandFor(byId.get('door-1|open')!, 'detected', true), undefined, 'a sensor takes no commands');

// ---- the voice helpers
assert.equal(scenarioTrigger('0a-f'), 'окыя');
assert.equal(cloudText(`  ${'а'.repeat(150)}  `).length, 100);
const tts = ttsScenario('station-1', 'Привет');
assert.equal(tts.steps[0]!.parameters.items[0]!.value.capabilities[0]!.state.instance, 'tts');
assert.equal(tts.triggers[0]!.trigger.value, scenarioTrigger('station-1'));
assert.deepEqual([...parseHosts('Кухня = 192.168.1.20\nST100=10.0.0.5:1962\nbad line').entries()], [
  ['кухня', { host: '192.168.1.20', port: 1961 }],
  ['st100', { host: '10.0.0.5', port: 1962 }],
]);

console.log('mapping.spec: ok');
