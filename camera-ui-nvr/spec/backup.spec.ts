// The server's backup copies the whole storage of a plugin and leaves out only a folder with a `.backupignore` in it
// (VION server/src/api/services/backup.service.ts): every backup took the whole archive of recordings (199 GB on the
// bench) and the exports. The plugin marks both folders at every start, so an install that recorded before is marked
// too; the database and the pictures of events and faces stay in the backup.
// Run: npx tsx spec/backup.spec.ts
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import VionNvr from '../src/index.js';

const noop = () => undefined;

function start(storagePath: string) {
  const warnings: string[] = [];
  const api = {
    storagePath,
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
    proxy: { createProxy: () => ({}) },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr(
    { log: noop, warn: (m: string) => warnings.push(m), error: noop, debug: noop, attention: noop, trace: noop } as never,
    api as never,
    storage as never,
  );
  return { nvr: nvr as unknown as { ready: Promise<void>; store: { close(): void } }, warnings };
}

/** What the server's backup copies of a folder: every file, except below a folder that holds a `.backupignore`. */
function backedUp(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (dir !== root && existsSync(join(dir, '.backupignore'))) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

// ------------------------------------------------------------------ an install that recorded before

{
  // its archive, an export, the pictures of an event and a face, as an older version left them: no marker anywhere
  const storagePath = mkdtempSync(join(tmpdir(), 'nvr-backup-'));
  for (const [path, data] of [
    ['recordings/cam/2026-10-30/1793300000000-high.ts', 'video'],
    ['exports/0f1e/gate_2026-10-30_10-00-00.mp4', 'clip'],
    ['thumbs/cam/event-1/event.jpg', 'picture'],
    ['faces/known/1.jpg', 'face'],
  ]) {
    mkdirSync(join(storagePath, path, '..'), { recursive: true });
    writeFileSync(join(storagePath, path), data);
  }
  assert.ok(backedUp(storagePath).includes('recordings/cam/2026-10-30/1793300000000-high.ts'), 'the check itself sees the archive when nothing marks it');

  const { nvr, warnings } = start(storagePath);
  await nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), true, 'the recordings are marked at the start');
  assert.equal(existsSync(join(storagePath, 'exports', '.backupignore')), true, 'the exports too');
  const copied = backedUp(storagePath);
  assert.deepEqual(
    copied.filter((path) => path.startsWith('recordings/') || path.startsWith('exports/')),
    [],
    `no video in the backup: ${copied.join(', ')}`,
  );
  assert.ok(copied.includes('nvr.db'), `the database is in it: ${copied.join(', ')}`);
  assert.ok(copied.includes('thumbs/cam/event-1/event.jpg') && copied.includes('faces/known/1.jpg'), 'and the pictures of events and faces');
  assert.equal(existsSync(join(storagePath, '.backupignore')), false, 'the storage itself is not left out');
  assert.deepEqual(warnings, []);
  nvr.store.close();

  // a marker that is there stays as it is
  writeFileSync(join(storagePath, 'recordings', '.backupignore'), 'set by hand');
  const again = start(storagePath);
  await again.nvr.ready;
  assert.equal(readdirSync(join(storagePath, 'recordings')).includes('.backupignore'), true);
  again.nvr.store.close();
}

// ------------------------------------------------------------------ a new install

{
  const storagePath = mkdtempSync(join(tmpdir(), 'nvr-backup-new-'));
  const { nvr } = start(storagePath);
  await nvr.ready;
  // the database with the files of its journal (WAL)
  assert.deepEqual(
    backedUp(storagePath).filter((path) => !/^nvr\.db(-wal|-shm)?$/.test(path)),
    [],
    'a new install: the database alone',
  );
  assert.ok(backedUp(storagePath).includes('nvr.db'));
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), true);
  nvr.store.close();
}

// ------------------------------------------------------------------ a marker that cannot be written

{
  // `exports` is a file here: the folder cannot be made; the plugin starts and says so
  const storagePath = mkdtempSync(join(tmpdir(), 'nvr-backup-blocked-'));
  writeFileSync(join(storagePath, 'exports'), 'not a folder');
  const { nvr, warnings } = start(storagePath);
  await nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), true, 'the recordings are marked whatever the exports');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /exports goes into the backups of the server/);
  nvr.store.close();
}

// ------------------------------------------------------------------ the server it needs

{
  // A server before VION 2.6.48 restores a backup by replacing the whole storage of the plugins: the folders left out
  // of the backup are not in it, and the archive of this machine was deleted with them. 2.6.48 keeps them. The
  // recorder says so in its requirements (engines): the install dialog of the store and the plugin page show it against
  // the server, a warning to accept, not a refusal
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { engines: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { engines?: Record<string, string> }>;
  };
  const range = manifest.engines['camera.ui'];
  const at = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(at, `a lowest version: ${range}`);
  const lowest = at.slice(1).map(Number);
  const allows = (version: string) => {
    const v = version.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (v[i] !== lowest[i]) return v[i] > lowest[i];
    return true;
  };
  assert.equal(allows('2.6.47'), false, `not on a server that deletes the archive at a restore: ${range}`);
  assert.equal(allows('2.6.48'), true, range);
  assert.equal(lock.packages[''].engines?.['camera.ui'], range, 'the lockfile says the same');
}

console.log(
  'backup.spec: recordings and exports left out of the server backup, marked at the start of an older install too; database and pictures kept; VION 2.6.48 and later — ok',
);
process.exit(0);
