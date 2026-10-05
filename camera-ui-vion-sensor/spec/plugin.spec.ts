// The plugin as ViON drives it, against a stand-in of the board: a sensor found at a typed address, added (the board
// gives this ViON its token), kept up to date by polling, a motion too short for a poll, a board added to another
// ViON, a board that stops answering and comes back at another address, the settings sent to the board, the camera
// offered once it is on, and a firmware update from the list of versions.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import { SensorType } from '@camera.ui/sdk';

import VionSensorPlugin from '../src/index.js';
import { newer } from '../src/firmware.js';
import { fakeBoard } from './fake-board.js';

import type { AdoptedSensor, CameraDevice, DiscoveredCamera, JsonSchema, MotionSensor, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { FakeBoard } from './fake-board.js';

const silent = { log() {}, warn() {}, success() {}, debug() {}, trace() {}, attention() {}, error() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(20);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

function host(values: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => unknown>();
  const pushed: DiscoveredCamera[][] = [];
  const lines: string[] = [];
  const logger = {
    ...silent,
    log: (...a: unknown[]) => lines.push(a.join(' ')),
    warn: (...a: unknown[]) => lines.push(a.join(' ')),
    error: (...a: unknown[]) => lines.push(a.join(' ')),
  };
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
    on(event: string, listener: () => unknown) {
      listeners.set(event, listener);
      return api;
    },
    deviceManager: {
      async pushDiscoveredCameras(cameras: DiscoveredCamera[]) {
        pushed.push(cameras);
      },
    },
  };
  const plugin = new VionSensorPlugin(logger as never, api as never, storage as never);
  // the plugin looks for boards by mDNS too; the test network has none, and no sockets should stay open after it
  (plugin as any).finder.start = () => {};
  return {
    plugin,
    values,
    pushed,
    lines,
    start: () => listeners.get('finishLaunching')?.() ?? listeners.get('FINISH_LAUNCHING')?.(),
    stop: () => listeners.get('shutdown')?.() ?? listeners.get('SHUTDOWN')?.(),
    listeners,
  };
}

function launch(h: ReturnType<typeof host>): void {
  // whichever name the SDK gives the event, the plugin subscribed to exactly one start and one stop
  const [start, stop] = [...h.listeners.values()];
  (h as any).stopFn = stop;
  start!();
}

function field(sensor: MotionSensor, key: string): JsonSchema & Record<string, any> {
  const found = sensor.storageSchema.find((f) => f.key === key);
  assert.ok(found, `field ${key}`);
  return found as JsonSchema & Record<string, any>;
}

function adopted(board: FakeBoard, name = 'Hall'): AdoptedSensor {
  return { id: 'sensor-1', nativeId: `vs:${board.id}`, address: board.address, name, type: SensorType.Motion };
}

const boards: FakeBoard[] = [];
const hosts: ReturnType<typeof host>[] = [];
async function setup(values: Record<string, unknown> = {}) {
  const board = await fakeBoard();
  boards.push(board);
  const h = host({ addresses: board.address, ...values });
  hosts.push(h);
  launch(h);
  return { board, h };
}

try {
  // ---- cached floor-plan telemetry: real registry IDs, all states, and no board I/O ----------------------------------
  {
    const board = await fakeBoard('AABBCCDDEE11'); boards.push(board);
    const h = host({ tokens: { [board.id]: 'kept' } }); hosts.push(h);
    await h.plugin.configureAdoptedSensors([adopted(board)]);
    const bound = (h.plugin as any).bound.get(board.id);
    const state = { ...board.state, score: 3, baseline: 2, threshold: 1.4, rssi: -65, packets_per_s: 30 };
    const calls = board.calls.length;
    for (const expected of ['quiet', 'motion', 'calibrating', 'blind', 'offline'] as const) {
      bound.state = { ...state, motion: expected === 'motion', calibrating: expected === 'calibrating', calibration_left_s: 17, blind: expected === 'blind' };
      bound.motion = expected === 'motion';
      bound.failures = expected === 'offline' ? 3 : 0;
      const [live] = await h.plugin.vionSensorLive();
      assert.equal(live!.sensorId, 'sensor-1', 'the public ID is the adopted registry ID, not vs:board or a runtime UUID');
      assert.equal(live!.state, expected, `cached state: ${expected}`);
      assert.equal(live!.calibrationLeftS, expected === 'calibrating' ? 17 : 0);
      assert.equal(live!.level, 1.5); assert.equal(live!.threshold, 1.4); assert.equal(live!.rssi, -65); assert.equal(live!.packetsPerS, 30);
      assert.equal(live!.cameraId, null);
    }
    const camera = { id: 'attached-camera', nativeId: board.id, name: 'Sensor camera', implement: async () => {}, connect() {} } as unknown as CameraDevice;
    await h.plugin.onCameraAdded(camera);
    assert.equal((await h.plugin.vionSensorLive())[0]!.cameraId, camera.id);
    await h.plugin.onCameraReleased(camera.id);
    await h.plugin.configureCameras([camera]);
    assert.equal((await h.plugin.vionSensorLive())[0]!.cameraId, camera.id, 'restored cameras are linked too');
    assert.equal(board.calls.length, calls, 'telemetry makes no board requests');
    await h.plugin.onSensorUnadopted(`vs:${board.id}`);
    assert.deepEqual(await h.plugin.vionSensorLive(), []);
    console.log('presence live: five cached states, registry ID, camera restore and zero board requests OK');
  }
  // ---- found, added, kept up to date ----------------------------------------------------------------------------------
  {
    const { board, h } = await setup();
    const offered = await h.plugin.onDiscoverSensors();
    assert.deepEqual(
      offered.map((s) => [s.id, s.type, s.name, s.address]),
      [[`vs:${board.id}`, SensorType.Motion, 'ViON Sensor EEFF', board.address]],
      'the board at the typed address is offered as a motion sensor',
    );

    const sensor = (await h.plugin.onSensorAdopted(adopted(board))) as MotionSensor;
    assert.equal(board.token, 'token-aabbccddeeff', 'adding the sensor pairs the board');
    assert.deepEqual(h.values.tokens, { [board.id]: board.token }, 'the token is kept for the next start');

    await until(() => sensor.sourceState === 'connected', 'the first poll');
    assert.equal(sensor.detected, false);
    board.state.motion = true;
    board.state.events = 1;
    await until(() => sensor.detected, 'motion on');
    board.state.motion = false;
    await until(() => !sensor.detected, 'motion off');

    // a motion that began and ended between two polls: the counter moved, the flag is down again
    board.state.events = 2;
    await until(() => sensor.detected, 'the pulse of a missed motion');
    await until(() => !sensor.detected, 'the end of the pulse', 4_000);

    // the board calibrates: whatever it says about motion, nothing is reported
    board.state.calibrating = true;
    board.state.motion = true;
    await sleep(1_500);
    assert.equal(sensor.detected, false, 'no motion while the board calibrates');
    board.state.calibrating = false;
    board.state.motion = false;

    // the settings of the sensor go to the board
    assert.equal(field(sensor, 'threshold').defaultValue, 1.4, 'the threshold shows the board value');
    await field(sensor, 'threshold').onSet!(1.8, 1.4);
    assert.equal(board.info.config.threshold, 1.8, 'the threshold reached the board');
    await field(sensor, 'recalibrate').onSet!(undefined, undefined);
    assert.ok(
      board.calls.some((c) => c.path === '/api/recalibrate' && c.auth === `Bearer ${board.token}`),
      'calibration asked with the token',
    );

    // a refused setting is shown as the board has it, and the error reaches the form
    await assert.rejects(
      field(sensor, 'holdS').onSet!(5, 8).then(async () => {
        board.down = true;
        await field(sensor, 'holdS').onSet!(9, 5);
      }),
      /not reachable/,
      'a setting the board did not take fails visibly',
    );
    board.down = false;

    // ---- the board goes away and comes back at another address --------------------------------------------------------
    board.down = true;
    await until(() => sensor.sourceState === 'unavailable', 'unavailable after three lost polls');
    const moved = await fakeBoard(board.id);
    boards.push(moved);
    moved.token = board.token;
    moved.state.motion = true;
    moved.state.events = 5;
    h.values.addresses = moved.address;
    await (h.plugin as any).probeAddresses();
    await until(() => sensor.sourceState === 'connected' && sensor.detected, 'the sensor follows the board to its new address');
    assert.ok(
      h.lines.some((l) => l.includes(`now at ${moved.address}`)),
      'the move is logged',
    );

    // ---- the camera, once it is on ------------------------------------------------------------------------------------
    assert.deepEqual(await h.plugin.onDiscoverCameras(), [], 'no camera offered while it is off');
    moved.state.motion = false;
    await field(sensor, 'camera').onSet!(true, false);
    assert.equal(moved.info.camera.state, 'on');
    await until(() => (h.plugin as any).bound.get(board.id).info.camera.state === 'on', 'the plugin knows the camera is on');
    const cameras = await h.plugin.onDiscoverCameras();
    assert.deepEqual(
      cameras.map((c) => c.id),
      [`vs-cam:${board.id}`],
      'the camera is offered',
    );
    const config = await h.plugin.onAdoptCamera(cameras[0]!, {});
    assert.equal(config.nativeId, board.id);
    let implemented: (StreamingInterface & SnapshotInterface) | undefined;
    const device = { id: 'cam-1', nativeId: board.id, name: 'Hall', implement: async (i: any) => (implemented = i), connect() {} } as unknown as CameraDevice;
    await h.plugin.onCameraAdded(device);
    assert.equal(await implemented!.streamUrl('s'), `ffmpeg:http://127.0.0.1:81/stream?token=${board.token}#video=h264`, 'the stream of the board, with its token');
    const jpeg = new Uint8Array((await implemented!.snapshot('s'))!);
    assert.deepEqual([...jpeg.slice(0, 2)], [0xff, 0xd8], 'the snapshot is the JPEG of the board');
    assert.deepEqual(await h.plugin.onDiscoverCameras(), [], 'an added camera is not offered again');

    // ---- firmware from the list of versions -----------------------------------------------------------------------
    // a board flashed by USB with a build newer than the list: an update button would do nothing, so there is none
    moved.manifest = { version: '0.9.0', url: 'sensor-0.9.0.bin', sha256: 'b'.repeat(64) };
    h.values.manifestUrl = `http://${moved.address}/manifest.json`;
    await (h.plugin as any).checkFirmware();
    assert.ok(!sensor.storageSchema.some((f) => f.key === 'update'), 'no update button for an older firmware');

    moved.manifest = { version: '1.1.0', url: 'sensor-1.1.0.bin', sha256: 'a'.repeat(64), notes: 'Quicker calibration' };
    await (h.plugin as any).checkFirmware();
    await until(() => sensor.storageSchema.some((f) => f.key === 'update'), 'the update button');
    assert.match(String(field(sensor, 'update').title), /1\.1\.0/);
    await field(sensor, 'update').onSet!(undefined, undefined);
    const update = moved.calls.find((c) => c.path === '/api/update');
    assert.deepEqual(update?.body, { url: `http://${moved.address}/sensor-1.1.0.bin`, sha256: 'a'.repeat(64) }, 'the board is told where the file is and its checksum');

    // ---- reset: the board forgets this ViON ---------------------------------------------------------------------------
    await field(sensor, 'reset').onSet!(undefined, undefined);
    assert.equal(moved.token, undefined, 'the board forgot the token');
    assert.deepEqual(h.values.tokens, {}, 'and so did the plugin');
    await h.plugin.onSensorUnadopted(`vs:${board.id}`);
  }

  // ---- presence (firmware 1.1.0): a second sensor, the motion source, the radar, a failed update -----------------------
  {
    const { board, h } = await setup();
    board.info.firmware = '1.1.0';
    const presenceState = { present: false, ready: false, training: true, training_left_s: 20, trained: false, level: 0, wander: 0.01 };
    Object.assign(board.state, {
      presence: { ...presenceState, wander_threshold: 0, jitter: 0, jitter_threshold: 0, motion: false, windows_per_s: 5, sensitivity: 0.25 },
      ld2450: { connected: false, targets: [] },
    });
    const offered = () => h.plugin.onDiscoverSensors().then((list) => list.map((s) => [s.id, s.type]));
    assert.deepEqual(await offered(), [[`vs:${board.id}`, SensorType.Motion]], 'presence is not offered before its motion sensor is added');
    await assert.rejects(
      h.plugin.onSensorAdopted({ id: 'presence-1', nativeId: `vp:${board.id}`, address: board.address, name: 'Hall presence', type: SensorType.Occupancy }),
      /motion sensor of Hall presence first/,
      'presence alone is refused with the reason',
    );
    const motion = (await h.plugin.onSensorAdopted(adopted(board))) as MotionSensor;
    await until(() => motion.sourceState === 'connected', 'the first poll');
    assert.deepEqual(
      await offered(),
      [
        [`vs:${board.id}`, SensorType.Motion],
        [`vp:${board.id}`, SensorType.Occupancy],
      ],
      'with motion added, the board offers its presence',
    );
    const presence = (await h.plugin.onSensorAdopted({
      id: 'presence-1',
      nativeId: `vp:${board.id}`,
      address: board.address,
      name: 'Hall presence',
      type: SensorType.Occupancy,
    })) as unknown as { sourceState?: string; detected: boolean };
    assert.deepEqual(await offered(), [[`vs:${board.id}`, SensorType.Motion]], 'an added presence is not offered again');

    // learning, then not learned: presence is unknown, and it is said once
    await until(() => presence.sourceState === 'unavailable', 'presence unknown while learning');
    board.state.presence.training = false;
    await until(() => h.lines.some((l) => l.includes('presence did not learn the empty room')), 'the warning about the learning');
    await sleep(1_200);
    assert.equal(h.lines.filter((l) => l.includes('presence did not learn')).length, 1, 'said once, not every poll');
    assert.equal(presence.sourceState, 'unavailable', 'not learned: unknown, not "nobody"');

    // learned: somebody stands in the room
    Object.assign(board.state.presence, { trained: true, ready: true, present: true, level: 0.004, wander_threshold: 0.002 });
    await until(() => presence.sourceState === 'connected' && presence.detected, 'presence on');
    board.state.presence.present = false;
    await until(() => !presence.detected, 'presence off');
    board.state.blind = true;
    await until(() => presence.sourceState === 'unavailable', 'no packets: presence unknown');
    board.state.blind = false;

    // the motion source: ViON by default, Espressif or either when chosen
    assert.equal(field(motion, 'motionSource').defaultValue, 'vion');
    board.state.presence.motion = true;
    await sleep(1_200);
    assert.equal(motion.detected, false, 'Espressif motion alone does not count while the source is ViON');
    await field(motion, 'motionSource').onSet!('espressif', 'vion');
    await until(() => motion.detected, 'motion from Espressif');
    assert.deepEqual(h.values.motionSources, { [board.id]: 'espressif' }, 'the choice is kept for the next start');
    board.state.presence.motion = false;
    board.state.motion = true;
    await until(() => !motion.detected, 'ViON motion alone does not count while the source is Espressif');
    await field(motion, 'motionSource').onSet!('any', 'espressif');
    await until(() => motion.detected, 'either algorithm');
    board.state.motion = false;
    await until(() => !motion.detected, 'motion off');

    // presence sensitivity goes to the board
    await field(motion, 'presenceSensitivity').onSet!(0.4, 0.25);
    assert.equal(board.info.config.presence_sensitivity, 0.4, 'the presence sensitivity reached the board');

    // the radar and presence reach the floor plan from the cache
    board.state.ld2450 = { connected: true, targets: [{ x: -782, y: 1713, speed: -16 }] };
    board.state.presence.present = true;
    await until(() => presence.detected, 'presence on again');
    const [live] = await h.plugin.vionSensorLive();
    assert.deepEqual(live!.radar, { targets: [{ x: -782, y: 1713, speed: -16 }] }, 'the radar targets as the board gave them');
    assert.deepEqual(live!.presence, { state: 'present', level: 0.004, threshold: 0.002 });
    board.state.ld2450 = { connected: false, targets: [] };
    await sleep(1_200);
    assert.equal((await h.plugin.vionSensorLive())[0]!.radar, null, 'a radar that went quiet is none, not its last people');

    // a firmware that did not start: said once and shown in the settings
    board.info.update_failed = '1.1.1';
    board.state.uptime_s = 2; // a restart: the plugin reads the info again
    await until(() => h.lines.some((l) => l.includes('firmware 1.1.1 did not start')), 'the failed update is told');
    await until(() => motion.storageSchema.some((f) => f.key === 'updateFailed'), 'the failed update in the settings');
    assert.match(String(field(motion, 'updateFailed').defaultValue), /1\.1\.1 did not start: the board runs 1\.1\.0/);
    await sleep(1_200);
    assert.equal(h.lines.filter((l) => l.includes('firmware 1.1.1 did not start')).length, 1, 'told once');

    // the motion sensor removed: presence is unknown; presence removed: offered again once motion is back
    await h.plugin.onSensorUnadopted(`vs:${board.id}`);
    assert.equal(presence.sourceState, 'unavailable');
    await h.plugin.onSensorUnadopted(`vp:${board.id}`);
    console.log('presence: second sensor, learning, motion source, sensitivity, radar, failed update OK');
  }
  {
    // a board with an older firmware has no presence to offer
    const { board, h } = await setup();
    await h.plugin.onSensorAdopted(adopted(board));
    assert.deepEqual(
      (await h.plugin.onDiscoverSensors()).map((s) => s.id),
      [`vs:${board.id}`],
      'firmware 1.0.0: motion only',
    );
    await until(() => !!(h.plugin as any).bound.get(board.id)?.state, 'the first poll');
    const [live] = await h.plugin.vionSensorLive();
    assert.equal(live!.presence, null);
    assert.equal(live!.radar, null);
  }

  // ---- a board added to another ViON ----------------------------------------------------------------------------------
  {
    const { board, h } = await setup();
    board.token = 'someone-else';
    assert.deepEqual(await h.plugin.onDiscoverSensors(), [], 'a board of another ViON is not offered');
    await assert.rejects(h.plugin.onSensorAdopted(adopted(board)), /another ViON/, 'adding it says why it cannot be added');
  }

  // ---- a start with sensors already added -----------------------------------------------------------------------------
  {
    const board = await fakeBoard('112233445566');
    boards.push(board);
    board.token = 'kept-token';
    board.state.motion = true;
    board.state.events = 1;
    const h = host({ addresses: board.address, tokens: { [board.id]: 'kept-token' } });
    hosts.push(h);
    const [sensor] = (await h.plugin.configureAdoptedSensors([adopted(board)])) as MotionSensor[];
    launch(h);
    await until(() => sensor!.detected, 'a sensor added before the start reports motion with the kept token');
    assert.equal(board.calls.filter((c) => c.path === '/api/pair').length, 0, 'no new pairing on a start');
  }

  // ---- versions -------------------------------------------------------------------------------------------------------
  assert.equal(newer('1.0.10', '1.0.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('0.9.9', '1.0.0'), false);
  assert.equal(newer('garbage', '1.0.0'), false);

  console.log('plugin: found, added, polled, missed motion, calibration, settings, moved board, camera, firmware, reset, another ViON, restart OK');
} finally {
  for (const h of hosts) (h as any).stopFn?.();
  for (const board of boards) await board.close();
}
