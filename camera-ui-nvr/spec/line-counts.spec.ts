// line_counts (src/assistant.ts) and the crossings the NVR keeps (ingestCrossings, store.ts): every crossing of a line
// the server reports is kept once and counted in buckets of time, apart by line, by way in or out (net: in minus out),
// by direction along the line, by label or by camera, named in the person's language. Rows that are not crossings are
// left out; counts older than 400 days go; a read of many crossings loses none, not even many of one millisecond.
// Run: npx tsx spec/line-counts.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAssistantTool } from '../src/assistant.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { AssistantHost } from '../src/assistant.js';
import type { StoredCrossing } from '../src/types.js';

process.env.TZ = 'UTC';

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-line-counts-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameras.set('cam-door', { device: { id: 'cam-door', name: 'Подъезд' }, recorders: new Map(), subscriptions: [] } as never);
cameras.set('cam-gate', { device: { id: 'cam-gate', name: 'Ворота' }, recorders: new Map(), subscriptions: [] } as never);

const at = (local: string) => Date.parse(`${local}+03:00`);
const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
type Counts = {
  labels: string[];
  series: { name: string; values: (number | null)[]; total: number }[];
  total: number;
  net?: number;
  lines: { camera: string; line: string; hasWayIn: boolean }[];
  daysPerBucket?: number[];
  hint?: string;
  line?: string;
  capped?: boolean;
  from: string;
};
const counts = async (input: Record<string, unknown>) => {
  const result = await nvr.callAssistantTool('line_counts', input, ctx);
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  return result.content as Counts;
};
const series = (c: Counts, name: string) => c.series.find((row) => row.name === name)?.values;

// ---- nothing counted yet: said, with where lines are drawn
{
  const empty = await counts({ date: '2026-10-10', days: 3 });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.lines, []);
  assert.match(empty.hint ?? '', /zone editor/);
}

// ---- crossings come in; what is not a crossing stays out
const crossing = (line: string, direction: string, way: string | undefined, label: string, local: string, trackId = 1) => ({
  line,
  direction,
  ...(way ? { way } : {}),
  label,
  trackId,
  at: at(local),
  confidence: 0.9,
});
await nvr.ingestCrossings('cam-door', [
  // Thursday 8 October: two in, one out at the door; a car past the end of the yard
  crossing('Дверь', 'a-to-b', 'in', 'person', '2026-10-08T09:00:00', 1),
  crossing('Дверь', 'a-to-b', 'in', 'person', '2026-10-08T09:10:00', 2),
  crossing('Дверь', 'b-to-a', 'out', 'person', '2026-10-08T18:00:00', 3),
  // Friday: one in
  crossing('Дверь', 'a-to-b', 'in', 'person', '2026-10-09T08:30:00', 4),
  // a line drawn without a way in: a way that is neither in nor out is none
  crossing('Двор', 'a-to-b', 'up', 'person', '2026-10-09T12:00:00', 5),
  // a line of the same name as the gate's: one line asked by its name counts on both cameras
  crossing('Въезд', 'a-to-b', 'in', 'vehicle', '2026-10-01T11:00:00', 6),
  // not crossings
  { line: '', direction: 'a-to-b', label: 'person', at: at('2026-10-09T13:00:00') },
  { line: 'Дверь', direction: 'sideways', label: 'person', at: at('2026-10-09T13:00:00') },
  { line: 'Дверь', direction: 'a-to-b', label: 'person', at: Number.NaN },
  null,
]);
await nvr.ingestCrossings('cam-gate', [
  crossing('Въезд', 'a-to-b', 'in', 'vehicle', '2026-10-08T10:00:00', 1),
  crossing('Въезд', 'b-to-a', 'out', 'vehicle', '2026-10-10T19:00:00', 2),
  crossing('Въезд 2', 'a-to-b', 'in', 'vehicle', '2026-10-01T10:00:00', 3),
]);

{
  const all = await counts({ date: '2026-10-10', days: 3 });
  assert.deepEqual(series(all, 'пересечения'), [4, 2, 1], 'Thursday 3 at the door and a car; Friday the door and the yard; Saturday the car out');
  assert.equal(all.total, 7);
  assert.deepEqual(
    all.lines.map((entry) => [entry.camera, entry.line, entry.hasWayIn]).sort(),
    [
      ['Ворота', 'Въезд 2', true],
      ['Ворота', 'Въезд', true],
      ['Подъезд', 'Въезд', true],
      ['Подъезд', 'Дверь', true],
      ['Подъезд', 'Двор', false],
    ],
  );
}

// ---- in and out, and how many are inside
{
  const door = await counts({ date: '2026-10-08', days: 1, bucket: 'day', line: 'двер', group_by: 'way' });
  assert.equal(door.line, 'Дверь', 'a line by a part of its name');
  assert.deepEqual(series(door, 'вход'), [2]);
  assert.deepEqual(series(door, 'выход'), [1]);
  assert.equal(door.net, 1, 'one inside at the end of the day');
  const gate = await counts({ date: '2026-10-10', days: 3, line: 'въезд', group_by: 'way' });
  assert.equal(gate.line, 'Въезд', 'the whole name before a part of another');
  assert.equal(gate.net, 0);
  assert.equal((await counts({ date: '2026-10-01', days: 1, line: 'Въезд' })).total, 1, 'the same name on another camera');
  const ways = await counts({ date: '2026-10-09', days: 1, bucket: 'day', group_by: 'way', camera: 'Подъезд' });
  assert.deepEqual(series(ways, 'без стороны'), [1], 'a line without a way in counts without a side');
}

// ---- apart by line, direction, label and camera; filtered by label
{
  const byLine = await counts({ date: '2026-10-10', days: 3, group_by: 'line' });
  assert.deepEqual(series(byLine, 'Дверь'), [3, 1, 0]);
  assert.deepEqual(series(byLine, 'Въезд'), [1, 0, 1]);
  const byDirection = await counts({ date: '2026-10-10', days: 3, group_by: 'direction' });
  assert.deepEqual(series(byDirection, 'A → B'), [3, 2, 0]);
  assert.deepEqual(series(byDirection, 'B → A'), [1, 0, 1]);
  const byLabel = await counts({ date: '2026-10-10', days: 3, group_by: 'label' });
  assert.deepEqual(series(byLabel, 'человек'), [3, 2, 0]);
  assert.deepEqual(series(byLabel, 'транспорт'), [1, 0, 1]);
  const byCamera = await counts({ date: '2026-10-10', days: 3, group_by: 'camera' });
  assert.deepEqual(series(byCamera, 'Ворота'), [1, 0, 1]);
  const cars = await counts({ date: '2026-10-10', days: 3, labels: ['Vehicle'] });
  assert.equal(cars.total, 2);
  assert.equal((await counts({ date: '2026-10-10', days: 3, camera: 'Ворота' })).total, 2, 'one camera');
}

// ---- a label no crossing had is said, not counted as nobody: «car» is not «vehicle»
{
  const car = await nvr.callAssistantTool('line_counts', { date: '2026-10-10', days: 3, labels: ['car'] }, ctx);
  assert.match(car.error ?? '', /Unknown label "car"\. Labels of the crossings of the last 30 days: person, vehicle/);
  // a class of a module counts once a line counted it
  await nvr.ingestCrossings('cam-gate', [crossing('Въезд', 'a-to-b', 'in', 'bicycle', '2026-10-05T15:00:00', 40)]);
  assert.equal((await counts({ date: '2026-10-05', days: 1, labels: ['bicycle'] })).total, 1);
  // and a built-in class is known before anything of it crossed
  assert.equal((await counts({ date: '2026-10-10', days: 3, labels: ['animal'] })).total, 0);
}

// ---- the hours of a day, on average
{
  const hours = await counts({ date: '2026-10-08', days: 1, bucket: 'hour', line: 'Дверь' });
  assert.equal(hours.labels.length, 24);
  assert.equal((hours as unknown as { firstHour: string }).firstHour, '2026-10-07T21:00:00.000Z');
  assert.equal((hours as unknown as { keys?: string[] }).keys, undefined);
  assert.deepEqual([series(hours, 'пересечения')![9], series(hours, 'пересечения')![18]], [2, 1]);
  const profile = await counts({ date: '2026-10-09', days: 2, bucket: 'hour_of_day', average: true, line: 'Дверь' });
  assert.equal(series(profile, 'пересечения')![9], 1, 'two at 9 on Thursday over two days');
  assert.equal(profile.daysPerBucket![9], 2);
}

// ---- a line asked that never counted, or a part that fits several
{
  assert.match((await nvr.callAssistantTool('line_counts', { date: '2026-10-10', line: 'Окно' }, ctx)).error ?? '', /No line "Окно".*Lines that did: Въезд, Въезд 2, Дверь, Двор$/);
  assert.match((await nvr.callAssistantTool('line_counts', { date: '2026-10-10', line: 'Дв' }, ctx)).error ?? '', /fits several lines: Дверь, Двор$/);
}

// ---- many crossings, many of one millisecond at the edge of a page: none lost, none twice
{
  const many = Array.from({ length: 5100 }, (_, i) => crossing('Турникет', 'a-to-b', 'in', 'person', i < 4990 ? '2026-10-07T12:00:00' : '2026-10-07T11:00:00', i));
  // 4970 on milliseconds of their own, 20 on one, then 110 on one: the first page of 5000 ends inside those 110
  for (let i = 0; i < 4970; i++) many[i].at += 1000 + i;
  await nvr.ingestCrossings('cam-door', many.slice(0, 500));
  for (let i = 500; i < many.length; i += 500) await nvr.ingestCrossings('cam-door', many.slice(i, i + 500));
  const turnstile = await counts({ date: '2026-10-07', days: 1, bucket: 'day', line: 'Турникет' });
  assert.equal(turnstile.total, 5100);

  // a long read gives way between its pages: the recording and the other calls go on meanwhile
  let turns = 0;
  let running = true;
  const spin = () => {
    turns++;
    if (running) setImmediate(spin);
  };
  setImmediate(spin);
  const seen: number[] = [];
  type Scan = (ids: undefined, from: number, to: number, max: number, visit: () => void) => Promise<{ scanned: number }> | { scanned: number };
  const scan = (nvr as unknown as { scanCrossings: Scan }).scanCrossings.bind(nvr);
  const read = await scan(undefined, at('2026-10-07T00:00:00'), at('2026-10-07T23:59:59'), 300_000, () => void seen.push(turns));
  running = false;
  assert.equal(read.scanned, 5100);
  assert.ok(seen.at(-1)! > seen[0], `the other work ran between the pages (turns ${seen[0]} → ${seen.at(-1)})`);
}

// ---- no more than 500 crossings from one call
{
  await nvr.ingestCrossings('cam-gate', Array.from({ length: 501 }, (_, i) => crossing('Шлагбаум', 'a-to-b', 'in', 'vehicle', '2026-10-06T12:00:00', i)));
  assert.equal((await counts({ date: '2026-10-06', days: 1, line: 'Шлагбаум' })).total, 500);
}

// ---- a read that stopped: the days it did not reach have no value
{
  const rows: StoredCrossing[] = Array.from({ length: 10 }, (_, i) => ({
    cameraId: 'cam-door',
    line: 'Дверь',
    direction: 'a-to-b',
    way: 'in',
    label: 'person',
    trackId: i,
    at: at(`2026-10-${String(i + 1).padStart(2, '0')}T12:00:00`),
  }));
  const fake = {
    cameras: () => [{ id: 'cam-door', name: 'Подъезд' }],
    crossingLines: () => [{ cameraId: 'cam-door', line: 'Дверь', hasWay: true }],
    crossings: (_ids: unknown, from: number, to: number, _max: number, visit: (c: StoredCrossing) => void) => {
      const inRange = rows.filter((row) => row.at >= from && row.at <= to).sort((a, b) => b.at - a.at);
      const read = inRange.slice(0, 3);
      read.forEach(visit);
      return { scanned: read.length, capped: inRange.length > 3, oldestMs: read.at(-1)?.at };
    },
  } as unknown as AssistantHost;
  const result = await callAssistantTool(fake, 'line_counts', { date: '2026-10-10', days: 10 }, ctx);
  const capped = result.content as Counts;
  assert.equal(capped.capped, true);
  const values = series(capped, 'пересечения')!;
  assert.deepEqual(values.slice(-2), [1, 1]);
  assert.ok(values.slice(0, 8).every((v) => v === null), JSON.stringify(values));
}

// ---- the totals of the modules page: by camera, line, label and way, in one answer
{
  const totals = await nvr.lineTotals(at('2026-10-08T00:00:00'), at('2026-10-08T23:59:59'));
  const key = (row: { cameraId: string; line: string; label: string; way?: string; count: number }) => `${row.cameraId}/${row.line}/${row.label}/${row.way ?? '-'}=${row.count}`;
  assert.deepEqual(totals.map(key).sort(), ['cam-door/Дверь/person/in=2', 'cam-door/Дверь/person/out=1', 'cam-gate/Въезд/vehicle/in=1']);
  assert.deepEqual(await nvr.lineTotals(at('2026-10-09T00:00:00'), at('2026-10-08T00:00:00')), [], 'a range the wrong way round is empty');
  assert.deepEqual(await nvr.lineTotals(Number.NaN, at('2026-10-08T00:00:00')), []);
}

// ---- counts older than 400 days go, the rest stays
{
  type Store = { crossingsPage(opts: { startMs: number; endMs: number; limit: number }): StoredCrossing[] };
  const store = (nvr as unknown as { store: Store }).store;
  const day = 86_400_000;
  const old = (days: number, trackId: number) => ({ ...crossing('Дверь', 'a-to-b', 'in', 'person', '2026-01-01T00:00:00', trackId), at: Date.now() - days * day });
  await nvr.ingestCrossings('cam-door', [old(401, 98), old(399, 99)]);
  await (nvr as unknown as { enforceRetention(): Promise<void> }).enforceRetention();
  const kept = store.crossingsPage({ startMs: Date.now() - 500 * day, endMs: Date.now() - 300 * day, limit: 10 });
  assert.deepEqual(kept.map((row) => row.trackId), [99]);
  assert.equal((await counts({ date: '2026-10-10', days: 3 })).total, 7);

  // the counts failing to go (a busy or full disk) does not stop the video's retention behind them
  const live = (nvr as unknown as { store: { pruneCrossings(before: number): number; segmentsBefore(cutoff: number, limit: number): unknown[] } }).store;
  const prune = live.pruneCrossings;
  const segmentsBefore = live.segmentsBefore;
  let asked = 0;
  live.pruneCrossings = () => {
    throw new Error('database is locked');
  };
  live.segmentsBefore = (cutoff, limit) => {
    asked++;
    return segmentsBefore.call(live, cutoff, limit);
  };
  await (nvr as unknown as { enforceRetention(): Promise<void> }).enforceRetention();
  live.pruneCrossings = prune;
  live.segmentsBefore = segmentsBefore;
  assert.ok(asked > 0, 'the old recordings are still looked for');
}

// ---- a class of one's own detector model with a capital letter («Самокат»): known whatever the case it is asked in.
// The labels asked were lowered and compared with the stored ones as they are: refused for ever, the assistant asking
// again lowered them again
{
  await nvr.ingestCrossings('cam-gate', [crossing('Въезд', 'a-to-b', 'in', 'Самокат', '2026-10-04T12:00:00', 60)]);
  assert.equal((await counts({ date: '2026-10-04', days: 1, labels: ['Самокат'] })).total, 1);
  assert.equal((await counts({ date: '2026-10-04', days: 1, labels: ['самокат'] })).total, 1);
}

console.log('line-counts.spec: crossings kept once, counted by line, way, direction, label and camera, read in pages, a label in capitals OK');
process.exit(0);
