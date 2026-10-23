// The notify of Home Assistant answered nothing about its deliveries: a phone that HA could not reach (the service
// gone, HA down, a 500) was marked «delivered» by the server, and a route's fallback (Telegram) never fired (ViON audit
// 2026-10-23, F1). The notifier now says what became of each target, as the Telegram and Yandex plugins do.
// Run: npx tsx spec/notifier.spec.ts
import assert from 'node:assert/strict';

import { HaNotifier } from '../src/notifier.js';

import type { Notification } from '@camera.ui/sdk';

interface Delivery {
  deviceId: string;
  ok: boolean;
  error?: string;
}

const calls: string[] = [];
let connected = true;
const client = {
  fetchNotifyServices: async () => ['notify', 'mobile_app_anna', 'mobile_app_boris'],
  fetchPanels: async () => ({}),
  callService: async (_domain: string, service: string) => {
    calls.push(service);
    if (service === 'mobile_app_boris') throw new Error('Service notify.mobile_app_boris not found');
  },
};
const storage = { values: { mutedNotifyServices: ['mobile_app_muted'] } as Record<string, unknown>, save: async () => undefined };
const logger = { log() {}, debug() {}, warn() {}, error() {}, trace() {} };
const notifier = new HaNotifier(storage as never, logger as never, () => (connected ? (client as never) : undefined));
const notice = { title: 'Движение', body: 'Двор', silent: false } as Notification;
const send = async (ids: string[], n = notice) => (await notifier.sendNotification(ids, n)) as unknown as Delivery[] | undefined;

await notifier.refreshTargets([]);

{
  const said = await send(['notify:mobile_app_anna', 'notify:mobile_app_boris', 'notify:mobile_app_gone', 'notify:mobile_app_muted']);
  assert.ok(Array.isArray(said), 'the notifier answers per target');
  assert.deepEqual(
    said.map((d) => [d.deviceId, d.ok]),
    [
      ['notify:mobile_app_anna', true],
      ['notify:mobile_app_boris', false],
      ['notify:mobile_app_gone', false],
      ['notify:mobile_app_muted', false],
    ],
  );
  assert.match(said[1].error ?? '', /not found/, 'the error of HA comes back');
  assert.match(said[2].error ?? '', /no longer offers/, 'a target HA stopped offering');
  assert.match(said[3].error ?? '', /muted/, 'a muted target');
  assert.deepEqual(calls, ['mobile_app_anna', 'mobile_app_boris'], 'the gone and the muted were not called');
}

{
  connected = false;
  const said = await send(['notify:mobile_app_anna']);
  assert.deepEqual(said, [{ deviceId: 'notify:mobile_app_anna', ok: false, error: 'Home Assistant is not connected' }]);
  connected = true;
}

{
  // a silent update of a banner: HA notify cannot replace one, and the server decides about such notices itself
  const said = await send(['notify:mobile_app_anna'], { ...notice, silent: true });
  assert.equal(said, undefined);
}

console.log('notifier.spec: a delivery answered per target, HA down, a silent update OK');
