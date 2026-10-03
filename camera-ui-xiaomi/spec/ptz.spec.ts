// Pan and tilt of a Xiaomi camera: the plugin's own P2P session with the camera (the search, TCP or UDP, the sign-in,
// encrypted motor commands) against a stand-in camera on this machine, and the PTZ control the player drives: a held
// arrow steps until it is let go, a session is shared by the steps and closed when unused, failures are said.
// Run: npx tsx spec/ptz.spec.ts
import assert from 'node:assert/strict';

import { XiaomiPtz, stepOf } from '../src/ptz.js';
import { MissSession, MotorStep, parseAnswer } from '../src/xiaomi/miss.js';
import { generateKeyPair } from '../src/xiaomi/keys.js';
import { SIGN, fakeCamera } from './fake-camera.js';

import type { MotorAnswer } from '../src/xiaomi/miss.js';
import type { FakeCamera, FakeCameraOptions } from './fake-camera.js';

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms && !condition(); waited += 10) await sleep(10);
  assert.ok(condition(), 'the awaited step did not come');
}

/** Keys as the cloud hands them out for a connection: a new pair of ours, the camera's public key and the signature. */
function keysFor(camera: FakeCamera, sign = SIGN) {
  const own = generateKeyPair();
  return { client_public: own.publicKey, client_private: own.privateKey, device_public: camera.devicePublic, sign, vendor: 'cs2' };
}

async function withCamera(options: FakeCameraOptions, fn: (camera: FakeCamera) => Promise<void>): Promise<void> {
  const camera = await fakeCamera(options);
  try {
    await fn(camera);
  } finally {
    await camera.close();
  }
}

function recorder() {
  const lines: Record<string, string[]> = {};
  const level =
    (name: string) =>
    (...args: unknown[]) =>
      (lines[name] ??= []).push(args.map(String).join(' '));
  return { lines, logger: { log: level('log'), error: level('error'), warn: level('warn'), debug: level('debug'), trace: () => {}, attention: () => {} } };
}

test('a step reaches the camera as the motor command of the Mi Home app, and its answer comes back', async () => {
  await withCamera({}, async (camera) => {
    const answers: MotorAnswer[] = [];
    const session = await MissSession.open('127.0.0.1', keysFor(camera), (answer) => answers.push(answer));
    try {
      assert.equal(session.transport, 'tcp');
      await session.move(MotorStep.Right);
      await session.move(MotorStep.Up);
      await until(() => camera.operations.length === 2 && answers.length === 2);
      assert.deepEqual(camera.operations, [2, 3]);
      assert.deepEqual(answers[0], { ret: 0, angle: 41, elevation: 10 });
      assert.equal(camera.auths[0].sign, SIGN);
    } finally {
      session.close();
    }
  });
});

test('over UDP as well, where every message is acknowledged', async () => {
  await withCamera({ transport: 'udp' }, async (camera) => {
    const answers: MotorAnswer[] = [];
    const session = await MissSession.open('127.0.0.1', keysFor(camera), (answer) => answers.push(answer));
    try {
      assert.equal(session.transport, 'udp');
      await session.move(MotorStep.Left);
      await until(() => answers.length === 1);
      assert.deepEqual(camera.operations, [1]);
    } finally {
      session.close();
    }
  });
});

test('several answers to one step are all read, none is taken for the next step', async () => {
  await withCamera({ answersPerStep: 3 }, async (camera) => {
    const answers: MotorAnswer[] = [];
    const session = await MissSession.open('127.0.0.1', keysFor(camera), (answer) => answers.push(answer));
    try {
      await session.move(MotorStep.Down);
      await session.move(MotorStep.Down);
      await until(() => answers.length === 6);
      assert.deepEqual(camera.operations, [4, 4]);
    } finally {
      session.close();
    }
  });
});

test('a session the camera refuses is an error with its answer, and nothing is sent after it', async () => {
  await withCamera({}, async (camera) => {
    await assert.rejects(MissSession.open('127.0.0.1', keysFor(camera, 'wrong-sign'), () => {}), /refused the session: .*"result":"fail"/);
    assert.equal(camera.sessions, 0);
    assert.deepEqual(camera.operations, []);
  });
});

test('a camera that does not answer the search is an error that says to check it is on and in the network', async () => {
  // 127.0.0.2: nobody answers there
  await assert.rejects(MissSession.open('127.0.0.2', { client_public: '11'.repeat(32), client_private: '22'.repeat(32), device_public: '33'.repeat(32), sign: SIGN }, () => {}), /no answer from the camera at 127\.0\.0\.2 .*same network/);
});

test('a camera of another P2P vendor is refused before anything is sent to it', async () => {
  await assert.rejects(MissSession.open('127.0.0.1', { client_public: '11'.repeat(32), client_private: '22'.repeat(32), device_public: '33'.repeat(32), sign: SIGN, vendor: 'tutk' }, () => {}), /over tutk: the plugin turns cameras over CS2 only/);
});

test('the session is kept alive with a ping every second while no step is sent', async () => {
  await withCamera({}, async (camera) => {
    const session = await MissSession.open('127.0.0.1', keysFor(camera), () => {});
    try {
      await sleep(2300);
      assert.ok(camera.pings >= 2, `pings: ${camera.pings}`);
      assert.equal(session.closed, false);
    } finally {
      session.close();
    }
  });
});

test('a session the camera ended is seen as closed, and a step on it fails instead of vanishing', async () => {
  await withCamera({}, async (camera) => {
    const session = await MissSession.open('127.0.0.1', keysFor(camera), () => {});
    camera.dropSessions();
    await until(() => session.closed);
    await assert.rejects(session.move(MotorStep.Left), /closed/);
  });
});

test('the camera\'s answer ends with a NUL; one that is no JSON counts as a refusal and keeps its text', () => {
  assert.deepEqual(parseAnswer('{"ret":0, "angle":36,"elevation":10}\0'), { ret: 0, angle: 36, elevation: 10 });
  assert.deepEqual(parseAnswer('busy\0'), { ret: -1, raw: 'busy' });
});

test('the arrows map to the steps of the motor, the larger axis winning', () => {
  assert.equal(stepOf(0.5, 0), MotorStep.Right);
  assert.equal(stepOf(-0.5, 0.2), MotorStep.Left);
  assert.equal(stepOf(0.1, 0.6), MotorStep.Up);
  assert.equal(stepOf(0, -1), MotorStep.Down);
  assert.equal(stepOf(0, 0), undefined);
});

/** A PTZ control over sessions with the stand-in camera, counting the sessions it opens. */
function ptzWith(camera: FakeCamera, timing = { stepMs: 100, holdMs: 1000, idleMs: 400 }) {
  const { lines, logger } = recorder();
  let opened = 0;
  const ptz = new XiaomiPtz(
    (onAnswer) => {
      opened++;
      return MissSession.open('127.0.0.1', keysFor(camera), onAnswer);
    },
    logger as never,
    timing,
  );
  return { ptz, lines, opened: () => opened };
}

const stop = { panSpeed: 0, tiltSpeed: 0, zoomSpeed: 0 };

test('a held arrow steps the camera until it is let go, over one session', async () => {
  await withCamera({}, async (camera) => {
    const { ptz, opened } = ptzWith(camera);
    try {
      await ptz.setVelocity({ panSpeed: 0.7, tiltSpeed: 0, zoomSpeed: 0 });
      await sleep(350);
      await ptz.setVelocity(stop);
      const steps = camera.operations.length;
      assert.ok(steps >= 3 && steps <= 5, `steps while held: ${steps}`);
      await sleep(300);
      assert.equal(camera.operations.length, steps, 'a step came after the arrow was let go');
      assert.ok(camera.operations.every((operation) => operation === MotorStep.Right));
      assert.equal(opened(), 1);
    } finally {
      ptz.dispose();
    }
  });
});

test('the arrow sent again while held keeps the pace, it does not step faster', async () => {
  await withCamera({}, async (camera) => {
    const { ptz } = ptzWith(camera);
    try {
      for (let i = 0; i < 8; i++) {
        await ptz.setVelocity({ panSpeed: 0, tiltSpeed: 0.8, zoomSpeed: 0 });
        await sleep(40);
      }
      await ptz.setVelocity(stop);
      // 320 ms held: the first step and one per 100 ms
      assert.ok(camera.operations.length <= 5, `steps: ${camera.operations.length}`);
      assert.ok(camera.operations.every((operation) => operation === MotorStep.Up));
    } finally {
      ptz.dispose();
    }
  });
});

test('a hold whose stop never comes ends by itself', async () => {
  await withCamera({}, async (camera) => {
    const { ptz } = ptzWith(camera, { stepMs: 50, holdMs: 300, idleMs: 2000 });
    try {
      await ptz.setVelocity({ panSpeed: -1, tiltSpeed: 0, zoomSpeed: 0 });
      await sleep(600);
      const steps = camera.operations.length;
      await sleep(300);
      assert.equal(camera.operations.length, steps);
      assert.ok(steps <= 8, `steps: ${steps}`);
    } finally {
      ptz.dispose();
    }
  });
});

test('a relative move is one step in its direction', async () => {
  await withCamera({}, async (camera) => {
    const { ptz } = ptzWith(camera);
    try {
      await ptz.setRelativeMove({ panDelta: 0, tiltDelta: -0.3, zoomDelta: 0 });
      await until(() => camera.operations.length === 1);
      await sleep(200);
      assert.deepEqual(camera.operations, [MotorStep.Down]);
    } finally {
      ptz.dispose();
    }
  });
});

test('an unused session is closed, the next step opens a new one; so does a session the camera ended', async () => {
  await withCamera({}, async (camera) => {
    const { ptz, opened } = ptzWith(camera, { stepMs: 100, holdMs: 1000, idleMs: 200 });
    try {
      await ptz.setRelativeMove({ panDelta: 1, tiltDelta: 0, zoomDelta: 0 });
      await sleep(400);
      await ptz.setRelativeMove({ panDelta: 1, tiltDelta: 0, zoomDelta: 0 });
      assert.equal(opened(), 2);
      // the step is on its way; ending the session before the camera read it would lose it in the test, not in the code
      await until(() => camera.operations.length === 2);
      camera.dropSessions();
      await sleep(100);
      await ptz.setRelativeMove({ panDelta: -1, tiltDelta: 0, zoomDelta: 0 });
      await until(() => camera.operations.length === 3);
      assert.equal(opened(), 3);
      assert.deepEqual(camera.operations, [MotorStep.Right, MotorStep.Right, MotorStep.Left]);
    } finally {
      ptz.dispose();
    }
  });
});

test('a camera that cannot be reached is said in the log with the reason, and the hold ends', async () => {
  const { lines, logger } = recorder();
  let opened = 0;
  const ptz = new XiaomiPtz(
    async () => {
      opened++;
      throw new Error('cs2: no answer from the camera at 192.168.1.50');
    },
    logger as never,
    { stepMs: 50, holdMs: 1000, idleMs: 1000 },
  );
  try {
    await ptz.setVelocity({ panSpeed: 1, tiltSpeed: 0, zoomSpeed: 0 });
    await sleep(300);
    assert.deepEqual(lines.error, ['Could not turn the camera right: cs2: no answer from the camera at 192.168.1.50']);
    assert.equal(opened, 1, 'the hold kept trying a camera that cannot be reached');
  } finally {
    ptz.dispose();
  }
});

test('a step the camera refuses (the end of its travel) is said once, until a step passes again', async () => {
  await withCamera({ ret: -2 }, async (camera) => {
    const { ptz, lines } = ptzWith(camera);
    try {
      for (let i = 0; i < 3; i++) await ptz.setRelativeMove({ panDelta: 1, tiltDelta: 0, zoomDelta: 0 });
      await until(() => camera.operations.length === 3);
      await sleep(200);
      assert.equal(lines.warn?.length, 1);
      assert.match(lines.warn[0], /did not take a step .*"ret":-2/);
    } finally {
      ptz.dispose();
    }
  });
});

// a step that hangs (a session never closed keeps the process alive) ends the run red, instead of leaving a
// process that holds the stand-in camera's port 32108 for the next run
setTimeout(() => {
  console.log('not ok - the run did not end within 150 s');
  process.exit(1);
}, 150_000).unref();

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
