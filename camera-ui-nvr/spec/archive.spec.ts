// The archive after it was moved (the volume mounted elsewhere, the storage folder renamed), through the real plugin
// class and real recorders: new rows name their file below the recordings directory, rows of older versions keep the
// absolute path they have, and both are played, scrubbed, exported and cleaned up at the place the files are now.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/archive.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

import type { DatabaseSync } from 'node:sqlite';
import type { SegmentRow } from '../src/store.js';
import type { RecordedEvent } from '../src/types.js';

// the disk as the plugin sees it: plenty of room, so only the age and the quota remove recordings
const disk = { blocks: 1000, bavail: 500, bsize: 4096 };
fsp.statfs = (async () => disk) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const dir = mkdtempSync(join(tmpdir(), 'nvr-archive-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const realNow = Date.now;

// ------------------------------------------------------------------ where a stored path leads

{
  const recordings = join(dir, 'unit', 'recordings');
  const here = join(recordings, 'cam', '2026-01-01', '1-high.ts');
  mkdirSync(dirname(here), { recursive: true });
  writeFileSync(here, 'x');
  const store = new Store(join(dir, 'unit', 'nvr.db'), recordings);
  const row = (path: string): Omit<SegmentRow, 'id'> => ({
    camera_id: 'cam',
    role: 'high',
    start_us: 0,
    end_us: 1,
    path,
    bytes: 1,
    codec: 'h264',
    codec_string: 'avc1.640015',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[]',
  });
  const stored = (path: string) => store.segment(store.addSegment(row(path)))!.path;

  assert.equal(stored(here), 'cam/2026-01-01/1-high.ts', 'a new row names its file by its place below the recordings directory');
  assert.equal(store.file({ path: 'cam/2026-01-01/1-high.ts' }), here, 'which is looked for in the recordings directory of today');
  const outside = join(dir, 'unit', 'elsewhere.ts');
  writeFileSync(outside, 'x');
  assert.equal(stored(outside), outside, 'a file outside the recordings directory keeps its path');
  assert.equal(store.file({ path: outside }), outside, 'an absolute path is used as it is while the file is there');
  // rows of older versions after the archive moved: the same place below the recordings directory of today
  assert.equal(store.file({ path: join(dir, 'gone', 'recordings', 'cam', '2026-01-01', '1-high.ts') }), here);
  assert.equal(store.file({ path: '/mnt/old-disk/vion/recordings/cam/2026-01-01/1-high.ts' }), here, 'written on a Linux server');
  assert.equal(store.file({ path: 'D:\\vion\\recordings\\cam\\2026-01-01\\1-high.ts' }), here, 'written on a Windows server');
  assert.equal(store.file({ path: '/mnt/old/recordings/recordings/2026-01-01/1-high.ts' }), join(recordings, 'recordings', '2026-01-01', '1-high.ts'), 'a camera named like the folder');
  assert.equal(store.file({ path: '/mnt/old/clips/cam/2026-01-01/1-high.ts' }), '/mnt/old/clips/cam/2026-01-01/1-high.ts', 'a missing file that was never in a recordings directory stays what it is');
  const moved = store.located({ ...row('/mnt/old-disk/vion/recordings/cam/2026-01-01/1-high.ts'), id: 7 });
  assert.deepEqual({ id: moved.id, path: moved.path, camera: moved.camera_id }, { id: 7, path: here, camera: 'cam' });
  store.close();

  // a store on its own (a tool, a spec) keeps and gives a path as it is
  const bare = new Store(join(dir, 'unit', 'bare.db'));
  assert.equal(bare.segment(bare.addSegment(row(here)))!.path, here);
  assert.equal(bare.file({ path: '/mnt/old-disk/vion/recordings/cam/2026-01-01/1-high.ts' }), '/mnt/old-disk/vion/recordings/cam/2026-01-01/1-high.ts');
  bare.close();
}

// ------------------------------------------------------------------ an archive is recorded

const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '4', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-f', 'mpegts', join(dir, 'stream.ts')], {
  encoding: 'utf8',
});
assert.equal(made.status, 0, `ffmpeg could not make a stream: ${made.stderr}`);
const stream = readFileSync(join(dir, 'stream.ts'));

interface Internals {
  cameras: Map<string, unknown>;
  store: Store & { sql: DatabaseSync };
  previewPrerollUs: number;
  enforceRetention(): Promise<void>;
  stop(): Promise<void>;
}
const downloads: { filePath: string; filename: string }[] = [];
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
function start(storagePath: string): { nvr: VionNvr; internals: Internals } {
  const api = {
    storagePath,
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    downloadManager: { createDownload: async (opts: { filePath: string; filename: string }) => (downloads.push(opts), { url: `/download/${opts.filename}` }) },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  };
  const nvr = new VionNvr({ log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
  const internals = nvr as unknown as Internals;
  for (const id of ['cam', 'aged', 'full', 'kept', 'porch', 'sparse']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
  return { nvr, internals };
}

const first = join(dir, 'first');
const second = join(dir, 'second');
mkdirSync(first);
let { nvr, internals } = start(first);

/** Four seconds of a camera recorded at `atMs` by a real recorder writing into the archive; gives the row of its file. */
async function record(camera: string, atMs: number): Promise<SegmentRow> {
  const rec = new Recorder({
    cameraId: camera,
    role: 'high',
    rtspUrl: 'rtsp://unused',
    ffmpegPath: FFMPEG,
    dir: join(first, 'recordings', camera),
    store: internals.store,
    mode: 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 60,
    log: noop,
    onStateChange: noop,
    onSegment: noop,
  });
  Date.now = () => atMs;
  try {
    (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(stream));
    await rec.stop();
  } finally {
    Date.now = realNow;
  }
  const row = internals.store.segments(camera, 'high', atMs * 1000, atMs * 1000 + 10_000_000).at(-1);
  assert.ok(row, `${camera} was recorded`);
  return row;
}
/** What an older version stored for the same file: the absolute path it was written at. Gives the row as it is then. */
function asOlderVersionsStored(row: SegmentRow): SegmentRow {
  internals.store.sql.prepare('UPDATE segments SET path = ? WHERE id = ?').run(join(first, 'recordings', row.path), row.id);
  return internals.store.segment(row.id)!;
}

const recently = realNow() - 2 * 3600_000;
const longAgo = realNow() - 3 * 86_400_000;
// of each pair the first row is a new one, the second what an older version wrote
const cam = [await record('cam', recently), asOlderVersionsStored(await record('cam', recently + 60_000))];
const aged = [await record('aged', longAgo), asOlderVersionsStored(await record('aged', longAgo + 60_000))];
const full = [await record('full', recently + 120_000), asOlderVersionsStored(await record('full', recently + 180_000))];
/** The path of a recorded file below the recordings directory, whichever way its row names it. */
const below = (row: SegmentRow) => row.path.split(/[\\/]/).slice(-3).join('/');

for (const [fresh, older] of [cam, aged, full]) {
  assert.equal(isAbsolute(fresh.path), false, `a new row is not an absolute path: ${fresh.path}`);
  assert.match(fresh.path, /^(cam|aged|full)\/\d{4}-\d\d-\d\d\/\d+-high\.ts$/);
  assert.equal(internals.store.file(fresh), join(first, 'recordings', fresh.path));
  assert.equal(statSync(internals.store.file(fresh)).size, fresh.bytes, 'the file is there, with the size the index has');
  assert.equal(older.path, join(first, 'recordings', below(older)));
  assert.equal(internals.store.file(older), older.path, 'the row of an older version leads to its file as long as it is where it was');
}
// a file that lies outside of the recordings directory, on a disk that stays where it is
const outside = join(dir, 'other-disk', 'recordings', 'kept', '2026-01-01', 'copy-high.ts');
mkdirSync(dirname(outside), { recursive: true });
copyFileSync(internals.store.file(cam[0]), outside);
const { id: _id, ...copy } = cam[0];
const kept = internals.store.segment(internals.store.addSegment({ ...copy, camera_id: 'kept', path: outside }))!;
assert.equal(kept.path, outside);

// ------------------------------------------------------------------ the archive is moved

await internals.stop();
renameSync(first, second);
({ nvr, internals } = start(second));
const now = (row: SegmentRow) => join(second, 'recordings', below(row));

for (const row of [...cam, ...aged, ...full]) {
  assert.equal(internals.store.segment(row.id)!.path, row.path, 'no row is rewritten: it names its file as it did before the move');
  assert.equal(existsSync(now(row)), true);
  assert.equal(internals.store.file(row), now(row), 'every row leads to its file where it is now');
}
assert.equal(existsSync(cam[1].path), false, 'the place the older rows name is gone');
assert.equal(internals.store.file(kept), outside, 'a file that did not move is not looked for elsewhere');

// ------------------------------------------------------------------ and played

const S = 1_000_000;
const inside = (row: SegmentRow, tsUs: number) => tsUs >= row.start_us && tsUs < row.start_us + 4 * S;
{
  // playback from the start of the first file runs through both: the new row and the one of an older version
  const played: number[] = [];
  const gaps: number[] = [];
  const session = nvr.nvrPlayback('cam', cam[0].start_us, true, 'high', {
    onReady: ({ sessionId }) => void nvr.nvrPlaybackCmd(sessionId, { cmd: 'speed', speed: 64 }),
    onVideo: ({ ts }) => played.push(ts),
    onNoData: ({ ts }) => gaps.push(ts),
  });
  for await (const _ of session) void _;
  for (const [i, row] of cam.entries()) {
    assert.equal(played.filter((ts) => inside(row, ts)).length, 40, `file ${i + 1} of the moved archive is played, all forty frames of it`);
  }
  assert.equal(gaps.length, 2, 'the pause between the two files and the end');
}
for (const [i, row] of [...cam, kept].entries()) {
  const key = await nvr.nvrScrub(row.camera_id, row.start_us + 1.5 * S);
  assert.equal(key.noData, undefined, `file ${i + 1}: the scrubber has a picture`);
  assert.equal(key.ts, row.start_us + S, 'the keyframe before the moment asked for');
  const fine = await nvr.nvrScrub(row.camera_id, row.start_us + 1.5 * S, true);
  assert.equal(fine.frames?.length, 6, `file ${i + 1}: the frames from that keyframe to the moment`);

  const strip = await nvr.nvrTraceFrames(row.camera_id, [{ tMs: row.start_us / 1000 + 1500 }, { tMs: row.start_us / 1000 + 2500 }]);
  assert.deepEqual(strip.missing, undefined, `file ${i + 1}: every trace picture is found`);
  assert.equal(strip.chains[0]?.frames.length, 2);
  const exact = await nvr.nvrTraceFrames(row.camera_id, [{ tMs: row.start_us / 1000 + 1500 }], 'exact');
  assert.equal(exact.chains[0]?.frames.length, 6, `file ${i + 1}: the exact trace frame`);
}
{
  const preview = await nvr.nvrPreviewFrames('cam', cam[0].start_us, cam[1].start_us + 3 * S, 13);
  assert.ok(preview.frames.some((f) => inside(cam[0], f.ts)) && preview.frames.some((f) => inside(cam[1], f.ts)), 'the preview strip has pictures of both files');
  const start = cam[0].start_us + 1.5 * S;
  const motion = await nvr.nvrPreviewFrames('cam', start, start + 20 * S, 12, 'motion');
  assert.equal(motion.frames[0]?.keyframe, true, 'motion starts with a decodable keyframe');
  assert.equal(motion.frames[0]?.ts, cam[0].start_us + S, 'include keyframe preroll');
  assert.ok(
    motion.frames.some((frame) => !frame.keyframe),
    'motion preserves intermediate frames',
  );
  assert.ok(
    motion.frames.every((frame, i, all) => frame.ts <= start + 4 * S && (!i || frame.ts > all[i - 1].ts)),
    'motion is bounded and ordered',
  );
  assert.ok(motion.frames.length <= 360 && motion.frames.reduce((n, frame) => n + frame.frame.byteLength, 0) <= 12 * 1024 * 1024, 'motion has a fixed data budget');
  assert.equal((await nvr.nvrPreviewFrames('cam', NaN, start, 12, 'motion')).noData, true);
  assert.equal((await nvr.nvrPreviewFrames('cam', start, start, 12, 'motion')).noData, true);

  const ordered = (frames: { ts: number }[]) => frames.every((frame, i) => !i || frame.ts > frames[i - 1].ts);
  // an event that began before its recording (recorded by events): the excerpt is where the recording is
  const late = await nvr.nvrPreviewFrames('cam', cam[1].start_us - 20 * S, cam[1].start_us + 3 * S, 12, 'motion');
  assert.equal(late.noData, undefined, 'an event recorded only from its middle has a preview');
  assert.equal(late.frames[0]?.ts, cam[1].start_us, 'from the first keyframe of its recording');
  assert.ok(late.frames.every((frame) => frame.ts <= cam[1].start_us + 3 * S) && ordered(late.frames));
  // a camera that sends keyframes rarely: here one in each 4 s file
  const sparse = cam.map(({ id: _row, ...row }) =>
    internals.store.segment(internals.store.addSegment({ ...row, camera_id: 'sparse', keyframes: JSON.stringify(JSON.parse(row.keyframes).slice(0, 1)) }))!,
  );
  // a part of an episode is shorter than the way back to its keyframe, and is still decoded from it
  const part = await nvr.nvrPreviewFrames('sparse', sparse[0].start_us + 2.5 * S, sparse[0].start_us + 2.9 * S, 12, 'motion', 0.3 * S);
  assert.equal(part.frames[0]?.ts, sparse[0].start_us, 'a short excerpt decodes from the keyframe before it');
  assert.ok(part.frames.some((frame) => frame.ts >= sparse[0].start_us + 2.5 * S), 'and reaches it');
  const preroll = internals.previewPrerollUs;
  internals.previewPrerollUs = 0.5 * S;
  // further back than the bound: no frame budget is spent before the event, the excerpt starts at its next keyframe
  const forward = await nvr.nvrPreviewFrames('cam', cam[0].start_us + 2.7 * S, cam[0].start_us + 4 * S, 12, 'motion', 0.3 * S);
  assert.equal(forward.frames[0]?.ts, cam[0].start_us + 3 * S, 'the excerpt starts at the next keyframe');
  assert.equal(forward.frames[0]?.keyframe, true);
  assert.ok(forward.frames.length > 1 && forward.frames.every((frame) => frame.ts <= cam[0].start_us + 3.3 * S), 'and is as long as asked');
  const near = await nvr.nvrPreviewFrames('cam', cam[0].start_us + 2.4 * S, cam[0].start_us + 4 * S, 12, 'motion', 0.3 * S);
  assert.equal(near.frames[0]?.ts, cam[0].start_us + 2 * S, 'within the bound the keyframe before is decoded from');
  // no keyframe left in its file after the start: the next file of the event
  const next = await nvr.nvrPreviewFrames('sparse', sparse[0].start_us + 2.5 * S, sparse[1].start_us + 2 * S, 12, 'motion', 0.3 * S);
  assert.equal(next.frames[0]?.ts, sparse[1].start_us, 'the next file of the event');
  assert.ok(next.frames.every((frame) => frame.ts >= sparse[1].start_us && frame.ts <= sparse[1].start_us + 0.3 * S));
  // and no later keyframe in the whole event: decoded from the far one, as before, rather than no preview at all
  const only = await nvr.nvrPreviewFrames('sparse', sparse[0].start_us + 2.5 * S, sparse[0].start_us + 2.9 * S, 12, 'motion');
  assert.equal(only.frames[0]?.ts, sparse[0].start_us, 'the keyframe before, however far');
  assert.ok(only.frames.some((frame) => frame.ts >= sparse[0].start_us + 2.5 * S));
  internals.previewPrerollUs = preroll;
  // the recording is looked for in the first 10 minutes of an event, not through the whole index
  assert.equal((await nvr.nvrPreviewFrames('cam', cam[0].start_us - 700 * S, cam[1].start_us + 2 * S, 12, 'motion')).noData, true);
}

// ------------------------------------------------------------------ exported

for (const [i, row] of cam.entries()) {
  const clip = await nvr.nvrExport('cam', row.start_us, row.start_us + 3 * S);
  assert.ok(clip.size > 10_000, `file ${i + 1}: the exported clip has the video (${clip.size} bytes)`);
  const batch = await nvr.nvrExportBatch({ cameras: ['cam'], slices: [{ day: 'x', startUs: row.start_us, endUs: row.start_us + 3 * S }] });
  assert.match(batch.filename, /^cam_.*\.mp4$/);
  assert.ok(statSync(downloads.at(-1)!.filePath).size > 10_000, `file ${i + 1}: the export of the dialog has the video`);
}
for (const [i, row] of cam.entries()) {
  // a visit seen by two cameras while the file was recorded; the other camera has no recording
  const visit = (id: string, cameraId: string, startTime: number) =>
    ({
      id,
      cameraId,
      state: 'ended',
      startTime,
      endTime: startTime + 1000,
      lastUpdate: startTime + 1000,
      types: ['person'],
      triggers: [],
      segmentIndex: 0,
      segments: [{ firstSeen: startTime, lastSeen: startTime + 1000, detections: [{ label: 'person', score: 0.9 }], attributes: [] }],
    }) as unknown as RecordedEvent;
  const at = row.start_us / 1000 + 1500;
  Date.now = () => at + 20_000;
  try {
    await nvr.ingestDetectionEvent('cam', 'end' as never, visit(`v-cam-${i}`, 'cam', at));
    await nvr.ingestDetectionEvent('porch', 'end' as never, visit(`v-porch-${i}`, 'porch', at + 5000));
  } finally {
    Date.now = realNow;
  }
  const episode = (await nvr.getEpisodes({ limit: 10 })).episodes.find((e) => e.members.some((m) => m.eventId === `v-cam-${i}`));
  assert.ok(episode, 'the visit is an episode');
  assert.match((await nvr.nvrExportEpisode(episode.id)).filename, /^01_cam_.*\.mp4$/);
  assert.ok(statSync(downloads.at(-1)!.filePath).size > 10_000, `file ${i + 1}: the clip of the episode has the video`);
}

// ------------------------------------------------------------------ and cleaned up: the files go with their rows

const left = (rows: SegmentRow[]) => ({ rows: rows.filter((row) => internals.store.segment(row.id)).length, files: rows.filter((row) => existsSync(now(row))).length });
{
  // deleted by hand
  const deleted = await nvr.nvrDeleteRange('cam', cam[0].start_us - S, cam[1].end_us + S);
  assert.deepEqual(deleted, { cameraId: 'cam', startMs: Math.round(cam[0].start_us / 1000), endMs: Math.round(cam[1].end_us / 1000) });
  assert.deepEqual(left(cam), { rows: 0, files: 0 }, 'deleting a range removes the files of the moved archive, not only their rows');

  // older than the archive is kept
  storage.values.retentionDays = 1;
  await internals.enforceRetention();
  assert.deepEqual(left(aged), { rows: 0, files: 0 }, 'retention removes the files of the moved archive, not only their rows');
  assert.deepEqual(left(full), { rows: 2, files: 2 }, 'and nothing that is young enough');

  // more than the archive may hold
  storage.values.quotaGB = 1e-6;
  await internals.enforceRetention();
  assert.deepEqual(left(full), { rows: 0, files: 0 }, 'the quota removes the files of the moved archive, not only their rows');
  assert.equal(existsSync(outside), false, 'and the file outside of the recordings directory, at the place it has');
  assert.equal(internals.store.totalBytes(), 0);
}

await internals.stop();
console.log('archive.spec: relative paths of new rows, absolute rows of older versions, a moved archive played, scrubbed, exported and cleaned up — ok');
process.exit(0);
