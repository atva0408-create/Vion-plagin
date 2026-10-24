// After «Reconnect» or a change of the sign-in the camera said «Connected to ONVIF device» and never «Started ONVIF
// event listening» again: the old loop was stopped on the old connection alone, the flag stayed up, and motion and
// objects from the camera were gone until the plugin restarted; a second PTZ sensor was made each time, the first one
// polling the old connection five times a second for good (VION audit 2026-10-23, F2).
// Run: npx tsx spec/reconnect.spec.ts
import assert from 'node:assert/strict';

import { OnvifCamera } from '../src/camera.js';

function connection(name: string) {
  const calls: string[] = [];
  return {
    name,
    calls,
    events: {
      on() {},
      startEventLoop() {
        calls.push('start');
      },
      stopEventLoop() {
        calls.push('stop');
      },
    },
  };
}

const oldConnection = connection('old');
const newConnection = connection('new');
const capabilities = { hasPTZ: true, hasEvents: true, advertisedTypes: ['motion'], eventProperties: undefined };
const added: unknown[] = [];
const rebound: unknown[] = [];
const said: string[] = [];
const logger = { log: (message: unknown) => void said.push(String(message)), debug() {}, warn() {}, error() {}, trace() {} };

const camera = Object.create(OnvifCamera.prototype) as Record<string, unknown> & { doReconnect(): Promise<void>; eventLoopRunning: boolean };
Object.assign(camera, {
  camera: { name: 'Двор', logger, connect() {}, addSensor: async (sensor: unknown) => void added.push(sensor) },
  logger,
  storage: { values: { url: 'http://cam.local', username: 'admin', password: 'new-one' } },
  device: oldConnection,
  eventLoopRunning: true,
  capabilities,
  motionSensor: { isAssigned: true, onAssignmentChanged: { subscribe() {} } },
  ptzSensor: { isAssigned: false, rebind: (device: unknown) => void rebound.push(device), onAssignmentChanged: { subscribe() {} }, initialize: async () => undefined },
  dynamicCapabilities: new Set(),
  retrying: false,
  destroyed: false,
  connectToDevice: async () => newConnection,
  detectCapabilities: async () => capabilities,
});

await camera.doReconnect();

assert.deepEqual(oldConnection.calls, ['stop'], 'the loop of the old connection ends');
assert.deepEqual(newConnection.calls, ['start'], 'the new connection listens for events: the motion sensor is still assigned');
assert.equal(camera.eventLoopRunning, true);
assert.ok(said.some((line) => line.startsWith('Started ONVIF event listening')));
assert.deepEqual(rebound, [newConnection], 'the PTZ sensor follows the connection');
assert.deepEqual(added, [], 'no second sensor of any kind');

console.log('reconnect.spec: events listened again, the sensors kept OK');
