import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Recorder } from '../src/recorder.js';
import { parseKeyframes, Store } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-g2r-'));
const store = new Store(join(dir, 'nvr.db'));
const rec = new Recorder({
  cameraId: 'cam', role: 'high', rtspUrl: 'x', tsUrl: process.env.TS_URL, ffmpegPath: 'ffmpeg', dir: join(dir, 'rec'), store,
  mode: 'continuous', preBufferSec: 0, postBufferSec: 5, segmentSec: 10,
  log: (l, m) => console.log(l, m), onStateChange: (r) => console.log('state', r), onSegment: () => undefined,
});
rec.start();
await sleep(12000);
for (const s of store.segments('cam', 'high', 0, Date.now() * 1000 + 1e7)) console.log(s.codec_string, s.width, s.height, ((s.end_us - s.start_us) / 1e6).toFixed(1), parseKeyframes(s.keyframes).length, s.bytes);
await rec.stop();
