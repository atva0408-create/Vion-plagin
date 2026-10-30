// A playback whose client is gone (its tab closed, the app killed, the network lost) ends and lets its file go
// (src/playback.ts). The RPC never tells the plugin that a browser went away: the playback waited for the next pull for
// good, its recording open (on the bench the file of a closed tab was still open 25 minutes later). A paused player
// still pulls (the playback waits in its pace) and keeps its playback, until it says nothing for the wait of a pause:
// a tab closed while paused held its file until the plugin restarted. Real recorder, real files, real time (seconds).
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/playback-gone.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// every file the playback opens, and whether it was closed
const opened = new Map<number, boolean>();
let handles = 0;
const realOpen = fsp.open;
fsp.open = (async (...args: Parameters<typeof realOpen>) => {
  const handle = await realOpen(...args);
  const id = ++handles;
  opened.set(id, false);
  const close = handle.close.bind(handle);
  handle.close = async () => {
    opened.set(id, true);
    return close();
  };
  return handle;
}) as typeof realOpen;
syncBuiltinESMExports();

const { PlaybackManager, setPlaybackClientGone, setPlaybackPausedGone } = await import('../src/playback.js');
const { Recorder } = await import('../src/recorder.js');
const { Store } = await import('../src/store.js');

const dir = mkdtempSync(join(tmpdir(), 'nvr-playback-gone-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const realNow = Date.now;
const store = new Store(join(dir, 'nvr.db'));

const source = join(dir, 'src.ts');
const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '30', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-f', 'mpegts', source], { encoding: 'utf8' });
assert.equal(made.status, 0, made.stderr);
const data = readFileSync(source);
const at = realNow() - 600_000;
const rec = new Recorder({ cameraId: 'cam', role: 'high', rtspUrl: 'rtsp://unused', ffmpegPath: FFMPEG, dir: join(dir, 'recordings'), store, mode: 'continuous', preBufferSec: 0, postBufferSec: 0, segmentSec: 600, log: noop, onStateChange: noop, onSegment: noop });
const pieces = 300;
const size = Math.ceil(data.length / 188 / pieces) * 188;
try {
  for (let i = 0; i < pieces; i++) {
    Date.now = () => at + i * 100;
    (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(data.subarray(i * size, (i + 1) * size)));
  }
  await rec.stop();
} finally {
  Date.now = realNow;
}
const row = store.segments('cam', 'high', at * 1000, (at + 30_000) * 1000).at(-1);
assert.ok(row, 'recorded');

const manager = new PlaybackManager(store, () => false);
const sessions = () => (manager as unknown as { sessions: Map<string, unknown> }).sessions.size;
setPlaybackClientGone(500);

let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('the spec ended before its last check: something waits for what never comes');
    process.exitCode = 1;
  }
});

// ---- a client that stops pulling: the playback ends within the wait and closes its file
{
  const before = handles;
  const gone = manager.play('cam', row!.start_us, 'high', { onReady: noop, onVideo: noop, onNoData: noop } as never)[Symbol.asyncIterator]();
  assert.equal((await gone.next()).done, false);
  assert.equal(sessions(), 1, 'playing');
  assert.ok(handles > before, 'the recording is open');
  await sleep(1500);
  assert.equal(sessions(), 0, 'a client that took nothing for the wait has no playback any more');
  assert.ok([...opened].filter(([id]) => id > before).every(([, closed]) => closed), 'and its file is closed');
  // a client back after all gets the end of the stream, not a hang
  const back = await Promise.race([gone.next(), sleep(2000).then(() => 'hang' as const)]);
  assert.notEqual(back, 'hang');
  assert.equal((back as IteratorResult<void>).done, true);
}

// ---- a paused player still pulls: its playback waits as long as the pause lasts
{
  let sessionId = '';
  let frames = 0;
  const paused = manager.play('cam', row!.start_us, 'high', {
    onReady: (ready: { sessionId: string }) => (sessionId = ready.sessionId),
    onVideo: () => void frames++,
    onNoData: noop,
  } as never)[Symbol.asyncIterator]();
  assert.equal((await paused.next()).done, false);
  manager.command(sessionId, { cmd: 'pause' });
  // the next pull waits in the pace for the whole pause
  const pulling = paused.next();
  await sleep(1500);
  assert.equal(sessions(), 1, 'the paused playback stays');
  const shown = frames;
  manager.command(sessionId, { cmd: 'resume' });
  assert.equal((await pulling).done, false);
  await sleep(300);
  assert.ok(frames > shown, 'and goes on when resumed');
  // for good: the wait of before the pause ended nothing
  for (let i = 0; i < 4; i++) assert.equal((await paused.next()).done, false, `pull ${i} after the pause`);
  await paused.return(undefined);
  assert.equal(sessions(), 0);
}

// ---- a paused player that is gone: its pull waits in the pace, no command comes, and the pause ends after its wait
{
  setPlaybackPausedGone(800);
  let sessionId = '';
  const before = handles;
  const left = manager.play('cam', row!.start_us, 'high', {
    onReady: (ready: { sessionId: string }) => (sessionId = ready.sessionId),
    onVideo: noop,
    onNoData: noop,
  } as never)[Symbol.asyncIterator]();
  assert.equal((await left.next()).done, false);
  manager.command(sessionId, { cmd: 'pause' });
  const pulling = left.next();
  // a word from the player within the wait keeps it: here a change of speed while paused
  await sleep(500);
  manager.command(sessionId, { cmd: 'speed', speed: 2 });
  await sleep(500);
  assert.equal(sessions(), 1, 'a paused playback its player spoke to stays');
  await sleep(1000);
  assert.equal(sessions(), 0, 'a paused playback whose player said nothing for the wait is ended');
  assert.ok([...opened].filter(([id]) => id > before).every(([, closed]) => closed), 'and its file is closed');
  const end = await Promise.race([pulling, sleep(2000).then(() => 'hang' as const)]);
  assert.notEqual(end, 'hang', 'the pull it waited in gets an answer');
  assert.equal((end as IteratorResult<void>).done, true, 'the end of the stream');
  setPlaybackPausedGone(10 * 60 * 1000);
}

store.close();
finished = true;
console.log('playback-gone.spec: a client gone ends its playback and closes its file; a paused one keeps it, until its player is silent for the wait of a pause — ok');
process.exit(0);
