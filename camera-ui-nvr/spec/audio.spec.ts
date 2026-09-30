// Sound in the archive, through the real recorder, store, reader and export with a camera emulator:
// go2rtc (the restreamer ViON runs) serves H.264 + G.711 A-law, what most cameras send, over RTSP and the
// recorder must turn it into AAC. Needs ffmpeg with libx264, ffprobe and the go2rtc binary from
// server/node_modules (FFMPEG / FFPROBE / GO2RTC override the paths).
// Run: npx tsx spec/audio.spec.ts
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import { exportClip } from '../src/export.js';
import { keyframeAtOrBefore, readFrames } from '../src/reader.js';
import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

import type { Frame } from '../src/reader.js';
import type { SegmentRow } from '../src/store.js';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const dir = mkdtempSync(join(tmpdir(), 'nvr-audio-'));

const GO2RTC =
  process.env.GO2RTC ??
  resolve(import.meta.dirname, '../../../../server/node_modules/@camera.ui', `go2rtc-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc');
assert.ok(existsSync(GO2RTC), `go2rtc binary not found at ${GO2RTC} (set GO2RTC)`);

const RTSP_PORT = 19000 + Math.floor(Math.random() * 900);
const API_PORT = RTSP_PORT + 1000;

// two source clips, looped by go2rtc like a camera would run: one with sound, one silent
function makeClip(name: string, withAudio: boolean): string {
  const file = join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25'];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000');
  args.push('-t', '20', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-ac', '1');
  args.push(file);
  const made = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  assert.equal(made.status, 0, `ffmpeg could not make ${name}: ${made.stderr}`);
  return file.replaceAll('\\', '/');
}
const clipWithSound = makeClip('sound.mp4', true);
const clipSilent = makeClip('silent.mp4', false);

writeFileSync(
  join(dir, 'go2rtc.yaml'),
  [
    'api:',
    `  listen: "127.0.0.1:${API_PORT}"`,
    'rtsp:',
    `  listen: "127.0.0.1:${RTSP_PORT}"`,
    'webrtc:',
    '  listen: ""',
    'streams:',
    // pcma: the camera sends G.711 A-law whatever the clip holds
    `  cam_sound: "ffmpeg:${clipWithSound}#input=file#video=h264#audio=pcma"`,
    `  cam_silent: "ffmpeg:${clipSilent}#input=file#video=h264"`,
    '',
  ].join('\n'),
);
const go2rtc = spawn(GO2RTC, ['-config', join(dir, 'go2rtc.yaml')], { stdio: 'ignore' });
process.on('exit', () => go2rtc.kill('SIGKILL'));
await sleep(2500);

function startCamera(withAudio: boolean): { url: string; stop: () => void } {
  return { url: `rtsp://127.0.0.1:${RTSP_PORT}/${withAudio ? 'cam_sound' : 'cam_silent'}?video&audio`, stop: () => undefined };
}

async function record(withAudio: boolean, recordAudio: boolean, seconds = 9): Promise<{ store: Store; segments: SegmentRow[] }> {
  const camera = startCamera(withAudio);
  const store = new Store(join(dir, `nvr-${withAudio}-${recordAudio}.db`));
  const recorder = new Recorder({
    cameraId: 'cam',
    role: 'high',
    rtspUrl: camera.url,
    audio: recordAudio,
    ffmpegPath: FFMPEG,
    dir: join(dir, `rec-${withAudio}-${recordAudio}`),
    store,
    mode: 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 4,
    log: (level, message) => {
      if (level === 'error') console.error(message);
    },
    onStateChange: () => undefined,
    onSegment: () => undefined,
  });
  recorder.start();
  await sleep(seconds * 1000);
  await recorder.stop();
  camera.stop();
  const segments = store.segments('cam', 'high', 0, Number.MAX_SAFE_INTEGER).filter((s) => s.bytes > 0);
  assert.ok(segments.length >= 1, 'the recorder wrote no segment: is go2rtc serving the emulated camera?');
  return { store, segments };
}

async function frames(segment: SegmentRow, audio: boolean): Promise<Frame[]> {
  const from = keyframeAtOrBefore(segment, segment.start_us)!;
  const out: Frame[] = [];
  for await (const frame of readFrames(segment, from, { audio })) out.push(frame);
  return out;
}

function streams(file: string): string[] {
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr}`);
  return probe.stdout.trim().split(/\r?\n/).filter(Boolean);
}

// --- 1. sound on: G.711 from the camera is recorded as AAC and comes back frame by frame
{
  const { store, segments } = await record(true, true);
  const withSound = segments.filter((s) => s.audio_pid >= 0);
  assert.equal(withSound.length, segments.length, 'every segment records the audio PID when sound is on');

  const seg = withSound[0];
  const all = await frames(seg, true);
  const audio = all.filter((f) => f.audio);
  const video = all.filter((f) => !f.audio);
  assert.ok(video.length > 25, `video frames: ${video.length}`);
  // 8 kHz AAC frames of 1024 samples are 128 ms long: about 7.8 per second
  const spanS = (seg.end_us - seg.start_us) / 1e6;
  assert.ok(audio.length >= Math.floor(spanS * 6), `audio frames ${audio.length} for a ${spanS.toFixed(1)} s segment`);
  assert.equal(audio[0].data[0], 0xff, 'an audio frame is a whole ADTS frame');
  assert.ok(audio.every((f, i) => i === 0 || f.tsUs >= audio[i - 1].tsUs), 'audio timestamps do not run backwards');
  assert.ok(Math.abs(audio[0].tsUs - video[0].tsUs) < 400_000, `sound starts ${(audio[0].tsUs - video[0].tsUs) / 1000} ms from the picture`);
  assert.ok(audio.at(-1)!.tsUs <= seg.end_us + 1_500_000, 'sound does not run past the segment');

  // asking without audio must give exactly the old video-only behaviour
  const plain = await frames(seg, false);
  assert.ok(plain.length > 0 && plain.every((f) => !f.audio), 'the default read carries no sound');

  // export: the clip keeps the sound, as AAC
  const clip = await exportClip({ ffmpegPath: FFMPEG, segments, startUs: segments[0].start_us, endUs: segments.at(-1)!.end_us, outDir: dir, filename: 'with-sound.mp4' });
  assert.ok(existsSync(clip.path));
  const kinds = streams(clip.path);
  assert.ok(kinds.some((k) => k.startsWith('aac,audio') || k.startsWith('audio,aac')), `exported streams: ${kinds.join(' | ')}`);
  assert.ok(kinds.some((k) => k.includes('video')), 'the picture is still there');
  store.close();
}

// --- 2. sound off: the camera still sends it, the archive does not keep it (the previous behaviour)
{
  const { store, segments } = await record(true, false, 6);
  assert.ok(segments.every((s) => s.audio_pid === -1), 'no audio PID is recorded with sound off');
  const audio = (await frames(segments[0], true)).filter((f) => f.audio);
  assert.equal(audio.length, 0, 'no sound frames in a recording made with sound off');
  const clip = await exportClip({ ffmpegPath: FFMPEG, segments, startUs: segments[0].start_us, endUs: segments.at(-1)!.end_us, outDir: dir, filename: 'no-sound.mp4' });
  assert.ok(streams(clip.path).every((k) => !k.includes('audio')), 'the export has no audio stream');
  store.close();
}

// --- 3. sound on, camera without a microphone: still records the picture
{
  const { store, segments } = await record(false, true, 6);
  assert.ok(segments.every((s) => s.audio_pid === -1), 'no audio PID for a camera without sound');
  const video = (await frames(segments[0], true)).filter((f) => !f.audio);
  assert.ok(video.length > 10, 'the picture is recorded even though sound was asked for');
  store.close();
}

// --- 4. a database made before recorded sound existed gets the column and reads as "no sound"
{
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, role TEXT NOT NULL, start_us INTEGER NOT NULL,
    end_us INTEGER NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, codec TEXT NOT NULL, codec_string TEXT NOT NULL, width INTEGER NOT NULL,
    height INTEGER NOT NULL, video_pid INTEGER NOT NULL, keyframes TEXT NOT NULL);
    INSERT INTO segments (camera_id, role, start_us, end_us, path, bytes, codec, codec_string, width, height, video_pid, keyframes)
    VALUES ('c', 'high', 1, 2, '/x.ts', 1, 'h264', 'avc1.640028', 1920, 1080, 256, '[]');`);
  old.close();
  const migrated = new Store(path);
  assert.equal(migrated.segments('c', 'high', 0, 10)[0].audio_pid, -1, 'old segments read as silent');
  migrated.close();
  new Store(path).close(); // opening twice must not try to add the column again
}

console.log('audio.spec: G.711 → AAC recording, timestamps, export, sound off, no microphone, old database OK');
process.exit(0);
