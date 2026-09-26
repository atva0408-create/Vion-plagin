import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-ev-'));
const store = new Store(join(dir, 'nvr.db'));
const rec = new Recorder({
  cameraId: 'cam1', role: 'high', rtspUrl: 'x', ffmpegPath: process.env.FAKE_FFMPEG!, dir: join(dir, 'rec'), store,
  mode: 'event', preBufferSec: 4, postBufferSec: 3, segmentSec: 60,
  log: () => undefined, onStateChange: (r) => console.log('state', r, new Date().toISOString().slice(17, 23)), onSegment: () => undefined,
});
rec.start();
await sleep(9000);
const triggerAt = Date.now();
console.log('trigger');
rec.trigger((Date.now() + 3000) * 1000);
await sleep(9000);
const segs = store.segments('cam1', 'high', 0, Date.now() * 1000 + 1e7);
for (const s of segs) console.log('segment starts', ((s.start_us / 1000 - triggerAt) / 1000).toFixed(1), 's vs trigger; ends', ((s.end_us / 1000 - triggerAt) / 1000).toFixed(1), 's');
await rec.stop();
