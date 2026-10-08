// What a ViON Sensor feels and how it is tuned, through the assistant: reading for anyone, a calibration and a new
// threshold, hold time or source of motion an admin's and asked first. The card says the values before and after and
// that the room must be empty; an ESPectre board keeps its own threshold; the firmware is only named, never installed.
// Run: npx tsx spec/assistant.spec.ts
import assert from 'node:assert/strict';

import { callSensorTool, SENSOR_TOOLS } from '../src/assistant.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { AssistantBoard } from '../src/assistant.js';
import type { VionSensorLive } from '../src/index.js';

const calls: string[] = [];
const live = (over: Partial<VionSensorLive> = {}): VionSensorLive => ({
  sensorId: 's',
  cameraId: null,
  state: 'quiet',
  calibrationLeftS: 0,
  level: 0.83,
  threshold: 1.4,
  rssi: -61,
  packetsPerS: 97.6,
  presence: { state: 'absent', level: 0.001, threshold: 0.002 },
  radar: null,
  ...over,
});
function board(name: string, over: Partial<AssistantBoard> = {}): AssistantBoard {
  return {
    name,
    kind: 'vion',
    live: live(),
    firmware: '1.1.0',
    newerFirmware: '1.2.0',
    threshold: 1.4,
    holdS: 8,
    motionSource: 'vion',
    hasPresence: true,
    calibrationS: 30,
    calibrate: async () => void calls.push(`calibrate ${name}`),
    configure: async (patch) => void calls.push(`configure ${name} ${JSON.stringify(patch)}`),
    ...over,
  };
}

const hall = board('Прихожая');
const old = board('Кладовка', { hasPresence: false, firmware: '1.0.2', newerFirmware: undefined });
const esp = board('Спальня', { kind: 'espectre', threshold: undefined, motionSource: undefined, hasPresence: false, calibrationS: undefined, newerFirmware: undefined });
const host = { boards: () => [hall, old, esp] };
const admin: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const user: AssistantToolContext = { ...admin, role: 'user' };

const spec = (name: string) => SENSOR_TOOLS.find((t) => t.name === name)!;
assert.equal(spec('live').approval, undefined);
for (const name of ['calibrate', 'tune']) assert.deepEqual([spec(name).approval, spec(name).adminOnly], [true, true], name);
// the firmware is not a tool
assert.equal(SENSOR_TOOLS.some((t) => /firmware|update/.test(t.name)), false);
console.log('sensor assistant: specs OK');

// reading, the newer firmware named with where it is installed
const read = (await callSensorTool(host, 'live', { sensor: 'прихожая' }, user)).content as Record<string, unknown>;
assert.deepEqual(read, {
  sensor: 'Прихожая',
  state: 'quiet',
  level: 0.83,
  threshold: 1.4,
  motionAt: 'level = threshold',
  presence: 'absent',
  rssiDbm: -61,
  packetsPerS: 98,
  holdS: 8,
  motionSource: 'vion',
  firmware: '1.1.0',
  newerFirmware: '1.2.0',
  firmwareNote: 'Installed on the settings page of the sensor, not from the chat.',
});
assert.equal(((await callSensorTool(host, 'live', {}, user)).content as unknown[]).length, 3);
console.log('sensor assistant: live OK');

// a user cannot change it
assert.match(String((await callSensorTool(host, 'calibrate', { sensor: 'Прихожая' }, user)).error), /administrator/);
assert.deepEqual(calls, []);

// the cards say it and change nothing
assert.deepEqual((await callSensorTool(host, 'calibrate', { sensor: 'Прихожая', __preview: true }, admin)).content, {
  preview: { lines: ['Прихожая: калибровка на пустой комнате', 'В комнате никого не должно быть 30 секунд, иначе датчик примет человека за пустую комнату'] },
});
assert.deepEqual((await callSensorTool(host, 'tune', { sensor: 'Прихожая', threshold: 1.6, holdSeconds: 8, motionSource: 'any', __preview: true }, admin)).content, {
  preview: { lines: ['Прихожая', 'Порог движения: 1.4 → 1.6', 'Источник движения: ViON → любой из двух'] },
});
// a value that is so already is not a change: the card says so, nothing is sent to the board
assert.deepEqual((await callSensorTool(host, 'tune', { sensor: 'Прихожая', threshold: 1.4, __preview: true }, admin)).content, {
  preview: { lines: ['Прихожая: всё уже так, ничего не меняется'] },
});
assert.deepEqual((await callSensorTool(host, 'tune', { sensor: 'Прихожая', threshold: 1.4 }, admin)).content, { done: false, sensor: 'Прихожая', reason: 'Everything is so already.' });
assert.deepEqual(calls, []);
console.log('sensor assistant: cards OK');

// the changes
await callSensorTool(host, 'calibrate', { sensor: 'Прихожая' }, admin);
await callSensorTool(host, 'tune', { sensor: 'Прихожая', threshold: 1.6, holdSeconds: 20 }, admin);
assert.deepEqual(calls, ['calibrate Прихожая', 'configure Прихожая {"threshold":1.6,"holdS":20}']);
console.log('sensor assistant: calibrate and tune OK');

// refused before anything changes: out of range, an ESPectre threshold, Espressif on an old firmware, an offline board
for (const [args, why] of [
  [{ sensor: 'Прихожая', threshold: 9 }, /threshold: 1.05–5/],
  [{ sensor: 'Спальня', threshold: 2 }, /ESPectre board/],
  [{ sensor: 'Кладовка', motionSource: 'espressif' }, /firmware 1.1.0/],
  [{ sensor: 'Прихожая', holdSeconds: 0 }, /holdSeconds/],
] as const) {
  assert.match(String((await callSensorTool(host, 'tune', args, admin)).error), why);
}
const offline = { boards: () => [board('Гараж', { live: live({ state: 'offline' }) })] };
assert.match(String((await callSensorTool(offline, 'calibrate', { sensor: 'Гараж' }, admin)).error), /does not answer/);
assert.equal(calls.length, 2);
// the ESPectre board takes its hold time
await callSensorTool(host, 'tune', { sensor: 'Спальня', holdSeconds: 15 }, admin);
assert.equal(calls.at(-1), 'configure Спальня {"holdS":15}');
console.log('sensor assistant: refusals OK');
