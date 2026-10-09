// The intercom's SQLite store: objects back as written, the archive's filters, the text search, removal by age.
// Run: npx tsx spec/store.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { Store, ftsQuery } from '../src/store.js';

import type { Visit } from '../src/types.js';

const T0 = Date.UTC(2026, 9, 13, 9, 0);
const MIN = 60_000;

function store(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'intercom-store-')), 'intercom.db'));
}

function visit(over: Partial<Visit> = {}): Visit {
  return {
    id: 'v1',
    panelId: 'gate',
    startedAt: T0,
    trigger: 'ring',
    presses: 1,
    who: { identification: [] },
    transcript: [],
    actions: [],
    flags: [],
    nvrEventIds: [],
    snapshots: [],
    seenBy: [],
    ...over,
  };
}

test('objects come back as written; a second save replaces the first', () => {
  const s = store();
  s.savePanel({
    id: 'gate',
    name: 'Калитка',
    cameraId: 'cam1',
    doorbellSensorIds: ['s1'],
    doors: [],
    callUserIds: 'all',
    ringMode: 'together',
    orderFirstSeconds: 10,
    openUserIds: [],
    enabled: true,
  });
  assert.equal(s.panel('gate')?.name, 'Калитка');
  s.savePanel({ ...s.panel('gate')!, name: 'Калитка у дороги' });
  assert.equal(s.panels().length, 1);
  assert.equal(s.panel('gate')?.name, 'Калитка у дороги');
  s.savePerson({ id: 'p1', name: 'маша', role: 'family', faceNames: [], plates: [], access: [], openWithoutRing: false, notifyOnArrival: [] });
  s.savePerson({ id: 'p2', name: 'Артём', role: 'family', faceNames: [], plates: [], access: [], openWithoutRing: false, notifyOnArrival: [] });
  assert.deepEqual(
    s.people().map((p) => p.name),
    ['Артём', 'маша'],
    'by name, whatever the case',
  );
  s.setMeta('mode', { mode: 'away', until: T0 });
  assert.deepEqual(s.getMeta('mode'), { mode: 'away', until: T0 });
  assert.equal(s.deletePerson('p1'), true);
  assert.equal(s.deletePerson('p1'), false);
});

test('archive filters: time, panel, person, unknown, category, outcome, opened, message, instruction, flags, plate, unseen', () => {
  const s = store();
  s.saveVisit(visit({ id: 'ozon', who: { company: 'Ozon', category: 'delivery', identification: [] }, outcome: 'agent', instructionId: 'i1' }));
  s.saveVisit(
    visit({
      id: 'masha',
      panelId: 'door',
      startedAt: T0 + MIN,
      who: { personId: 'p1', name: 'Маша', category: 'family', identification: [] },
      outcome: 'answered',
      actions: [{ at: T0 + MIN, kind: 'open', detail: 'Дверь', by: 'u1', result: 'confirmed' }],
      seenBy: ['u1'],
    }),
  );
  s.saveVisit(visit({ id: 'probe', startedAt: T0 + 2 * MIN, outcome: 'message', flags: ['probing'], messageForOwner: 'спрашивал, когда вернутся' }));
  s.saveVisit(
    visit({
      id: 'car',
      startedAt: T0 + 3 * MIN,
      trigger: 'plate',
      who: { identification: [{ kind: 'plate', value: 'A001AA77', strength: 'strong', at: T0 }] },
      actions: [{ at: T0, kind: 'open', detail: 'Ворота', by: 'rule:p1', result: 'failed' }],
    }),
  );
  const ids = (q: Parameters<Store['queryVisits']>[0]) =>
    s
      .queryVisits(q)
      .visits.map((v) => v.id)
      .sort();
  assert.deepEqual(ids({}), ['car', 'masha', 'ozon', 'probe']);
  assert.deepEqual(ids({ from: T0 + MIN, to: T0 + 3 * MIN }), ['masha', 'probe']);
  assert.deepEqual(ids({ panelIds: ['door'] }), ['masha']);
  assert.deepEqual(ids({ personIds: ['p1'] }), ['masha']);
  assert.deepEqual(ids({ unknownOnly: true }), ['car', 'ozon', 'probe']);
  assert.deepEqual(ids({ categories: ['delivery'] }), ['ozon']);
  assert.deepEqual(ids({ companies: ['Ozon'] }), ['ozon']);
  assert.deepEqual(ids({ outcomes: ['message', 'agent'] }), ['ozon', 'probe']);
  assert.deepEqual(ids({ opened: true }), ['masha'], 'a failed opening is not an opening');
  assert.deepEqual(ids({ hasMessage: true }), ['probe']);
  assert.deepEqual(ids({ withInstruction: true }), ['ozon']);
  assert.deepEqual(ids({ flagged: true }), ['probe']);
  assert.deepEqual(ids({ plate: '001AA' }), ['car']);
  assert.deepEqual(ids({ unseenBy: 'u1' }), ['car', 'ozon', 'probe']);
  assert.deepEqual(s.companies(), ['Ozon']);
});

test('pages: newest first, a limit and the next page from the last start', () => {
  const s = store();
  for (let i = 0; i < 5; i++) s.saveVisit(visit({ id: `v${i}`, startedAt: T0 + i * MIN }));
  const first = s.queryVisits({ limit: 2 });
  assert.deepEqual(
    first.visits.map((v) => v.id),
    ['v4', 'v3'],
  );
  assert.equal(first.hasMore, true);
  const second = s.queryVisits({ limit: 2, before: first.visits[1].startedAt });
  assert.deepEqual(
    second.visits.map((v) => v.id),
    ['v2', 'v1'],
  );
  const last = s.queryVisits({ limit: 2, before: second.visits[1].startedAt });
  assert.deepEqual(
    last.visits.map((v) => v.id),
    ['v0'],
  );
  assert.equal(last.hasMore, false);
});

test('text: words of the conversation, the purpose and the name, as prefixes and in either case; ё is е', () => {
  const s = store();
  s.saveVisit(
    visit({
      id: 'meter',
      purpose: 'Проверка счётчиков воды',
      transcript: [{ at: T0, from: 'visitor', text: 'Здравствуйте, я из Водоканала, проверка счётчиков' }],
      who: { name: 'Иван', identification: [] },
    }),
  );
  s.saveVisit(visit({ id: 'ozon', startedAt: T0 + MIN, title: 'Курьер Озона оставил посылку' }));
  const ids = (text: string) => s.queryVisits({ text }).visits.map((v) => v.id);
  assert.deepEqual(ids('счетчик'), ['meter']);
  assert.deepEqual(ids('ВОДОКАНАЛ'), ['meter']);
  assert.deepEqual(ids('иван'), ['meter']);
  assert.deepEqual(ids('посылк озон'), ['ozon']);
  assert.deepEqual(ids('посылка счётчик'), [], 'all words are needed');
  assert.deepEqual(ids('"; DROP'), [], 'quotes are not syntax');
  assert.equal(ftsQuery('  ,. '), undefined);
  s.saveVisit(visit({ id: 'meter', purpose: 'Курьер' }));
  assert.deepEqual(ids('водоканал'), [], 'the index follows a second save');
});

test('removal by age takes visits and the door log; one visit can be deleted', () => {
  const s = store();
  s.saveVisit(visit({ id: 'old', startedAt: T0 - 100 * 24 * 60 * MIN }));
  s.saveVisit(visit({ id: 'new' }));
  s.logDoor({ at: T0 - 100 * 24 * 60 * MIN, panelId: 'gate', doorId: 'gate', by: 'u1', result: 'confirmed' });
  s.logDoor({ at: T0, panelId: 'gate', doorId: 'gate', by: 'u1', result: 'sent' });
  const removed = s.purgeVisits(T0 - 90 * 24 * 60 * MIN);
  assert.deepEqual(
    removed.map((v) => v.id),
    ['old'],
  );
  assert.deepEqual(
    s.doorLog().map((e) => e.result),
    ['sent'],
  );
  assert.equal(s.deleteVisit('new')?.id, 'new');
  assert.deepEqual(s.queryVisits({}).visits, []);
  assert.deepEqual(s.queryVisits({ text: 'new' }).visits, []);
});

void runTests();
