// What the recordings page reads, through the real plugin class with a fake host API: pages of events as the UI
// asks for them (the next page starts `before` the start of the last event it has), the re-index walking every
// event the same way, and the totals: `getEventStats().episodes` is the number of episodes of the cameras and the
// time range asked for, which the page shows as the total of «Эпизоды».
// Run: npx tsx spec/paging.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { GetEventsOptions, RecordedEvent } from '../src/types.js';

const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const clip = {
  getTextEmbedding: async () => ({ embedding: [1, 0, 0, 0], embeddingModel: 'clip-test' }),
  embedImages: async (images: Uint8Array[]) => images.map(() => ({ embeddings: [{ embedding: [1, 0, 0, 0] }], embeddingModel: 'clip-test' })),
};

function start(cameras: string[]): VionNvr {
  const api = {
    storagePath: mkdtempSync(join(tmpdir(), 'nvr-paging-')),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: {
      assistantAccess: async () => ({ allowed: false }),
      getFFmpegPath: () => new Promise<string>(noop),
      getPluginsByInterface: async (iface: string) => (iface === 'ClipDetection' ? [{ id: 'onnx' }] : []),
    },
    proxy: { createProxy: () => clip },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const plugin = new VionNvr(logger as never, api as never, storage as never);
  const managed = (plugin as unknown as { cameras: Map<string, unknown> }).cameras;
  for (const id of cameras) managed.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
  return plugin;
}

function event(id: string, cameraId: string, startTime: number, label?: string): RecordedEvent {
  return {
    id,
    cameraId,
    state: 'ended',
    startTime,
    endTime: startTime + 5000,
    lastUpdate: startTime + 5000,
    types: label ? [label] : ['motion'],
    triggers: [],
    segmentIndex: 0,
    segments: label ? [{ firstSeen: startTime, lastSeen: startTime + 5000, detections: [{ label, score: 0.9 }], attributes: [] }] : [],
  } as unknown as RecordedEvent;
}

// ------------------------------------------------------------------ pages of events

{
  const nvr = start(['cam1', 'cam2', 'cam3']);
  // one detection pass reports three cameras in the same millisecond, twice
  const all = [
    event('a', 'cam1', 1000),
    event('b', 'cam1', 2000),
    event('c1', 'cam1', 3000),
    event('c2', 'cam2', 3000),
    event('c3', 'cam3', 3000),
    event('d', 'cam1', 4000),
    event('e1', 'cam1', 5000),
    event('e2', 'cam2', 5000),
    event('e3', 'cam3', 5000),
    event('f', 'cam1', 6000),
  ];
  for (const e of all) await nvr.ingestDetectionEvent(e.cameraId, 'end' as never, e);

  /** The paging of the UI (ui/src/nvr/useDetectionEvents.ts `loadMore`): `before` is the start of the last event shown. */
  async function walk(fetch: (opts: GetEventsOptions) => Promise<{ events: RecordedEvent[]; hasMore: boolean }>, limit: number) {
    const pages: string[][] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await fetch({ limit, before });
      pages.push(page.events.map((e) => e.id));
      if (!page.hasMore) break;
      before = page.events.at(-1)!.startTime;
    }
    return pages;
  }
  const ids = (list: RecordedEvent[]) => list.map((e) => e.id).sort();

  for (let limit = 1; limit <= all.length + 1; limit++) {
    const pages = await walk((opts) => nvr.getEvents(opts), limit);
    assert.deepEqual(pages.flat().sort(), ids(all), `pages of ${limit}: every event reaches the page, once`);
    assert.ok(
      pages.every((page) => page.length > 0),
      `pages of ${limit}: no empty page is offered`,
    );
  }
  // a page is longer than asked only by the events that share the start of its last one
  assert.deepEqual((await nvr.getEvents({ limit: 3 })).events.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'f']);
  assert.deepEqual(
    (await nvr.getEvents({ limit: 2 })).events.map((e) => e.startTime),
    [6000, 5000, 5000, 5000],
  );
  assert.equal((await nvr.getEvents({ limit: 4 })).hasMore, true);
  assert.equal((await nvr.getEvents({ limit: 4, before: 3000 })).hasMore, false, 'the last page says so');
  // the camera filter of a page also holds for the events taken past its limit
  const cam23 = await walk((opts) => nvr.getCameraEvents(['cam2', 'cam3'], opts), 1);
  assert.deepEqual(cam23.flat().sort(), ['c2', 'c3', 'e2', 'e3']);
  assert.deepEqual((await walk((opts) => nvr.getCameraEvents(['cam1'], opts), 2)).flat(), ['f', 'e1', 'd', 'c1', 'b', 'a']);
}

// ------------------------------------------------------------------ the re-index reads every event

{
  const nvr = start(['cam1']);
  // 505 events, the seven oldest in the same millisecond: the 500-row page of the re-index ends among them
  const total = 505;
  for (let i = 0; i < total; i++) await nvr.ingestDetectionEvent('cam1', 'end' as never, event(`e${i}`, 'cam1', 10_000 + Math.max(0, i - 6)));
  await nvr.startClipReindex();
  for (let waited = 0; (await nvr.getClipReindexStatus()).running && waited < 200; waited++) await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await nvr.getClipReindexStatus();
  assert.equal(status.error, undefined);
  assert.equal(status.running, false);
  assert.equal(status.total, total, 'the re-index sees every event, also those sharing a start time across its page boundary');
}

// ------------------------------------------------------------------ the total of episodes

{
  // the episode rules read the clock: the two visits are an hour apart
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const nvr = start(['gate', 'door', 'yard']);
    const morning = clock;
    await nvr.ingestDetectionEvent('gate', 'end' as never, event('m-gate', 'gate', morning, 'person'));
    await nvr.ingestDetectionEvent('door', 'end' as never, event('m-door', 'door', morning + 10_000, 'person'));
    clock += 3600_000;
    const noon = clock;
    await nvr.ingestDetectionEvent('yard', 'end' as never, event('n-yard', 'yard', noon, 'person'));
    await nvr.ingestDetectionEvent('gate', 'end' as never, event('n-gate', 'gate', noon + 10_000, 'person'));
    clock += 3600_000;
    // one camera alone is no episode
    await nvr.ingestDetectionEvent('door', 'end' as never, event('late-door', 'door', clock, 'person'));

    const listed = (await nvr.getEpisodes({ limit: 100 })).episodes;
    assert.equal(listed.length, 2, 'two visits were joined into episodes');
    const episodes = async (cameraIds: string[], opts: GetEventsOptions = {}) => (await nvr.getEventStats(cameraIds, opts)).episodes;

    assert.equal(await episodes([]), 2, 'the total of the episodes view');
    assert.equal(await episodes(['gate']), 2);
    assert.equal(await episodes(['yard']), 1, 'only episodes with an event of the chosen cameras');
    assert.equal(await episodes(['door', 'yard']), 2);
    // the page keeps an episode in a time range while it ends inside it
    assert.equal(await episodes([], { startedSinceMs: morning + 60_000 }), 1);
    assert.equal(await episodes([], { startedSinceMs: morning + 12_000 }), 2, 'an episode still running at the start of the range belongs to it');
    assert.equal(await episodes([], { startedSinceMs: noon + 60_000 }), 0);
    assert.equal(await episodes([], { startMs: morning, endMs: morning + 1000 }), 1);
    assert.equal((await nvr.getEpisodes({ startMs: morning + 60_000, limit: 100 })).episodes.length, await episodes([], { startedSinceMs: morning + 60_000 }), 'list and total agree');
    assert.equal(await episodes([], { favoritesOnly: true }), 0);
    await nvr.setEpisodeFavorite(listed[0].id, true);
    assert.equal(await episodes([], { favoritesOnly: true }), 1);
    // the event filters narrow the events, the episodes stay (the page does not offer episodes under such a filter)
    const stats = await nvr.getEventStats([], { types: ['vehicle'] });
    assert.equal(stats.total, 0);
    assert.equal(stats.episodes, 2);
    assert.equal((await nvr.getEventStats([], {})).total, 5);
  } finally {
    Date.now = realNow;
  }
}

console.log('paging.spec: pages over equal start times (all cameras, chosen cameras), re-index, episode totals — ok');
process.exit(0);
