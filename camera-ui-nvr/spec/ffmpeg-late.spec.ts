// The host's ffmpeg (VION's own build) is asked for at the start, while the server itself starts. On the bench's cold
// boot (2026-11-12) it answered after the 15 s the plugin waited, and the late answer was thrown away: the recordings
// ran on the system's /usr/bin/ffmpeg until a restart. A late answer is taken when it comes, a refused one is asked
// again, and the H.264 encoder found with the other ffmpeg is looked for again with the host's.
// Run: npx tsx spec/ffmpeg-late.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr, { FFMPEG_WAIT } from '../src/index.js';
import { LIBX264 } from '../src/media/transcode.js';

import type { H264Encoder } from '../src/media/transcode.js';

const noop = () => undefined;
const HOST_FFMPEG = 'X:/host/ffmpeg';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
FFMPEG_WAIT.firstMs = 100;
FFMPEG_WAIT.retryMs = [50];

interface Internals {
  ffmpegPath: string;
  probeH264Encoder: (ffmpegPath: string) => Promise<H264Encoder>;
  h264(): Promise<{ ffmpegPath: string; encoder: H264Encoder }>;
}

function plugin(getFFmpegPath: () => Promise<string>) {
  const warnings: string[] = [];
  const api = {
    storagePath: mkdtempSync(join(tmpdir(), 'nvr-ffmpeg-late-')),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    downloadManager: { createDownload: async () => ({ url: '' }) },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath, getPluginsByInterface: async () => [] },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const logger = { log: noop, warn: (...args: unknown[]) => warnings.push(args.join(' ')), error: console.error, debug: noop, attention: noop, trace: noop };
  const nvr = new VionNvr(logger as never, api as never, storage as never);
  const internals = nvr as unknown as Internals;
  const tried: string[] = [];
  internals.probeH264Encoder = async (ffmpegPath) => {
    tried.push(ffmpegPath);
    return LIBX264;
  };
  return { internals, tried, warnings };
}

async function main(): Promise<void> {
  // ---- the answer comes after the first wait: taken then, and the encoder is looked for again with it
  {
    const { internals, tried, warnings } = plugin(() => new Promise((resolve) => setTimeout(() => resolve(HOST_FFMPEG), 300)));
    const before = await internals.h264();
    assert.notEqual(before.ffmpegPath, HOST_FFMPEG, 'not come yet: another ffmpeg after the wait');
    assert.ok(warnings.some((line) => /did not answer/.test(line)), 'the wait is said');
    await sleep(400);
    assert.equal(internals.ffmpegPath, HOST_FFMPEG, 'the late answer is taken');
    const after = await internals.h264();
    assert.equal(after.ffmpegPath, HOST_FFMPEG);
    assert.deepEqual(tried, [before.ffmpegPath, HOST_FFMPEG], 'the encoder is looked for again with the host ffmpeg');
  }

  // ---- the first ask is refused (the server's RPC not up yet): asked again, and taken
  {
    let asked = 0;
    const { internals, warnings } = plugin(() => {
      asked += 1;
      return asked === 1 ? Promise.reject(new Error('no responders')) : Promise.resolve(HOST_FFMPEG);
    });
    await sleep(300);
    assert.equal(asked, 2, 'asked again');
    assert.equal(internals.ffmpegPath, HOST_FFMPEG);
    assert.ok(warnings.some((line) => /no responders/.test(line)), 'the refusal is said, not swallowed');
  }

  // ---- in time: nothing said, one encoder search
  {
    const { internals, tried, warnings } = plugin(async () => HOST_FFMPEG);
    const found = await internals.h264();
    assert.equal(found.ffmpegPath, HOST_FFMPEG);
    assert.deepEqual(tried, [HOST_FFMPEG]);
    assert.deepEqual(warnings, []);
  }

  console.log('ffmpeg-late.spec: a late or refused answer of the host ffmpeg is taken — ok');
  finished = true;
  process.exit(0);
}

// a wait nothing ends empties Node's loop and the process ended with 0 without its checks: that is a failure
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('ffmpeg-late.spec: ended before its checks');
    process.exitCode = 1;
  }
});
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
