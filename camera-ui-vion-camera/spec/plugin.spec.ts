// The plugin as VION drives it, against a stand-in of the camera: found at a typed address and offered in «Найденные»,
// added (the camera gives this VION its token and the RTSP access), the stream of each source, a second VION refused,
// a restart of VION that adds nothing anew, a camera reset with its button, and a camera that moved.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import VionCameraPlugin from '../src/index.js';
import { fakeCamera } from './fake-camera.js';

import type { CameraConfig, DiscoveredCamera, StreamingInterface } from '@camera.ui/sdk';

const silent = { log() {}, warn() {}, success() {}, debug() {}, trace() {}, attention() {}, error() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(20);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

function host(values: Record<string, unknown> = {}) {
  const listeners: (() => unknown)[] = [];
  const pushed: DiscoveredCamera[][] = [];
  const lines: string[] = [];
  const logger = { ...silent, log: (...a: unknown[]) => lines.push(a.join(' ')), warn: (...a: unknown[]) => lines.push(a.join(' ')) };
  const storage = {
    values,
    async setValue(key: string, value: unknown) {
      values[key] = value;
    },
    async setInternalValue(key: string, value: unknown) {
      values[key] = value;
    },
  };
  const api = {
    on(_event: string, listener: () => unknown) {
      listeners.push(listener);
      return api;
    },
    deviceManager: {
      async pushDiscoveredCameras(cameras: DiscoveredCamera[]) {
        pushed.push(cameras);
      },
    },
  };
  const plugin = new VionCameraPlugin(logger as never, api as never, storage as never);
  // the plugin looks for cameras by mDNS too; the test network has none, and no sockets should stay open after it
  (plugin as any).finder.start = () => {};
  return { plugin, values, pushed, lines, start: () => listeners[0]!(), stop: () => listeners[1]!() };
}

/** A camera of VION as the server hands it to the plugin, with the sources the plugin asked for. */
function device(config: CameraConfig) {
  const made = {
    id: 'camera-in-vion',
    name: config.name,
    nativeId: config.nativeId,
    sources: config.sources!.map((s, i) => ({ ...s, _id: `source-${i}` })),
    impl: undefined as StreamingInterface | undefined,
    async implement(impl: StreamingInterface) {
      made.impl = impl;
    },
    connect() {},
  };
  return made;
}

const camera = await fakeCamera();
try {
  // found at a typed address, offered in «Найденные»
  const vion = host({ addresses: `localhost:${camera.port}` });
  vion.start();
  await until(() => vion.pushed.flat().some((c) => c.id === camera.id), 'the camera offered');
  const [offered] = await vion.plugin.onDiscoverCameras();
  assert.equal(offered?.name, 'VION Camera D00F');

  // added: the camera gives this VION its token and the RTSP access
  const config = await vion.plugin.onAdoptCamera(offered!, {});
  assert.equal(camera.pairs, 1);
  assert.equal(config.nativeId, camera.id);
  assert.deepEqual(
    config.sources!.map((s) => [s.name, s.role]),
    [
      ['main', 'high-resolution'],
      ['sub', 'low-resolution'],
    ],
  );
  assert.equal((vion.values.access as any)[camera.id].rtsp.password, camera.password, 'the RTSP access is kept');

  const added = device(config);
  await vion.plugin.configureCameras([added as never]);
  assert.equal(await added.impl!.streamUrl('source-0'), `rtsp://vion:${camera.password}@localhost:8554/main`);
  assert.equal(await added.impl!.streamUrl('source-1'), `rtsp://vion:${camera.password}@localhost:8554/sub`, 'the small stream for the small source');
  assert.deepEqual(await vion.plugin.onDiscoverCameras(), [], 'an added camera is not offered again');

  // a second VION in the network: the camera has an owner
  const other = host({ addresses: `localhost:${camera.port}` });
  other.start();
  await until(() => other.pushed.length > 0, 'the other VION sees the camera');
  await assert.rejects(other.plugin.onAdoptCamera(other.pushed[0]![0]!, {}), /remove it there, or reset it with its button/);
  assert.equal(camera.pairs, 1, 'the other VION took nothing');
  other.stop();

  // VION restarts: the camera is reached where it was seen last, the kept access works, nothing is paired anew
  vion.stop();
  const restarted = host({ ...vion.values });
  const again = device(config);
  await restarted.plugin.configureCameras([again as never]);
  assert.equal(await again.impl!.streamUrl('source-0'), `rtsp://vion:${camera.password}@localhost:8554/main`, 'before any probe');
  restarted.start();
  await restarted.plugin.onAdoptCamera({ id: camera.id, name: 'VION Camera D00F' } as DiscoveredCamera, {});
  assert.equal(camera.pairs, 1, 'added again with the kept token');

  // the button on the camera: it forgets this VION and takes a new password; adding it again pairs anew
  camera.pressReset();
  await restarted.plugin.onAdoptCamera({ id: camera.id, name: 'VION Camera D00F' } as DiscoveredCamera, {});
  assert.equal(camera.pairs, 2);
  assert.equal(await again.impl!.streamUrl('source-0'), `rtsp://vion:${camera.password}@localhost:8554/main`, 'the new password');

  // the camera at another address (typed anew here): its streams follow it
  await restarted.values.addresses;
  restarted.values.addresses = `127.0.0.1:${camera.port}`;
  await (restarted.plugin as any).probeAddresses();
  await until(() => (restarted.values.places as any)?.[camera.id] === `127.0.0.1:${camera.port}`, 'the new place kept');
  assert.equal(await again.impl!.streamUrl('source-0'), `rtsp://vion:${camera.password}@127.0.0.1:8554/main`);
  restarted.stop();

  // a camera that is not there: adding it says why
  const lonely = host({});
  await assert.rejects(lonely.plugin.onAdoptCamera({ id: 'NOPE', name: 'x' } as DiscoveredCamera, {}), /not in the network/);
  console.log('plugin.spec: found, offered, added with its token and RTSP access, both streams, a second VION refused, a restart, the button, a move — ok');
} finally {
  await camera.close();
}
