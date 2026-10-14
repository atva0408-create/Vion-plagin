// The pictures of an event given to the describer (index.ts describePictures): the card of each segment, else its
// strip, else the scene. An empty file (an empty attachment, a write cut short) is no picture: it went to the model as
// an empty image, as eventPicture's did to the finder.
// Run: npx tsx spec/describe-pictures.spec.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-describe-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  proxy: { createProxy: () => ({}) },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const internals = nvr as unknown as { thumbDir(cameraId: string, eventId: string): string; describePictures(event: unknown): Uint8Array[] };

const JPEG = (n: number) => Uint8Array.from([0xff, 0xd8, n, 0xff, 0xd9]);
function eventWith(id: string, files: Record<string, Uint8Array>, segments = 2) {
  const dir = internals.thumbDir('desk', id);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  return { id, cameraId: 'desk', segments: Array.from({ length: segments }, () => ({})) };
}

// ---- an empty card: the strip of that segment instead
{
  const event = eventWith('e1', { 'card-0.jpg': new Uint8Array(0), 'strip-0.jpg': JPEG(1), 'card-1.jpg': JPEG(2) });
  assert.deepEqual(
    internals.describePictures(event).map((p) => p[2]),
    [1, 2],
    'the strip of the first segment, the card of the second',
  );
}

// ---- every card and strip empty: the scene; the scene empty too: nothing
{
  const scene = eventWith('e2', { 'card-0.jpg': new Uint8Array(0), 'strip-0.jpg': new Uint8Array(0), 'event.jpg': JPEG(9) }, 1);
  assert.deepEqual(
    internals.describePictures(scene).map((p) => p[2]),
    [9],
  );
  const none = eventWith('e3', { 'card-0.jpg': new Uint8Array(0), 'event.jpg': new Uint8Array(0) }, 1);
  assert.deepEqual(internals.describePictures(none), [], 'no empty picture is given');
}

console.log('describe-pictures.spec: empty cards and strips skipped, the scene as the last picture, nothing empty given OK');
process.exit(0);
