// The plan the recorder applies: when the server says the plan changed (reloadEntitlements, VION Cloud told it), the
// recorder reads it at once instead of at its next question, which comes every ten minutes.
// Run: npx tsx spec/plan.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

const noop = () => undefined;
const dir = mkdtempSync(join(tmpdir(), 'nvr-plan-'));

const FREE = { source: 'cloud', plan: { id: 'free', name: 'Бесплатный' }, nvr: { maxCameras: 2, retentionDays: 7 } };
// a server of VION 2.7 says 256 for «no limit of cameras» (docs/LICENSING_TZ.md, stage 2 of VIONN-)
const BUSINESS = { source: 'cloud', plan: { id: 'business', name: 'Business' }, nvr: { maxCameras: 256, retentionDays: 90 } };
const ZERO = { source: 'cloud', plan: { id: 'old', name: 'Old' }, nvr: { maxCameras: 0, retentionDays: 90 } };
let plan = FREE;
let asked = 0;

const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
    getEntitlements: async () => {
      asked++;
      return plan;
    },
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);

await nvr.reloadEntitlements();
assert.equal((await nvr.getRecordingPlan()).planName, 'Бесплатный');

// the owner moved to Business in the cloud: told, the recorder has it before its next question
plan = BUSINESS;
await nvr.reloadEntitlements();
const now = await nvr.getRecordingPlan();
assert.equal(now.planName, 'Business');
assert.equal(now.maxCameras, 256);
assert.equal(now.retentionDays, 90);
assert.equal(asked, 2, 'each notice is one question to the server');

// 0 no longer means «record every camera»: the free level, two cameras
plan = ZERO as typeof plan;
await nvr.reloadEntitlements();
assert.equal((await nvr.getRecordingPlan()).maxCameras, 2, '0 cameras is the free level');

// a host that does not answer the limits (none read yet, or no such call): the free level too, not every camera
const silent = new VionNvr(
  { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never,
  { ...api, storagePath: mkdtempSync(join(tmpdir(), 'nvr-plan-silent-')), coreManager: { ...api.coreManager, getEntitlements: undefined } } as never,
  storage as never,
);
assert.equal((await silent.getRecordingPlan()).maxCameras, 2, 'an unknown limit is the free level');

console.log('plan.spec: a changed plan is applied when the server says so; 0 and an unknown limit are the free level, two cameras — ok');
process.exit(0);
