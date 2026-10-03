// Zoom and focus of a Xiaomi camera with a zoom lens: found by name in the MIoT description of the camera (a number
// to set, actions for each way, or values in, out and stop), driven step by step, and the PTZ control that zooms
// while the zoom of the player is held. A camera with a fixed lens (C300) has none and turns as before.
// Run: npx tsx spec/optics.spec.ts
import assert from 'node:assert/strict';

import { PTZCapability } from '@camera.ui/sdk';

import { axisDriver, lensOf, STEPS_PER_RANGE } from '../src/optics.js';
import { XiaomiPtz } from '../src/ptz.js';
import { SpecSource, findOptics, hasOptics, wordsOf } from '../src/xiaomi/spec.js';

import type { MiotDevice } from '../src/xiaomi/miot.js';
import { C300, RW, ZOOM_CAMERA } from './miot-specs.js';

import type { ActionRef, MiotSpec, PropRef } from '../src/xiaomi/spec.js';

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A device that records what it was sent and keeps the values it was set to. */
function recordingDevice(values: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const key = (prop: PropRef) => `${prop.siid}.${prop.piid}`;
  const device: MiotDevice = {
    async get(prop) {
      sent.push(`get ${key(prop)}`);
      return values[key(prop)];
    },
    async set(prop, value) {
      sent.push(`set ${key(prop)}=${JSON.stringify(value)}`);
      values[key(prop)] = value;
    },
    async action(action: ActionRef) {
      sent.push(`action ${action.siid}.${action.aiid}`);
    },
  };
  return { device, sent, values };
}

test('the words of a property: the name in its type and its description', () => {
  assert.equal(wordsOf({ type: 'urn:xiaomi-spec:property:optical-zoom:00000001:x:1', description: 'Optical Zoom' }), 'optical zoom optical zoom');
});

test('a zoom lens: the optical zoom before the digital one, focus actions each way, autofocus', () => {
  const optics = findOptics(ZOOM_CAMERA);
  assert.deepEqual(optics.zoom, { kind: 'range', prop: { siid: 9, piid: 1 }, min: 1, max: 30, step: 1 });
  assert.deepEqual(optics.focus, { kind: 'actions', plus: { siid: 9, aiid: 2 }, minus: { siid: 9, aiid: 1 } });
  assert.deepEqual(optics.autoFocus, { kind: 'action', action: { siid: 9, aiid: 3 } });
  assert.ok(hasOptics(optics));
});

test('a camera with a fixed lens has no zoom and no focus', () => {
  assert.deepEqual(findOptics(C300), {});
  assert.equal(hasOptics(findOptics(C300)), false);
});

test('a read-only zoom is not a zoom ViON can drive', () => {
  const spec: MiotSpec = {
    type: 't',
    services: [{ iid: 3, type: 's', properties: [{ iid: 1, type: 'urn:x:property:zoom:1:x:1', format: 'uint8', access: ['read'], 'value-range': [0, 10, 1] }] }],
  };
  assert.equal(findOptics(spec).zoom, undefined);
});

test('a zoom of values in, out and stop is held like the motor, and stopped', async () => {
  const spec: MiotSpec = {
    type: 't',
    services: [
      {
        iid: 4,
        type: 's',
        properties: [
          {
            iid: 2,
            type: 'urn:xiaomi-spec:property:zoom-direction:2:x:1',
            format: 'uint8',
            access: RW,
            'value-list': [
              { value: 0, description: 'Stop' },
              { value: 1, description: 'Zoom In' },
              { value: 2, description: 'Zoom Out' },
            ],
          },
        ],
      },
    ],
  };
  const optics = findOptics(spec);
  assert.deepEqual(optics.zoom, { kind: 'values', prop: { siid: 4, piid: 2 }, plus: 1, minus: 2, stop: 0 });
  const { device, sent } = recordingDevice();
  const zoom = axisDriver(optics.zoom!, device);
  await zoom.step(1);
  await zoom.step(-1);
  await zoom.stop!();
  assert.deepEqual(sent, ['set 4.2=1', 'set 4.2=2', 'set 4.2=0']);
});

test('zoom actions each way are steps', async () => {
  const spec: MiotSpec = {
    type: 't',
    services: [
      {
        iid: 5,
        type: 's',
        actions: [
          { iid: 1, type: 'urn:x:action:zoom-in:1:x:1', in: [] },
          { iid: 2, type: 'urn:x:action:zoom-out:2:x:1', in: [] },
          { iid: 3, type: 'urn:x:action:zoom-to:3:x:1', in: [4] },
        ],
      },
    ],
  };
  const optics = findOptics(spec);
  assert.deepEqual(optics.zoom, { kind: 'actions', plus: { siid: 5, aiid: 1 }, minus: { siid: 5, aiid: 2 } });
  const { device, sent } = recordingDevice();
  await axisDriver(optics.zoom!, device).step(-1);
  assert.deepEqual(sent, ['action 5.2']);
});

test('a number zoom is read once, stepped by a tenth of its range and kept in it', async () => {
  const { device, sent } = recordingDevice({ '9.1': 1 });
  const zoom = axisDriver({ kind: 'range', prop: { siid: 9, piid: 1 }, min: 1, max: 30, step: 1 }, device);
  await zoom.step(1);
  await zoom.step(1);
  assert.deepEqual(sent, ['get 9.1', 'set 9.1=4', 'set 9.1=7'], `${STEPS_PER_RANGE} steps over the range`);
  sent.length = 0;
  for (let i = 0; i < 12; i++) await zoom.step(1);
  assert.equal(sent.at(-1), 'set 9.1=30');
  assert.equal(sent.filter((line) => line === 'set 9.1=30').length, 1, 'at the end nothing more is sent');
  await zoom.set!(0);
  assert.equal(sent.at(-1), 'set 9.1=1');
  await zoom.set!(0.5);
  assert.equal(sent.at(-1), 'set 9.1=16');
});

test('a zoom that cannot be read starts from the widest', async () => {
  const device: MiotDevice = {
    get: async () => {
      throw new Error('offline');
    },
    set: async () => {},
    action: async () => {},
  };
  const seen: unknown[] = [];
  const zoom = axisDriver({ kind: 'range', prop: { siid: 1, piid: 1 }, min: 0, max: 100, step: 5 }, { ...device, set: async (_p, value) => void seen.push(value) });
  await zoom.step(1);
  assert.deepEqual(seen, [10]);
});

function recorder() {
  const lines: Record<string, string[]> = { error: [], warn: [] };
  const logger = {
    log() {},
    debug() {},
    warn: (...args: unknown[]) => lines.warn!.push(args.join(' ')),
    error: (...args: unknown[]) => lines.error!.push(args.join(' ')),
  };
  return { lines, logger };
}

/** A PTZ control whose motor is never reached (no session opens), with the zoom of the device. */
function zoomPtz(device: MiotDevice, timing = { stepMs: 60, holdMs: 1000, idleMs: 400 }) {
  const { lines, logger } = recorder();
  const lens = lensOf(findOptics(ZOOM_CAMERA), device);
  const motor: string[] = [];
  const ptz = new XiaomiPtz(
    async () => {
      motor.push('open');
      throw new Error('no motor here');
    },
    logger as never,
    timing,
    lens.zoom,
  );
  return { ptz, lines, motor };
}

test('a camera with a zoom lens has the zoom of the player; one without has none', () => {
  const { device } = recordingDevice({ '9.1': 1 });
  assert.ok(zoomPtz(device).ptz.capabilities.includes(PTZCapability.Zoom));
  const plain = new XiaomiPtz(async () => Promise.reject(new Error('x')), recorder().logger as never);
  assert.equal(plain.capabilities.includes(PTZCapability.Zoom), false);
});

test('the zoom of the player held zooms step by step until let go, and never turns the motor', async () => {
  const { device, sent } = recordingDevice({ '9.1': 1 });
  const { ptz, motor } = zoomPtz(device);
  try {
    await ptz.setVelocity({ panSpeed: 0, tiltSpeed: 0, zoomSpeed: 0.8 });
    await sleep(200);
    await ptz.setVelocity({ panSpeed: 0, tiltSpeed: 0, zoomSpeed: 0 });
    const sets = sent.filter((line) => line.startsWith('set'));
    assert.ok(sets.length >= 3 && sets.length <= 5, `zoom steps while held: ${sets.join(', ')}`);
    await sleep(150);
    assert.equal(sent.filter((line) => line.startsWith('set')).length, sets.length, 'a step came after the zoom was let go');
    assert.deepEqual(motor, []);
  } finally {
    ptz.dispose();
  }
});

test('a relative zoom is one step; a small zoom next to a larger pan does not zoom', async () => {
  const { device, sent } = recordingDevice({ '9.1': 10 });
  const { ptz, motor } = zoomPtz(device);
  try {
    await ptz.setRelativeMove({ panDelta: 0, tiltDelta: 0, zoomDelta: -0.3 });
    assert.deepEqual(sent, ['get 9.1', 'set 9.1=7']);
    await ptz.setRelativeMove({ panDelta: 0.5, tiltDelta: 0, zoomDelta: 0.1 });
    assert.equal(sent.length, 2);
    assert.deepEqual(motor, ['open'], 'the pan went to the motor');
  } finally {
    ptz.dispose();
  }
});

test('home zooms all the way out; a position sets the zoom', async () => {
  const { device, sent } = recordingDevice({ '9.1': 20 });
  const { ptz } = zoomPtz(device);
  try {
    await ptz.setPosition({ pan: 0, tilt: 0, zoom: 0 });
    assert.deepEqual(sent, ['set 9.1=1']);
    await ptz.setPosition({ pan: 0, tilt: 0, zoom: 1 });
    assert.equal(sent.at(-1), 'set 9.1=30');
    assert.equal(ptz.position.zoom, 1);
  } finally {
    ptz.dispose();
  }
});

test('a zoom the camera refuses is said in the log and ends the hold', async () => {
  const device: MiotDevice = {
    get: async () => 1,
    set: async () => {
      throw new Error('The camera refused to set 9.1 (code -704042011)');
    },
    action: async () => {},
  };
  const { ptz, lines } = zoomPtz(device);
  try {
    await ptz.setVelocity({ panSpeed: 0, tiltSpeed: 0, zoomSpeed: 1 });
    await sleep(200);
    assert.deepEqual(lines.error, ['Could not zoom in: The camera refused to set 9.1 (code -704042011)']);
  } finally {
    ptz.dispose();
  }
});

test('a spec is read once per model; a model the device list names no spec for is looked up in the list of specs', async () => {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    if (url.pathname.endsWith('/instances')) {
      return Response.json({
        instances: [
          { model: 'xiaomi.camera.zoom01', type: 'urn:old', version: 1 },
          { model: 'xiaomi.camera.zoom01', type: ZOOM_CAMERA.type, version: 2 },
        ],
      });
    }
    if (url.searchParams.get('type') === ZOOM_CAMERA.type) return Response.json(ZOOM_CAMERA);
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  try {
    const source = new SpecSource('https://miot-spec.org/miot-spec-v2');
    const spec = await source.spec('xiaomi.camera.zoom01');
    assert.equal(spec.type, ZOOM_CAMERA.type);
    await source.spec('xiaomi.camera.zoom01');
    assert.equal(asked.length, 2, asked.join(', '));
    await assert.rejects(source.spec('xiaomi.camera.unknown'), /miot-spec.org has no spec of xiaomi.camera.unknown/);
  } finally {
    globalThis.fetch = original;
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
