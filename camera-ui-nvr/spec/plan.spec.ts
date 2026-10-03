// The plan the recorder applies: when the server says the plan changed (reloadEntitlements, ViON Cloud told it), the
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
const BUSINESS = { source: 'cloud', plan: { id: 'business', name: 'Business' }, nvr: { maxCameras: 0, retentionDays: 90 } };
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
assert.equal(now.maxCameras, 0, 'every camera records on Business');
assert.equal(now.retentionDays, 90);
assert.equal(asked, 2, 'each notice is one question to the server');

console.log('plan.spec: a changed plan is applied when the server says so, not ten minutes later — ok');
process.exit(0);
