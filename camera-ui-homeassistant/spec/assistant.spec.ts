// The entities of Home Assistant and a service call through the assistant: reading runs for anyone, a call is an
// admin's and asked first. The card (`__preview`) says what would happen and calls nothing; a domain outside the list
// (a lock, the alarm panel, homeassistant.restart) is refused unless the admin added it; a service acts only on an
// entity of its own domain that exists.
// Run: npx tsx spec/assistant.spec.ts
import assert from 'node:assert/strict';

import { callHaTool, HA_TOOLS } from '../src/assistant.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { HaAssistantHost, HaEntity } from '../src/assistant.js';

const calls: string[] = [];
let extra: string[] = [];
let connected = true;
const entities: HaEntity[] = [
  { entityId: 'light.kitchen', name: 'Свет на кухне', state: 'off', area: 'Кухня' },
  { entityId: 'scene.evening', name: 'Вечер', state: 'scening' },
  { entityId: 'lock.front_door', name: 'Входная дверь', state: 'locked', area: 'Прихожая' },
  { entityId: 'fan.bedroom', name: 'Вентилятор', state: 'off', area: 'Спальня' },
];
const host: HaAssistantHost = {
  connected: () => connected,
  entities: async () => entities.map((e) => ({ ...e })),
  extraDomains: () => extra,
  callService: async (domain, service, data) => void calls.push(`${domain}.${service} ${JSON.stringify(data)}`),
};
const admin: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const user: AssistantToolContext = { ...admin, role: 'user' };

async function run(name: string, input: Record<string, unknown>, ctx = admin) {
  return callHaTool(host, name, input, ctx);
}
const content = (r: { content?: unknown }) => r.content as Record<string, any>;

// declared: reading is free, the call is an admin's and confirmed
{
  const read = HA_TOOLS.find((t) => t.name === 'entities')!;
  const call = HA_TOOLS.find((t) => t.name === 'call_service')!;
  assert.ok(!read.approval && !read.adminOnly);
  assert.equal(call.approval, true);
  assert.equal(call.adminOnly, true);
}

// entities: narrowed by area and domain; out-of-list domains are marked read only
{
  const kitchen = content(await run('entities', { area: 'кухня' }, user));
  assert.deepEqual(kitchen.entities, [{ entity_id: 'light.kitchen', name: 'Свет на кухне', state: 'off', area: 'Кухня' }]);
  const locks = content(await run('entities', { domain: 'lock' }, user));
  assert.equal(locks.entities[0].readOnly, true);
  const byWords = content(await run('entities', { search: 'вечер' }, user));
  assert.deepEqual(byWords.entities.map((e: any) => e.entity_id), ['scene.evening']);
}

// a plain user may not call
{
  const r = await run('call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' }, user);
  assert.match(r.error ?? '', /administrator/);
  assert.equal(calls.length, 0);
}

// the card: human words, data lines, nothing called
{
  const r = await run('call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen', data: { brightness_pct: 40 }, __preview: true });
  assert.deepEqual(content(r).preview.lines, ['Свет на кухне (Кухня): включить', 'brightness_pct: 40']);
  const de = await callHaTool(host, 'call_service', { domain: 'scene', service: 'turn_on', entity_id: 'scene.evening', __preview: true }, { ...admin, language: 'de' });
  assert.deepEqual(content(de).preview.lines, ['Вечер: einschalten']);
  assert.equal(calls.length, 0);
}

// the call: entity_id from the input wins over one smuggled into data
{
  const r = await run('call_service', { domain: 'light', service: 'turn_off', entity_id: 'light.kitchen', data: { entity_id: 'lock.front_door', transition: 2 } });
  assert.equal(content(r).done, true);
  assert.deepEqual(calls.splice(0), ['light.turn_off {"transition":2,"entity_id":"light.kitchen"}']);
}

// a domain outside the list is refused; the admin's setting opens it
{
  const lock = await run('call_service', { domain: 'lock', service: 'unlock', entity_id: 'lock.front_door' });
  assert.match(lock.error ?? '', /may not be called/);
  const restart = await run('call_service', { domain: 'homeassistant', service: 'restart' });
  assert.match(restart.error ?? '', /may not be called/);
  const fanBefore = await run('call_service', { domain: 'fan', service: 'turn_on', entity_id: 'fan.bedroom' });
  assert.match(fanBefore.error ?? '', /may not be called/);
  extra = ['fan', 'bad domain!'];
  const fan = await run('call_service', { domain: 'fan', service: 'turn_on', entity_id: 'fan.bedroom' });
  assert.equal(content(fan).done, true);
  assert.deepEqual(calls.splice(0), ['fan.turn_on {"entity_id":"fan.bedroom"}']);
  extra = [];
}

// a service acts on its own domain only, on an entity that exists, with names that fit a URL path
{
  const cross = await run('call_service', { domain: 'light', service: 'turn_on', entity_id: 'lock.front_door' });
  assert.match(cross.error ?? '', /not a light entity/);
  const missing = await run('call_service', { domain: 'light', service: 'turn_on', entity_id: 'light.attic' });
  assert.match(missing.error ?? '', /No entity/);
  const none = await run('call_service', { domain: 'light', service: 'turn_on' });
  assert.match(none.error ?? '', /entity_id is required/);
  const path = await run('call_service', { domain: 'light', service: '../config', entity_id: 'light.kitchen' });
  assert.match(path.error ?? '', /lower case words/);
  assert.equal(calls.length, 0);
}

// notify needs no entity
{
  const card = await run('call_service', { domain: 'notify', service: 'mobile_app_phone', data: { message: 'Привет' }, __preview: true });
  assert.deepEqual(content(card).preview.lines, ['Уведомление через notify.mobile_app_phone', 'message: Привет']);
  await run('call_service', { domain: 'notify', service: 'mobile_app_phone', data: { message: 'Привет' } });
  assert.deepEqual(calls.splice(0), ['notify.mobile_app_phone {"message":"Привет"}']);
}

// not connected: said, nothing called
{
  connected = false;
  const r = await run('entities', {}, user);
  assert.match(r.error ?? '', /not connected/);
  connected = true;
}

console.log('homeassistant assistant: ok');
