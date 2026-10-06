// The plugin as ViON drives it, against a stand-in of the board: a sensor found at a typed address, added (the board
// gives this ViON its token), kept up to date by polling, a motion too short for a poll, a board added to another
// ViON, a board that stops answering and comes back at another address, the settings sent to the board, the camera
// offered once it is on, and a firmware update from the list of versions. Then a board with the ESPectre firmware: found
// at a typed address and by its mDNS record, added without pairing, motion from its event stream, the settings, its own
// firmware update, a board that goes away, comes back and moves.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import { SensorType } from '@camera.ui/sdk';

import VionSensorPlugin from '../src/index.js';
import { espectreFromTxt } from '../src/espectre.js';
import { newer } from '../src/firmware.js';
import { fakeBoard } from './fake-board.js';
import { fakeEspectre } from './fake-espectre.js';

import type { AdoptedSensor, CameraDevice, DiscoveredCamera, JsonSchema, MotionSensor, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { FakeBoard } from './fake-board.js';
import type { FakeEspectre } from './fake-espectre.js';

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
const espectres: FakeEspectre[] = [];
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
    const board = await fakeBoard('AABBCCDDEE11');
    boards.push(board);
    const h = host({ tokens: { [board.id]: 'kept' } });
    hosts.push(h);
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
      assert.equal(live!.level, 1.5);
      assert.equal(live!.threshold, 1.4);
      assert.equal(live!.rssi, -65);
      assert.equal(live!.packetsPerS, 30);
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
    // an added board whose mDNS answer did not come again (a weak Wi-Fi, a restart of the plugin) is still polled at its
    // known address: its presence is offered all the same, from what the polls already know, without asking the board
    const { board, h } = await setup();
    board.info.firmware = '1.1.0';
    await h.plugin.onSensorAdopted(adopted(board));
    await until(() => !!(h.plugin as any).bound.get(board.id)?.info, 'the first poll');
    h.values.addresses = '';
    (h.plugin as any).finder.found.clear();
    const infos = board.calls.filter((c) => c.path === '/api/info').length;
    assert.deepEqual(
      (await h.plugin.onDiscoverSensors()).map((s) => s.id),
      [`vs:${board.id}`, `vp:${board.id}`],
      'presence of an added board not found again by mDNS',
    );
    assert.equal(board.calls.filter((c) => c.path === '/api/info').length, infos, 'no extra request to a board already polled');
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

  // ---- a board with the ESPectre firmware ----------------------------------------------------------------------------
  {
    const board = await fakeEspectre();
    espectres.push(board);
    const h = host({ addresses: board.address });
    hosts.push(h);
    launch(h);
    const offered = (await h.plugin.onDiscoverSensors()).map((s) => [s.id, s.type, s.name, s.address, s.manufacturer, s.model]);
    assert.deepEqual(offered, [[`es:${board.id}`, SensorType.Motion, 'Kitchen', board.address, 'ESPectre', 'esp32']], 'the board at the typed address is offered');

    const record: AdoptedSensor = { id: 'sensor-es', nativeId: `es:${board.id}`, address: board.address, name: 'Kitchen', type: SensorType.Motion };
    const sensor = (await h.plugin.onSensorAdopted(record)) as MotionSensor;
    await until(() => board.streams === 1 && sensor.sourceState === 'connected', 'the event stream and the first reading');
    assert.equal(board.calls.filter((c) => c.method !== 'GET').length, 0, 'adding the board changes nothing on it');

    board.motion = { state: 'motion', score: 0.91 };
    await until(() => sensor.detected, 'motion from the stream');
    board.motion = { state: 'idle', score: 0.1 };
    await until(() => !sensor.detected, 'idle from the stream');
    board.motion = { state: 'motion', score: 0.9 };
    await until(() => sensor.detected, 'motion again');
    board.pauseMotion = true;
    await until(() => !sensor.detected, 'a motion whose readings stopped ends by itself', 8_000);
    board.motion = { state: 'idle', score: 0.1 };
    board.pauseMotion = false;
    await until(() => sensor.sourceState === 'connected', 'readings again');

    // calibrating: whatever the detector says, no motion, and the sensor is not lost
    board.pauseMotion = true;
    Object.assign(board.sensing, { calibrating: true, ready: false });
    board.emit('sensing', board.sensing);
    board.emit('motion', { timestamp_ms: 4, state: 'motion', score: 0.95 });
    await sleep(300);
    assert.equal(sensor.detected, false, 'no motion while the board calibrates');
    assert.equal(sensor.sourceState, 'connected', 'calibrating is not an outage');
    // not ready and not calibrating (no packets from the router): unknown, not quiet
    board.sensing.calibrating = false;
    board.emit('sensing', board.sensing);
    await until(() => sensor.sourceState === 'unavailable', 'not ready: unknown');
    board.sensing.ready = true;
    board.emit('sensing', board.sensing);
    await until(() => sensor.sourceState === 'connected', 'ready again');
    await sleep(300);
    assert.equal(sensor.detected, false, 'a reading taken while the board calibrated is not motion once it is ready');
    board.pauseMotion = false;

    // the settings go to the board, and the form shows what the board took
    for (const key of ['detector', 'threshold', 'motionOnHits', 'motionOffHits', 'traffic']) {
      assert.equal(field(sensor, key).store, false, `${key} is the board's: not stored, or a stored value would hide the board's`);
    }
    assert.equal(field(sensor, 'threshold').defaultValue, 0.66, 'the threshold shows the board value');
    await field(sensor, 'threshold').onSet!(0.5, 0.66);
    assert.deepEqual(board.calls.find((c) => c.method === 'PATCH')?.body, { threshold: 0.5 }, 'only the threshold is sent');
    assert.equal(field(sensor, 'threshold').defaultValue, 0.5);
    await field(sensor, 'detector').onSet!('high_accuracy', 'lightweight');
    assert.equal(board.sensing.detector, 'high_accuracy', 'the neural network detector is chosen on the board');
    await field(sensor, 'motionOnHits').onSet!(3, 2);
    assert.deepEqual([board.sensing.motion_on_hits, board.sensing.motion_off_hits], [3, 4], 'the start count changed, the end count kept');
    await field(sensor, 'motionOffHits').onSet!(6, 4);
    assert.deepEqual([board.sensing.motion_on_hits, board.sensing.motion_off_hits], [3, 6], 'the end count changed, the start count kept');
    // one save of both counts: the host calls both at the same time, and neither may be lost
    await Promise.all([field(sensor, 'motionOnHits').onSet!(5, 3), field(sensor, 'motionOffHits').onSet!(7, 6)]);
    assert.deepEqual([board.sensing.motion_on_hits, board.sensing.motion_off_hits], [5, 7], 'both counts of one save reached the board');
    await field(sensor, 'traffic').onSet!('dns', 'ping');
    assert.equal(board.sensing.traffic_generator_mode, 'dns');
    await assert.rejects(field(sensor, 'threshold').onSet!(1.5, 0.5), /out of range/, 'a refused setting fails with the reason of the board');
    assert.equal(field(sensor, 'threshold').defaultValue, 0.5, 'and the form shows the value the board kept');
    await field(sensor, 'calibrate').onSet!(undefined, undefined);
    assert.ok(
      board.calls.some((c) => c.method === 'POST' && c.path === '/sensing/calibrations'),
      'calibration asked',
    );
    board.busy = true;
    await assert.rejects(field(sensor, 'calibrate').onSet!(undefined, undefined), /already running/, 'a busy board says so in words');
    board.busy = false;

    // its own firmware, from the ESPectre releases
    await field(sensor, 'checkUpdate').onSet!(undefined, undefined);
    assert.ok(
      board.calls.some((c) => c.path === '/ota/checks'),
      'the check asked',
    );
    board.ota = { ...board.ota, state: 'update_available', update_available: true, target_version: '3.0.0' };
    board.emit('ota', board.ota);
    await until(() => sensor.storageSchema.some((f) => f.key === 'update'), 'the update button');
    assert.match(String(field(sensor, 'update').title), /3\.0\.0/);
    assert.ok(
      h.lines.some((l) => l.includes('ESPectre 3.0.0 is out')),
      'the new firmware is told',
    );
    await field(sensor, 'update').onSet!(undefined, undefined);
    assert.ok(
      board.calls.some((c) => c.method === 'POST' && c.path === '/ota/updates'),
      'the update asked',
    );

    // the floor plan: the probability over the threshold, against 1, and the signal as it is now, from the cache
    const espectreBound = (h.plugin as any).espectre.get(board.id);
    board.motion = { state: 'motion', score: 0.75 };
    board.wifi.rssi_dbm = -85;
    await until(() => sensor.detected && espectreBound.last?.score === 0.75, 'motion for the plan');
    await (h.plugin as any).refreshEspectre(espectreBound);
    const live = (await h.plugin.vionSensorLive()).find((l) => l.sensorId === 'sensor-es')!;
    assert.deepEqual(
      [live.state, live.level, live.threshold, live.rssi, live.packetsPerS, live.presence, live.radar, live.cameraId],
      ['motion', 1.5, 1, -85, 97.5, null, null, null],
    );
    board.motion = { state: 'idle', score: 0.1 };

    // the board goes away: unavailable once its stream stays closed, back by itself
    board.setDown(true);
    await until(() => sensor.sourceState === 'unavailable' && !sensor.detected, 'unavailable once the stream stays closed', 9_000);
    assert.equal((await h.plugin.vionSensorLive()).find((l) => l.sensorId === 'sensor-es')!.state, 'offline');
    assert.ok(
      h.lines.some((l) => l.includes('Kitchen does not answer')),
      'the loss is told',
    );
    board.setDown(false);
    await until(() => sensor.sourceState === 'connected', 'the sensor is back', 15_000);
    assert.ok(h.lines.some((l) => l.includes('Kitchen is back')));

    // the power goes: nothing is closed, the sockets just hang, and the board must not stay "quiet" for long
    board.motion = { state: 'motion', score: 0.9 };
    await until(() => sensor.detected, 'motion before the power goes');
    const silentAt = Date.now();
    board.silent = true;
    await until(() => sensor.sourceState === 'unavailable', 'a silent board is unavailable', 20_000);
    assert.equal(sensor.detected, false, 'and its last motion is over');
    assert.ok(Date.now() - silentAt < 16_000, `unavailable after ${Date.now() - silentAt} ms, not the half-minute of the socket`);
    board.silent = false;
    board.motion = { state: 'idle', score: 0.1 };
    await until(() => sensor.sourceState === 'connected', 'back after the silence', 20_000);

    // the router gave the address to another board: its readings and settings are not this sensor's
    board.device = { ...board.device, device_id: 'ffffffffffffffff', name: 'Hall' };
    board.setDown(true);
    board.setDown(false);
    await until(() => sensor.sourceState === 'unavailable', 'another board at the address: unknown', 9_000);
    assert.ok(
      h.lines.some((l) => l.includes('now answers as another ESPectre board, Hall')),
      'the stranger is told',
    );
    board.motion = { state: 'motion', score: 0.99 };
    await sleep(600);
    assert.equal(sensor.detected, false, 'the motion of the other board is not this sensor');
    const before = board.sensing.threshold;
    await assert.rejects(field(sensor, 'threshold').onSet!(0.3, 0.5), /not reachable/, 'its settings do not go to the other board');
    assert.equal(board.sensing.threshold, before);
    assert.equal(board.streams, 0, 'no stream to the other board');
    // the board itself is back at its address: found again, followed
    board.device = { ...board.device, device_id: board.id, name: 'Kitchen' };
    board.motion = { state: 'idle', score: 0.1 };
    await (h.plugin as any).probeAddresses();
    await until(() => sensor.sourceState === 'connected' && board.streams === 1, 'the sensor is back on its own board', 9_000);

    // it moves to another address: the sensor follows
    const moved = await fakeEspectre(board.id);
    espectres.push(moved);
    await board.close();
    h.values.addresses = moved.address;
    await (h.plugin as any).probeAddresses();
    await until(() => moved.streams === 1, 'the stream opens at the new address', 15_000);
    moved.motion = { state: 'motion', score: 0.8 };
    await until(() => sensor.detected && sensor.sourceState === 'connected', 'motion from the new address');
    assert.ok(
      h.lines.some((l) => l.includes(`now at ${moved.address}`)),
      'the move is told',
    );

    // removed: its stream is closed and it leaves the plan
    await h.plugin.onSensorUnadopted(`es:${board.id}`);
    await until(() => moved.streams === 0, 'the stream closed after the removal');
    assert.deepEqual(await h.plugin.vionSensorLive(), []);
    console.log('espectre: found, added, stream motion, stale motion, calibrating, not ready, settings, firmware, plan, lost, silent, stranger, moved, removed OK');
  }
  {
    // what the network announces is asked first, and nothing is left running for a sensor that could not be added
    const board = await fakeEspectre('0123456789abcdef');
    // two Micro-ESPectre boards: one whose record says so, one whose record is older than its firmware
    const micro = await fakeEspectre('cccccccccccccccc');
    const microAnnounced = await fakeEspectre('eeeeeeeeeeeeeeee');
    micro.device.frontend = microAnnounced.device.frontend = 'micro';
    espectres.push(board, micro, microAnnounced);
    const h = host({});
    hosts.push(h);
    launch(h);
    const finder = (h.plugin as any).finder;
    finder.rememberEspectre({ id: board.id, address: board.address, name: 'Kitchen', frontend: 'native' });
    finder.rememberEspectre({ id: 'aaaaaaaaaaaaaaaa', address: '127.0.0.1:1', name: 'Gone', frontend: 'native' });
    finder.rememberEspectre({ id: 'bbbbbbbbbbbbbbbb', address: board.address, name: 'Old record', frontend: 'native' });
    finder.rememberEspectre({ id: micro.id, address: micro.address, name: 'Micro', frontend: 'native' });
    finder.rememberEspectre({ id: microAnnounced.id, address: microAnnounced.address, name: 'Micro announced', frontend: 'micro' });
    assert.deepEqual(
      (await h.plugin.onDiscoverSensors()).map((s) => s.id),
      [`es:${board.id}`],
      'only a board that answers as itself is offered: not a gone one, not another one at its address, not a Micro',
    );
    assert.equal(microAnnounced.calls.length, 0, 'a board announced as Micro is not even asked');
    await assert.rejects(
      h.plugin.onSensorAdopted({ id: 'ghost', nativeId: 'es:dddddddddddddddd', name: 'Ghost', type: SensorType.Motion } as AdoptedSensor),
      /not in the network now/,
    );
    assert.equal((h.plugin as any).espectre.size, 0, 'nothing runs for a sensor that was not added');
    // after a restart of ViON the record has the host alone, as the sensor showed it: the board is asked on its port
    const restored = (await h.plugin.configureAdoptedSensors([
      { id: 'restored', nativeId: 'es:dddddddddddddddd', address: '192.168.10.110', name: 'Restored', type: SensorType.Motion } as AdoptedSensor,
    ])) as MotionSensor[];
    assert.equal((h.plugin as any).espectre.get('dddddddddddddddd').client.address, '192.168.10.110:62587', 'the port of ESPectre is added');
    await h.plugin.onSensorUnadopted(restored[0]!.nativeId);
    console.log('espectre: announced boards checked, nothing left after a refused add OK');
  }
  {
    // the mDNS record of an ESPectre board, by its discovery rules: anything else is another protocol or not ESPectre
    const txt = {
      txtvers: '1',
      protovers: '1.0',
      device_id: '3cf79180d3a0aca4',
      name: 'Kitchen',
      frontend: 'native',
      transport: 'http',
      path: '/espectre/v1',
      firmware: '3.0.0-rc3',
      chip: 'esp32',
    };
    const expected = { id: '3cf79180d3a0aca4', address: '192.168.10.110:62587', name: 'Kitchen', firmware: '3.0.0-rc3', chip: 'esp32', frontend: 'native' };
    assert.deepEqual(espectreFromTxt(txt, '192.168.10.110', 62587, 'svc'), expected);
    assert.deepEqual(espectreFromTxt({ ...txt, path: Buffer.from('/espectre/v1') }, '192.168.10.110', 62587, 'svc'), expected, 'a value given as bytes');
    assert.deepEqual(
      espectreFromTxt(Object.fromEntries(Object.entries(txt).map(([k, v]) => [k.toUpperCase(), v])), '192.168.10.110', 62587, 'svc'),
      expected,
      'keys in any case',
    );
    for (const [key, bad] of [
      ['txtvers', '2'],
      ['protovers', '2.0'],
      ['transport', 'https'],
      ['path', '/espectre/v2'],
      ['device_id', '3CF79180D3A0ACA4'],
      ['device_id', 'abc'],
      ['frontend', 'other'],
    ]) {
      assert.equal(espectreFromTxt({ ...txt, [key!]: bad }, '192.168.10.110', 62587, 'svc'), undefined, `${key}=${bad} is refused`);
    }
    assert.equal(espectreFromTxt(txt, 'fe80::1', 62587, 'svc'), undefined, 'an IPv6-only answer is skipped');
    assert.equal(espectreFromTxt(txt, '192.168.10.110', 0, 'svc'), undefined, 'no port, no endpoint');
    assert.equal(espectreFromTxt({ ...txt, name: '' }, '192.168.10.110', 62587, 'svc')!.name, 'svc', 'no name: the service name');
    console.log('espectre: mDNS record rules OK');
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
  for (const board of espectres) await board.close();
}
