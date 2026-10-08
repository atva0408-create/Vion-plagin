// The presets of a PTZ camera and the reboot of the camera through the assistant: reading runs for anyone, saving,
// deleting and rebooting are an admin's and asked first. The card (`__preview`) says what would happen and changes
// nothing; a name that would break into the SOAP body is refused; a preset of the same name is overwritten, not doubled.
// Run: npx tsx spec/assistant.spec.ts
import assert from 'node:assert/strict';

import { callOnvifTool, ONVIF_TOOLS, presetsOf } from '../src/assistant.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { OnvifAssistantCamera } from '../src/assistant.js';

const calls: string[] = [];
function fakeCamera(name: string, opts: { ptz?: boolean; connected?: boolean } = {}): OnvifAssistantCamera & { stored: { name: string; token: string }[] } {
  const stored = [
    { name: 'Ворота', token: '1' },
    { name: 'Двор', token: '2' },
  ];
  return {
    id: `id-${name}`,
    name,
    connected: opts.connected ?? true,
    hasPTZ: opts.ptz ?? true,
    stored,
    presets: async () => stored.map((p) => ({ ...p })),
    savePreset: async (preset, token) => {
      calls.push(`save ${name} ${preset} ${token ?? '-'}`);
      if (token) return token;
      stored.push({ name: preset, token: String(stored.length + 1) });
      return String(stored.length);
    },
    removePreset: async (token) => void calls.push(`remove ${name} ${token}`),
    reboot: async () => (calls.push(`reboot ${name}`), 'Rebooting in 30 seconds'),
  };
}

const street = fakeCamera('Улица');
const fixed = fakeCamera('Подъезд', { ptz: false });
const host = { cameras: () => [street, fixed] };
const admin: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const user: AssistantToolContext = { ...admin, role: 'user' };

// the specs: reading without asking, changes asked and an admin's
const spec = (name: string) => ONVIF_TOOLS.find((t) => t.name === name)!;
assert.equal(spec('presets').approval, undefined);
for (const name of ['save_preset', 'delete_preset', 'reboot']) assert.deepEqual([spec(name).approval, spec(name).adminOnly], [true, true], name);
console.log('onvif assistant: specs OK');

// reading
assert.deepEqual((await callOnvifTool(host, 'presets', {}, user)).content, [{ camera: 'Улица', presets: ['Ворота', 'Двор'] }]);
assert.match(String((await callOnvifTool(host, 'presets', { camera: 'Подъезд' }, user)).error), /no pan and tilt/);
console.log('onvif assistant: presets OK');

// a change by a user is refused here too
assert.match(String((await callOnvifTool(host, 'reboot', { camera: 'Улица' }, user)).error), /administrator/);
assert.deepEqual(calls, []);
console.log('onvif assistant: admin only OK');

// the card says it in words and changes nothing
assert.deepEqual((await callOnvifTool(host, 'save_preset', { camera: 'Улица', name: 'Калитка', __preview: true }, admin)).content, {
  preview: { lines: ['Улица: запомнить текущее положение как пресет «Калитка»'] },
});
assert.deepEqual((await callOnvifTool(host, 'save_preset', { camera: 'Улица', name: 'ворота', __preview: true }, admin)).content, {
  preview: { lines: ['Улица: пресет «ворота» перезаписывается текущим положением'] },
});
assert.deepEqual((await callOnvifTool(host, 'reboot', { camera: 'Улица', __preview: true }, admin)).content, {
  preview: { lines: ['Улица: перезагрузить камеру', 'Камера будет недоступна 1–2 минуты: ни эфира, ни записи'] },
});
assert.deepEqual(calls, []);
console.log('onvif assistant: cards OK');

// saving: a new one, then the same name overwrites its token
assert.deepEqual((await callOnvifTool(host, 'save_preset', { camera: 'Улица', name: 'Калитка' }, admin)).content, {
  done: true,
  camera: 'Улица',
  preset: 'Калитка',
  overwritten: false,
  token: '3',
});
await callOnvifTool(host, 'save_preset', { camera: 'Улица', name: 'ворота' }, admin);
assert.deepEqual(calls, ['save Улица Калитка -', 'save Улица ворота 1']);
// a name with markup never reaches the camera
assert.match(String((await callOnvifTool(host, 'save_preset', { camera: 'Улица', name: '</PresetName><x>' }, admin)).error), /letters, digits/);
assert.equal(calls.length, 2);
console.log('onvif assistant: save OK');

// deleting by name, an unknown one says the names there are
await callOnvifTool(host, 'delete_preset', { camera: 'Улица', name: 'двор' }, admin);
assert.equal(calls.at(-1), 'remove Улица 2');
assert.match(String((await callOnvifTool(host, 'delete_preset', { camera: 'Улица', name: 'Нет' }, admin)).error), /Its presets: Ворота, Двор/);
console.log('onvif assistant: delete OK');

// the reboot, and a camera that does not answer is not promised one
assert.match(JSON.stringify((await callOnvifTool(host, 'reboot', { camera: 'Улица' }, admin)).content), /gone for one or two minutes/);
assert.equal(calls.at(-1), 'reboot Улица');
const offline = { cameras: () => [fakeCamera('Склад', { connected: false })] };
assert.match(String((await callOnvifTool(offline, 'reboot', { camera: 'Склад' }, admin)).error), /does not answer/);
console.log('onvif assistant: reboot OK');

// a preset named with digits: the library reads the name as a number, and saving or deleting broke
assert.deepEqual(
  presetsOf({ a: { name: 1, token: 1 }, b: { name: 'Двор', token: '2' }, c: { token: 3 }, d: { name: 'x' } }),
  [
    { name: '1', token: '1' },
    { name: 'Двор', token: '2' },
    { name: '3', token: '3' },
  ],
);
const numbered = fakeCamera('Склад');
numbered.presets = async () => presetsOf({ p: { name: 1 as unknown as string, token: 7 } });
const numberedHost = { cameras: () => [numbered] };
calls.length = 0;
assert.equal((await callOnvifTool(numberedHost, 'save_preset', { camera: 'Склад', name: '1' }, admin)).content?.overwritten, true);
assert.equal((await callOnvifTool(numberedHost, 'delete_preset', { camera: 'Склад', name: '1' }, admin)).content?.deleted, '1');
assert.deepEqual(calls, ['save Склад 1 7', 'remove Склад 7']);
// and a name the library left a number is still found
numbered.presets = async () => [{ name: 1 as unknown as string, token: '7' }];
assert.equal((await callOnvifTool(numberedHost, 'delete_preset', { camera: 'Склад', name: '1' }, admin)).content?.deleted, 1);
console.log('onvif assistant: presets named with digits OK');
