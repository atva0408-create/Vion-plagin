// The H.264 encoder of this machine is found by a test encode with the ffmpeg the plugin uses: the host's, which comes
// a moment after the start. A playback asked for before it came had the encode tried with another ffmpeg (the one on
// PATH, or none) and the choice kept for good: libx264 on a machine whose host ffmpeg has a hardware encoder.
// Run: npx tsx spec/h264-encoder.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { LIBX264 } from '../src/media/transcode.js';

import type { H264Encoder } from '../src/media/transcode.js';

const noop = () => undefined;
const HOST_FFMPEG = 'X:/host/ffmpeg';
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-h264-encoder-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  downloadManager: { createDownload: async () => ({ url: '' }) },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    // the host's ffmpeg comes a moment after the start
    getFFmpegPath: () => new Promise<string>((resolve) => setTimeout(() => resolve(HOST_FFMPEG), 300)),
    getPluginsByInterface: async () => [],
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);

interface Internals {
  probeH264Encoder: (ffmpegPath: string) => Promise<H264Encoder>;
  h264(): Promise<{ ffmpegPath: string; encoder: H264Encoder }>;
}
const internals = nvr as unknown as Internals;

async function main(): Promise<void> {
  const tried: string[] = [];
  internals.probeH264Encoder = async (ffmpegPath) => {
    tried.push(ffmpegPath);
    return LIBX264;
  };
  // asked at once, before the host's ffmpeg came
  const first = await internals.h264();
  assert.deepEqual(tried, [HOST_FFMPEG], 'the encode is tried with the host ffmpeg');
  assert.equal(first.ffmpegPath, HOST_FFMPEG);
  await internals.h264();
  assert.equal(tried.length, 1, 'once');
  console.log('h264-encoder.spec: the encoder is found with the host ffmpeg, once — ok');
  finished = true;
  process.exit(0);
}

// a wait nothing ends empties Node's loop and the process ended with 0 without its checks: that is a failure
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('the spec ended before its last check: something waits for what never comes');
    process.exitCode = 1;
  }
});
main()
  .then(() => {
    finished = true;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
