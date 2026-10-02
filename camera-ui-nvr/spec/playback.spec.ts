// The pace of a playback (src/playback.ts) against a player that does what the interface does with the same
// commands: the recorder sends frames no further ahead of the player than its lead, 1.5 s of real time at the speed
// of the moment, however often the playback is paused, resumed or its speed changed, and over the holes of the
// archive; and it does keep that lead filled. Real recorder, real files, real time (about ten seconds).
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/playback.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlaybackManager } from '../src/playback.js';
import { readFrames } from '../src/reader.js';
import { Recorder } from '../src/recorder.js';
import { parseKeyframes, Store } from '../src/store.js';

import type { SegmentRow } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-playback-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const S = 1_000_000;
const LEAD_US = 1.5 * S;
/** Eight frames of the 10 fps recordings: the recorder hands frames over in batches of that size. */
const BATCH_US = 0.8 * S;

// ------------------------------------------------------------------ recordings: 9 s, a hole, 9 s, a hole, a minute

function video(seconds: number): Buffer {
  const path = join(dir, `${seconds}.ts`);
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', String(seconds), '-c:v', 'libx264', '-g', '10', '-bf', '0', '-f', 'mpegts', path], {
    encoding: 'utf8',
  });
  assert.equal(made.status, 0, `ffmpeg could not make a stream: ${made.stderr}`);
  return readFileSync(path);
}

const store = new Store(join(dir, 'nvr.db'));
const realNow = Date.now;
/** Records `stream` as it would arrive from a camera at `atMs`: in pieces, the clock moving with them. */
async function record(stream: Buffer, seconds: number, atMs: number): Promise<{ row: SegmentRow; frames: number[] }> {
  const rec = new Recorder({
    cameraId: 'cam',
    role: 'high',
    rtspUrl: 'rtsp://unused',
    ffmpegPath: FFMPEG,
    dir: join(dir, 'cam'),
    store,
    mode: 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 600,
    log: noop,
    onStateChange: noop,
    onSegment: noop,
  });
  const pieces = seconds * 10;
  const size = Math.ceil(stream.length / 188 / pieces) * 188;
  try {
    for (let i = 0; i < pieces; i++) {
      Date.now = () => atMs + i * 100;
      (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(stream.subarray(i * size, (i + 1) * size)));
    }
    await rec.stop();
  } finally {
    Date.now = realNow;
  }
  const row = store.segments('cam', 'high', atMs * 1000, (atMs + seconds * 1000) * 1000).at(-1);
  assert.ok(row, 'recorded');
  const frames: number[] = [];
  for await (const frame of readFrames(row, parseKeyframes(row.keyframes)[0])) frames.push(frame.tsUs);
  // a recording starts at the second keyframe of a connection (the codec is learned from the first one)
  assert.equal(frames.length, (seconds - 1) * 10, 'the frames of the stream are in the file');
  assert.ok(frames.every((tsUs, i) => i === 0 || tsUs - frames[i - 1] === 100_000), 'a tenth of a second apart');
  return { row, frames };
}

const base = realNow() - 3600_000;
const short = video(10);
const first = await record(short, 10, base);
const second = await record(short, 10, base + 40_000);
const long = await record(video(60), 60, base + 80_000);
/** The length of the two holes: from the last frame in front of each to the first frame behind it. */
const holes = [second.frames[0] - first.frames.at(-1)!, long.frames[0] - second.frames.at(-1)!];
assert.ok(holes.every((us) => us > 29 * S && us < 33 * S));

// ------------------------------------------------------------------ a player

type Command = { cmd: 'pause' | 'resume' | 'speed'; speed?: number };
/**
 * The position of the interface's player (ui/src/nvr/playback.ts), in played time: it starts with the first frame,
 * walks at the chosen speed, stands while paused, and does not walk through a hole of the archive but goes on
 * behind it. A command changes its pace from where it is.
 */
class Head {
  public speed = 1;
  public paused = false;
  private atUs = 0;
  private sinceMs = 0;
  public started = false;

  public start(playedUs: number): void {
    this.atUs = playedUs;
    this.sinceMs = realNow();
    this.started = true;
  }

  public position(): number {
    return this.paused || !this.started ? this.atUs : this.atUs + (realNow() - this.sinceMs) * 1000 * this.speed;
  }

  public command(cmd: Command): void {
    this.atUs = this.position();
    this.sinceMs = realNow();
    if (cmd.cmd === 'pause') this.paused = true;
    else if (cmd.cmd === 'resume') this.paused = false;
    else this.speed = cmd.speed!;
  }
}

const manager = new PlaybackManager(store, () => false);
/** Playbacks still running: when the last one has had its time, all are ended (a slowed-down one waits long for its next frame). */
let running = 0;

/**
 * Plays from `fromUs` for `forMs`, sending each command at its time (ms after the first frame) to the recorder and
 * to the player. `played` turns the time of a frame into played time (the holes in front of it left out).
 * Gives, for every frame, how far ahead of the player it was sent, in units of what is allowed at that moment.
 */
async function play(fromUs: number, forMs: number, script: [number, Command][], played: (tsUs: number) => number) {
  const head = new Head();
  const sent: { tsUs: number; aheadUs: number; allowedUs: number; speed: number }[] = [];
  const filled: { atMs: number; aheadUs: number; leadUs: number }[] = [];
  const gaps: number[] = [];
  let sessionId = '';
  let over = false;
  running++;
  // the lead that is allowed is that of the pace the player has or, while it stands, had
  let pace = 1;
  const session = manager.play('cam', fromUs, 'high', {
    onReady: (ready) => (sessionId = ready.sessionId),
    onVideo: ({ ts }) => {
      if (over) return;
      if (!head.started) {
        head.start(played(ts));
        for (const [atMs, cmd] of script) {
          setTimeout(() => {
            // how full the lead is just before the pace changes, when the playback has run on for a while
            if (!head.paused) filled.push({ atMs, aheadUs: played(sent.at(-1)!.tsUs) - head.position(), leadUs: LEAD_US * head.speed });
            head.command(cmd);
            if (!head.paused) pace = head.speed;
            manager.command(sessionId, cmd);
          }, atMs);
        }
        setTimeout(() => {
          over = true;
          if (--running === 0) manager.stopAll();
        }, forMs);
      }
      sent.push({ tsUs: ts, aheadUs: played(ts) - head.position(), allowedUs: LEAD_US * pace + BATCH_US, speed: pace });
    },
    onNoData: ({ ts }) => gaps.push(ts),
  });
  for await (const _ of session) void _;
  return { sent, filled, gaps };
}

// the playbacks run at the same time
const [commands, overHoles, throughHoles] = await Promise.all([
  // one recording, the buttons of the player pressed a dozen times
  play(
    long.frames[0],
    7000,
    [
      [1000, { cmd: 'speed', speed: 4 }],
      [2000, { cmd: 'pause' }],
      [2400, { cmd: 'resume' }],
      [3000, { cmd: 'speed', speed: 1 }],
      [3500, { cmd: 'pause' }],
      [3800, { cmd: 'resume' }],
      [4200, { cmd: 'speed', speed: 2 }],
      [4800, { cmd: 'pause' }],
      [5000, { cmd: 'speed', speed: 1 }],
      [5200, { cmd: 'resume' }],
      [5800, { cmd: 'speed', speed: 8 }],
      [6300, { cmd: 'speed', speed: 1 }],
    ],
    (tsUs) => tsUs,
  ),
  // two holes of the archive at four times the speed, with a pause in the second recording
  play(
    first.frames[0],
    6500,
    [
      [0, { cmd: 'speed', speed: 4 }],
      [3500, { cmd: 'pause' }],
      [3900, { cmd: 'resume' }],
      [5500, { cmd: 'speed', speed: 2 }],
    ],
    (tsUs) => tsUs - (tsUs >= long.frames[0] ? holes[0] + holes[1] : tsUs >= second.frames[0] ? holes[0] : 0),
  ),
  // sixteen times the speed: a hole of half a minute takes the player two seconds, and one it needs less than three
  // for it walks through, as the interface does; the frames behind it are sent when it gets near them, not at once
  play(first.frames[0], 4500, [[0, { cmd: 'speed', speed: 16 }]], (tsUs) => tsUs),
]);

const seconds = (us: number) => Math.round(us / 1000) / 1000;
for (const [name, playback] of [
  ['commands', commands],
  ['holes', overHoles],
] as const) {
  // no frame is sent further ahead of the player than the lead of the moment (and the batch it is handed over in)
  const worst = playback.sent.reduce((a, b) => (b.aheadUs - b.allowedUs > a.aheadUs - a.allowedUs ? b : a));
  assert.ok(
    worst.aheadUs <= worst.allowedUs,
    `${name}: a frame was sent ${seconds(worst.aheadUs)} s ahead of the player at speed ${worst.speed}, the lead is ${seconds(LEAD_US * worst.speed)} s (frame ${playback.sent.indexOf(worst)} of ${playback.sent.length})`,
  );
  // and the lead is kept filled: before each change of pace the frames reached about as far ahead as they may
  for (const check of playback.filled.filter((c) => c.atMs >= 1000)) {
    assert.ok(check.aheadUs >= check.leadUs * 0.6, `${name}: at ${check.atMs} ms the player had ${seconds(check.aheadUs)} s of frames in front of it, the lead is ${seconds(check.leadUs)} s`);
  }
  assert.ok(playback.filled.length >= 3);
}
// what the player got is the recording in its order, nothing left out by a command or a hole
assert.deepEqual(
  commands.sent.map((f) => f.tsUs),
  long.frames.slice(0, commands.sent.length),
  'every frame of the recording, once, in order',
);
assert.ok(commands.sent.length > 150 && commands.sent.length < 330, `about what the player walked in seven seconds plus its lead: ${commands.sent.length} frames`);
const all = [...first.frames, ...second.frames, ...long.frames];
assert.deepEqual(
  overHoles.sent.map((f) => f.tsUs),
  all.slice(0, overHoles.sent.length),
  'over the holes: every frame, once, in order',
);
assert.ok(overHoles.sent.length > 180 + 20, `both short recordings and a part of the long one were played: ${overHoles.sent.length} frames`);
assert.deepEqual(overHoles.gaps.slice(0, 2), [first.frames.at(-1), second.frames.at(-1)], 'the player is told where each hole starts');
{
  const worst = throughHoles.sent.reduce((a, b) => (b.aheadUs - b.allowedUs > a.aheadUs - a.allowedUs ? b : a));
  assert.ok(worst.aheadUs <= worst.allowedUs, `a hole the player walks through: a frame was sent ${seconds(worst.aheadUs)} s ahead of it, the lead at speed 16 is ${seconds(LEAD_US * 16)} s`);
  assert.deepEqual(
    throughHoles.sent.map((f) => f.tsUs),
    all.slice(0, throughHoles.sent.length),
  );
  assert.ok(throughHoles.sent.length > 180 + 100, `the player came through both holes in four seconds: ${throughHoles.sent.length} frames`);
}

store.close();
console.log(
  `playback.spec: frames stay within the lead through ${commands.filled.length + overHoles.filled.length} changes of pace and over holes, jumped and walked (${commands.sent.length}, ${overHoles.sent.length} and ${throughHoles.sent.length} frames) — ok`,
);
process.exit(0);
