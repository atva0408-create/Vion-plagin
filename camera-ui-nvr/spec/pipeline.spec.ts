import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { exportClip } from '../src/export.js';
import { keyframeAtOrBefore, readGop, readKeyframe } from '../src/reader.js';
import { Recorder } from '../src/recorder.js';
import { PlaybackManager } from '../src/playback.js';
import { parseKeyframes, Store } from '../src/store.js';

const FAKE = process.env.FAKE_FFMPEG!;
const REAL = process.env.REAL_FFMPEG!;
const dir = mkdtempSync(join(tmpdir(), 'nvr-'));
const store = new Store(join(dir, 'nvr.db'));
const states: boolean[] = [];
const rec = new Recorder({
  cameraId: 'cam1', role: 'high', rtspUrl: 'rtsp://unused', ffmpegPath: FAKE, dir: join(dir, 'rec'), store,
  mode: 'continuous', preBufferSec: 0, postBufferSec: 5, segmentSec: 6,
  log: (l, m) => console.log(`[${l}] ${m}`), onStateChange: (r) => states.push(r), onSegment: () => undefined,
});
rec.start();
await sleep(15_000);
const now = Date.now() * 1000;
const segs = store.segments('cam1', 'high', 0, now + 1e7);
console.log('segments', segs.length, segs.map((s) => ({ dur: ((s.end_us - s.start_us) / 1e6).toFixed(1), kfs: parseKeyframes(s.keyframes).length, bytes: s.bytes, codec: s.codec_string, wh: `${s.width}x${s.height}` })));
console.log('recording states', states, 'live', rec.liveSegmentId);

const first = segs[0]!;
const mid = first.start_us + 3_000_000;
const kf = keyframeAtOrBefore(first, mid)!;
const key = await readKeyframe(first, kf);
console.log('keyframe', kf, 'frame', key?.keyframe, key?.data.length, 'startsWithSC', key?.data.subarray(0, 4).toString('hex'), 'ts ok', Math.abs(key!.tsUs - kf.tsUs) < 1000);
const gop = await readGop(first, kf, mid);
console.log('gop frames', gop.length, 'monotonic', gop.every((f, i) => i === 0 || f.tsUs >= gop[i - 1]!.tsUs), 'last-mid(ms)', ((gop.at(-1)!.tsUs - mid) / 1000).toFixed(0));

// playback: 3 seconds from the first segment, into the live segment
const pm = new PlaybackManager(store, (id) => id === rec.liveSegmentId);
let ready: unknown; let frames = 0; let lastTs = 0; let noData = 0;
const t0 = Date.now();
const it = pm.play('cam1', first.start_us + 1_000_000, 'high', {
  onReady: (p) => (ready = p), onVideo: (p) => { frames++; lastTs = p.ts; }, onNoData: () => noData++,
});
for await (const _ of it) { if (Date.now() - t0 > 3000) break; }
console.log('playback ready', ready, 'frames', frames, 'secs of media', ((lastTs - first.start_us - 1_000_000) / 1e6).toFixed(2), 'wall', ((Date.now() - t0) / 1000).toFixed(2), 'noData', noData);

const out = await exportClip({ ffmpegPath: REAL, segments: segs, startUs: first.start_us + 2_000_000, endUs: first.start_us + 9_000_000, outDir: join(dir, 'exp'), filename: 'clip.mp4' });
console.log('export', out);
await rec.stop();
console.log('after stop states', states, 'segments', store.segments('cam1', 'high', 0, Date.now() * 1000 + 1e7).length);
