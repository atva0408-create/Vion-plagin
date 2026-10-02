// Calendar days and export file names in the time zone of the viewer, through the real plugin class with a fake host
// API on a server whose own zone is UTC (a container): the interface sends the zone of the browser as `timeZone` and
// gets the days of its calendar and file names with its clock, also on the days the clock changes. Without the
// argument everything is as it was: the days and names of the server's zone.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/timezone.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { RecordedEvent } from '../src/types.js';

process.env.TZ = 'UTC';
assert.equal(new Date(2026, 0, 1).toISOString(), '2026-01-01T00:00:00.000Z', 'the spec runs with the server in UTC');

const dir = mkdtempSync(join(tmpdir(), 'nvr-timezone-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const MOSCOW = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

const warnings: string[] = [];
const downloads: { filePath: string; filename: string }[] = [];
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  downloadManager: { createDownload: async (opts: { filePath: string; filename: string }) => (downloads.push(opts), { url: `/download/${opts.filename}` }) },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const logger = { log: noop, warn: (message: string) => warnings.push(message), error: console.error, debug: noop, attention: noop, trace: noop };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const internals = nvr as unknown as { cameras: Map<string, unknown>; store: { addSegment(row: Record<string, unknown>): number } };

const clip = join(dir, 'clip.ts');
const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '30', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-f', 'mpegts', clip], {
  encoding: 'utf8',
});
assert.equal(made.status, 0, `ffmpeg could not make a recording: ${made.stderr}`);

const utc = (text: string) => Date.parse(`${text}Z`);
/** A recording of a camera between two moments given in UTC. */
function recorded(camera: string, from: string, to: string): void {
  segment(camera, utc(from) * 1000, utc(to) * 1000);
}
function segment(camera: string, startUs: number, endUs: number): void {
  if (!internals.cameras.has(camera)) internals.cameras.set(camera, { device: { id: camera, name: camera }, recorders: new Map(), subscriptions: [] });
  internals.store.addSegment({
    camera_id: camera,
    role: 'high',
    start_us: startUs,
    end_us: endUs,
    path: clip,
    bytes: 1000,
    codec: 'h264',
    codec_string: 'avc1.640015',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[[0,0]]',
  });
}

// ------------------------------------------------------------------ the days of the calendar

// 00:20–02:40 of 15 March in Moscow: the evening of the 14th for a server in UTC, both days in Berlin
recorded('night', '2026-03-14T21:20:00', '2026-03-14T23:40:00');
assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3), ['2026-03-14'], 'without a zone: the day of the server, as before');
assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3, MOSCOW), ['2026-03-15'], 'a recording after midnight in Moscow is on the day the viewer saw it');
assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3, BERLIN), ['2026-03-14', '2026-03-15']);

// the month of the viewer, not of the server: 00:30 of 1 April in Moscow is still March in UTC and in Berlin
recorded('month', '2026-03-31T21:30:00', '2026-03-31T21:50:00');
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 3), ['2026-03-31']);
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 4), []);
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 3, MOSCOW), []);
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 4, MOSCOW), ['2026-04-01']);
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 3, BERLIN), ['2026-03-31']);
assert.deepEqual(await nvr.getRecordingDays('month', 2026, 4, BERLIN), []);

// Berlin, 29 March 2026: the clock goes from 02:00 to 03:00, the day is 23 hours long and ends at 22:00 UTC
recorded('spring-before', '2026-03-28T23:10:00', '2026-03-28T23:20:00');
recorded('spring-after', '2026-03-29T22:10:00', '2026-03-29T22:20:00');
assert.deepEqual(await nvr.getRecordingDays('spring-before', 2026, 3, BERLIN), ['2026-03-29'], '00:10 of the short day');
assert.deepEqual(await nvr.getRecordingDays('spring-after', 2026, 3, BERLIN), ['2026-03-30'], '00:10 of the day after it: an hour earlier in UTC than the day before');
assert.deepEqual(await nvr.getRecordingDays('spring-after', 2026, 3, MOSCOW), ['2026-03-30']);
assert.deepEqual(await nvr.getRecordingDays('spring-after', 2026, 3), ['2026-03-29']);
// Berlin, 25 October 2026: 03:00 becomes 02:00, the day is 25 hours long and ends at 23:00 UTC
recorded('autumn-before', '2026-10-24T22:10:00', '2026-10-24T22:20:00');
recorded('autumn-late', '2026-10-25T22:10:00', '2026-10-25T22:20:00');
recorded('autumn-after', '2026-10-25T23:10:00', '2026-10-25T23:20:00');
assert.deepEqual(await nvr.getRecordingDays('autumn-before', 2026, 10, BERLIN), ['2026-10-25'], '00:10 of the long day');
assert.deepEqual(await nvr.getRecordingDays('autumn-late', 2026, 10, BERLIN), ['2026-10-25'], '23:10 of the long day, its 25th hour');
assert.deepEqual(await nvr.getRecordingDays('autumn-after', 2026, 10, BERLIN), ['2026-10-26']);
assert.deepEqual(await nvr.getRecordingDays('autumn-late', 2026, 10, MOSCOW), ['2026-10-26'], 'Moscow does not change its clock');
assert.deepEqual(await nvr.getRecordingDays('autumn-late', 2026, 10), ['2026-10-25']);
// a recording over the whole long weekend
recorded('weekend', '2026-10-23T23:30:00', '2026-10-26T22:30:00');
assert.deepEqual(await nvr.getRecordingDays('weekend', 2026, 10), ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
assert.deepEqual(await nvr.getRecordingDays('weekend', 2026, 10, BERLIN), ['2026-10-24', '2026-10-25', '2026-10-26']);
assert.deepEqual(await nvr.getRecordingDays('weekend', 2026, 10, MOSCOW), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
assert.deepEqual(await nvr.getRecordingDays('nobody', 2026, 10, BERLIN), [], 'a camera without recordings');
// a month that is none has no days, as before (the days of January are not offered as those of a thirteenth month)
recorded('january', '2027-01-10T10:00:00', '2027-01-10T10:10:00');
assert.deepEqual(await nvr.getRecordingDays('january', 2027, 1), ['2027-01-10']);
for (const month of [0, 13, NaN]) assert.deepEqual(await nvr.getRecordingDays('january', month === 0 ? 2027 : 2026, month, BERLIN), [], `month ${month}`);
// Sydney puts its clock forward at 02:00 of 4 October, which is still 3 October in UTC: 23:10 before it is the 3rd
recorded('sydney', '2026-10-03T13:10:00', '2026-10-03T13:20:00');
assert.deepEqual(await nvr.getRecordingDays('sydney', 2026, 10, 'Australia/Sydney'), ['2026-10-03']);
// Havana has no midnight on 8 March: 00:00 becomes 01:00. 23:10 before it is the 7th, 01:10 after it the 8th
recorded('havana-before', '2026-03-08T04:10:00', '2026-03-08T04:20:00');
recorded('havana-after', '2026-03-08T05:10:00', '2026-03-08T05:20:00');
assert.deepEqual(await nvr.getRecordingDays('havana-before', 2026, 3, 'America/Havana'), ['2026-03-07']);
assert.deepEqual(await nvr.getRecordingDays('havana-after', 2026, 3, 'America/Havana'), ['2026-03-08']);

// ------------------------------------------------------------------ every month of a year, against the days as they were computed before

/** The days as `getRecordingDays` computed them before it knew a zone: from the clock of the server, hour by hour. */
function daysOfServer(segments: [number, number][], year: number, month: number): string[] {
  const localDay = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const from = new Date(year, month - 1, 1).getTime() * 1000;
  const to = new Date(year, month, 1).getTime() * 1000;
  const days = new Set<string>();
  for (const [startUs, endUs] of segments) {
    if (!(endUs >= from && startUs < to)) continue;
    for (let t = Math.max(startUs, from); t <= Math.min(endUs, to - 1); t += 3600_000_000) days.add(localDay(t / 1000));
    days.add(localDay(Math.min(endUs, to - 1) / 1000));
  }
  return [...days].filter((d) => d.startsWith(`${year}-${String(month).padStart(2, '0')}`)).sort();
}
{
  // recordings of a year: from a minute to a day and a half long, about every second day, at any time of the day
  let seed = 20261002;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const segments: [number, number][] = [];
  for (let at = utc('2025-12-30T00:00:00'); at < utc('2027-01-02T00:00:00'); at += Math.round(random() * 96 * 3600_000)) {
    const length = random() < 0.8 ? 60_000 + random() * 3600_000 : random() * 36 * 3600_000;
    segments.push([at * 1000, Math.round(at + length) * 1000]);
  }
  for (const [startUs, endUs] of segments) segment('year', startUs, endUs);
  const year = async (timeZone?: string) => {
    const months: string[][] = [];
    for (let month = 1; month <= 12; month++) months.push(await nvr.getRecordingDays('year', 2026, month, timeZone));
    return months;
  };
  // Havana and Cairo skip a midnight when their clock changes, Santiago repeats the hour before one, Kathmandu is 5:45 ahead
  for (const zone of ['UTC', MOSCOW, BERLIN, 'America/New_York', 'America/Havana', 'Africa/Cairo', 'America/Santiago', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Apia']) {
    process.env.TZ = zone;
    const before = Array.from({ length: 12 }, (_, i) => daysOfServer(segments, 2026, i + 1));
    assert.ok(before.flat().length > 100, 'the year has recordings');
    assert.deepEqual(await year(), before, `server in ${zone}, no zone asked for: the days are what they were`);
    process.env.TZ = 'UTC';
    assert.deepEqual(await year(zone), before, `server in UTC, viewer in ${zone}: the days a server in ${zone} gives`);
  }
  assert.notDeepEqual(await year(MOSCOW), await year(), 'the zone matters for this year of recordings');
}

// ------------------------------------------------------------------ the storage statistics

{
  const days = async (camera: string, timeZone?: string) => {
    const { oldestDay, newestDay, daysCount } = (await nvr.getStorageStats(timeZone)).cameras[camera];
    return { oldestDay, newestDay, daysCount };
  };
  assert.deepEqual(await days('night'), { oldestDay: '2026-03-14', newestDay: '2026-03-14', daysCount: 1 });
  assert.deepEqual(await days('night', MOSCOW), { oldestDay: '2026-03-15', newestDay: '2026-03-15', daysCount: 1 });
  assert.deepEqual(await days('night', BERLIN), { oldestDay: '2026-03-14', newestDay: '2026-03-15', daysCount: 2 });
  assert.deepEqual(await days('autumn-late', BERLIN), { oldestDay: '2026-10-25', newestDay: '2026-10-25', daysCount: 1 });
  assert.deepEqual(await days('autumn-late', MOSCOW), { oldestDay: '2026-10-26', newestDay: '2026-10-26', daysCount: 1 });
}

// ------------------------------------------------------------------ the names of exported files

{
  const S = 1_000_000;
  const night = utc('2026-03-14T21:20:00') * 1000;
  const name = async (startUs: number, timeZone?: string) => (await nvr.nvrExport('night', startUs, startUs + 2 * S, timeZone ? { timeZone } : undefined)).filename;
  assert.equal(await name(night), 'night_2026-03-14_21-20-00.mp4', 'without a zone: the clock of the server, as before');
  assert.equal(await name(night, MOSCOW), 'night_2026-03-15_00-20-00.mp4', 'the clock of the viewer');
  assert.equal(await name(night, BERLIN), 'night_2026-03-14_22-20-00.mp4');
  // after the clock change of each switch day Berlin is two hours, then one hour ahead
  const springAfter = utc('2026-03-29T22:10:00') * 1000;
  const autumnLate = utc('2026-10-25T22:10:00') * 1000;
  const from = async (camera: string, startUs: number, timeZone: string) => (await nvr.nvrExport(camera, startUs, startUs + 2 * S, { timeZone })).filename;
  assert.equal(await from('spring-after', springAfter, BERLIN), 'spring-after_2026-03-30_00-10-00.mp4');
  assert.equal(await from('spring-before', utc('2026-03-28T23:10:00') * 1000, BERLIN), 'spring-before_2026-03-29_00-10-00.mp4');
  assert.equal(await from('autumn-late', autumnLate, BERLIN), 'autumn-late_2026-10-25_23-10-00.mp4');
  assert.equal(await from('autumn-before', utc('2026-10-24T22:10:00') * 1000, BERLIN), 'autumn-before_2026-10-25_00-10-00.mp4');
  assert.equal(await from('autumn-late', autumnLate, MOSCOW), 'autumn-late_2026-10-26_01-10-00.mp4');

  // the export dialog: one file is an MP4, several are a ZIP named by the moment it is made
  const slice = (startUs: number) => ({ day: 'x', startUs, endUs: startUs + 2 * S });
  assert.equal((await nvr.nvrExportBatch({ cameras: ['night'], slices: [slice(night)] })).filename, 'night_2026-03-14_21-20-00.mp4');
  assert.equal((await nvr.nvrExportBatch({ cameras: ['night'], slices: [slice(night)], timeZone: MOSCOW })).filename, 'night_2026-03-15_00-20-00.mp4');
  const realNow = Date.now;
  Date.now = () => utc('2026-10-25T22:10:05');
  try {
    const request = { cameras: ['night', 'autumn-late'], slices: [slice(night), slice(autumnLate)] };
    assert.equal((await nvr.nvrExportBatch(request)).filename, 'vion-export_2026-10-25_22-10-05.zip');
    assert.equal((await nvr.nvrExportBatch({ ...request, timeZone: MOSCOW })).filename, 'vion-export_2026-10-26_01-10-05.zip');
    const inMoscow = readFileSync(downloads.at(-1)!.filePath).toString('latin1');
    assert.ok(inMoscow.includes('night_2026-03-15_00-20-00.mp4') && inMoscow.includes('autumn-late_2026-10-26_01-10-00.mp4'), 'the files inside the ZIP are named the same way');
    assert.equal((await nvr.nvrExportBatch({ ...request, timeZone: BERLIN })).filename, 'vion-export_2026-10-25_23-10-05.zip');
    const inBerlin = readFileSync(downloads.at(-1)!.filePath).toString('latin1');
    assert.ok(inBerlin.includes('night_2026-03-14_22-20-00.mp4') && inBerlin.includes('autumn-late_2026-10-25_23-10-00.mp4'));
  } finally {
    Date.now = realNow;
  }

  // an episode: a visit seen by two cameras at 00:20 of 15 March in Moscow, one of them recorded
  recorded('gate', '2026-03-14T21:20:25', '2026-03-14T21:21:25');
  const visit = (id: string, cameraId: string, startTime: number) =>
    ({
      id,
      cameraId,
      state: 'ended',
      startTime,
      endTime: startTime + 5000,
      lastUpdate: startTime + 5000,
      types: ['person'],
      triggers: [],
      segmentIndex: 0,
      segments: [{ firstSeen: startTime, lastSeen: startTime + 5000, detections: [{ label: 'person', score: 0.9 }], attributes: [] }],
    }) as unknown as RecordedEvent;
  const at = utc('2026-03-14T21:20:30');
  internals.cameras.set('porch', { device: { id: 'porch', name: 'porch' }, recorders: new Map(), subscriptions: [] });
  Date.now = () => at + 20_000;
  try {
    await nvr.ingestDetectionEvent('gate', 'end' as never, visit('v-gate', 'gate', at));
    await nvr.ingestDetectionEvent('porch', 'end' as never, visit('v-porch', 'porch', at + 10_000));
  } finally {
    Date.now = realNow;
  }
  const [episode] = (await nvr.getEpisodes({ limit: 10 })).episodes;
  assert.ok(episode, 'the visit is an episode');
  assert.match((await nvr.nvrExportEpisode(episode.id)).filename, /^01_gate_2026-03-14_21-20-\d\d\.mp4$/, 'without a zone: the clock of the server, as before');
  assert.match((await nvr.nvrExportEpisode(episode.id, { timeZone: MOSCOW })).filename, /^01_gate_2026-03-15_00-20-\d\d\.mp4$/);
  assert.match((await nvr.nvrExportEpisode(episode.id, { timeZone: BERLIN })).filename, /^01_gate_2026-03-14_22-20-\d\d\.mp4$/);
  // both cameras recorded: a ZIP named by the start of the episode
  recorded('porch', '2026-03-14T21:20:25', '2026-03-14T21:21:25');
  assert.match((await nvr.nvrExportEpisode(episode.id)).filename, /^vion-episode_2026-03-14_21-20-\d\d\.zip$/);
  assert.match((await nvr.nvrExportEpisode(episode.id, { timeZone: MOSCOW })).filename, /^vion-episode_2026-03-15_00-20-\d\d\.zip$/);
}

// ------------------------------------------------------------------ a zone the server does not know

{
  assert.deepEqual(warnings, [], 'nothing was reported so far');
  assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3, 'Mars/Phobos'), ['2026-03-14'], 'an unknown zone gives the days of the server');
  assert.equal((await nvr.getStorageStats('Mars/Phobos')).cameras.night.oldestDay, '2026-03-14');
  assert.equal((await nvr.nvrExport('night', utc('2026-03-14T21:20:00') * 1000, utc('2026-03-14T21:20:02') * 1000, { timeZone: 'Mars/Phobos' })).filename, 'night_2026-03-14_21-20-00.mp4');
  assert.equal(warnings.length, 1, `said once, not at every call: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /Mars\/Phobos/);
  assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3, 42 as never), ['2026-03-14'], 'what is not a zone name at all');
  assert.equal(warnings.length, 2, 'another name is said too');
  assert.deepEqual(await nvr.getRecordingDays('night', 2026, 3, ''), ['2026-03-14'], 'an empty name is no zone');
  assert.equal(warnings.length, 2);
}

console.log('timezone.spec: recording days, storage statistics and export file names in the zone of the viewer (Moscow, Berlin on its switch days), server zone without it, unknown zone — ok');
process.exit(0);
