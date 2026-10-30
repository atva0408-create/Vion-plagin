// The server's backup copies the whole storage of a plugin and leaves out only a folder with a `.backupignore` in it
// (VION server/src/api/services/backup.service.ts): every backup took the whole archive of recordings (199 GB on the
// bench) and the exports. The plugin marks both folders at every start, so an install that recorded before is marked
// too; the database and the pictures of events and faces stay in the backup. Only on a server that keeps such folders
// at a restore (VION 2.6.48): an older one deleted them with the storage it replaced. On an older server, and one whose
// version cannot be read, the recordings stay in the backup and a marker of an earlier start is taken away again.
// Run: npx tsx spec/backup.spec.ts
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import VionNvr from '../src/index.js';

const noop = () => undefined;

/**
 * The runner of a VION server of `version` as it is installed, its package.json above it (the plugin's process is
 * started by it); undefined: a runner with no server package to be found above it (null to start()).
 */
function serverAt(version: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'nvr-backup-server-'));
  if (version) writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@vionvision/server', version }));
  return join(root, 'dist', 'server', 'plugins', 'runtime', 'node', 'child.js');
}

function start(storagePath: string, version: string | null = '2.6.48') {
  const warnings: string[] = [];
  const logs: string[] = [];
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
  // the plugin reads the version of the server it runs under from the runner of its process
  const runner = process.argv[1];
  process.argv[1] = serverAt(version ?? undefined);
  let nvr: VionNvr;
  try {
    nvr = new VionNvr(
      { log: (m: string) => logs.push(m), warn: (m: string) => warnings.push(m), error: noop, debug: noop, attention: noop, trace: noop } as never,
      api as never,
      storage as never,
    );
  } finally {
    process.argv[1] = runner;
  }
  return { nvr: nvr as unknown as { ready: Promise<void>; store: { close(): void } }, warnings, logs };
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

// ------------------------------------------------------------------ an older server, one that cannot be told

{
  const storagePath = mkdtempSync(join(tmpdir(), 'nvr-backup-old-'));
  mkdirSync(join(storagePath, 'recordings', 'cam', '2026-10-30'), { recursive: true });
  writeFileSync(join(storagePath, 'recordings', 'cam', '2026-10-30', '1793300000000-high.ts'), 'video');
  // a server before 2.6.48: nothing is left out, the recordings are in the backup as before
  const old = start(storagePath, '2.6.47');
  await old.nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), false, 'no marker on a server that deletes what a backup leaves out');
  assert.equal(existsSync(join(storagePath, 'exports', '.backupignore')), false);
  assert.ok(backedUp(storagePath).includes('recordings/cam/2026-10-30/1793300000000-high.ts'), 'the recordings are in the backup');
  assert.ok(
    old.logs.some((l) => /^VION 2\.6\.47: the recordings stay in the backups of the server/.test(l)),
    JSON.stringify(old.logs),
  );
  old.nvr.store.close();

  // the same storage on 2.6.48: marked; then the server put back to 2.6.47: its own markers go, one set by hand stays
  const upgraded = start(storagePath, '2.6.48');
  await upgraded.nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), true);
  assert.match(readFileSync(join(storagePath, 'recordings', '.backupignore'), 'utf8'), /^VION NVR: /, "its own text tells it is the recorder's");
  upgraded.nvr.store.close();
  writeFileSync(join(storagePath, 'exports', '.backupignore'), 'set by hand');
  const back = start(storagePath, '2.6.47');
  await back.nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), false, "the recorder's own marker is taken away");
  assert.equal(readFileSync(join(storagePath, 'exports', '.backupignore'), 'utf8'), 'set by hand', 'one set by hand is left');
  back.nvr.store.close();

  // a server whose version cannot be read: taken for an older one
  const again = start(storagePath, '2.6.48');
  await again.nvr.ready;
  again.nvr.store.close();
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), true);
  const unknown = start(storagePath, null);
  await unknown.nvr.ready;
  assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), false, 'no marker where the version is not known');
  assert.ok(unknown.logs.some((l) => /^VION of a version the recorder cannot read: /.test(l)));
  unknown.nvr.store.close();

  // a prerelease of 2.6.48 may not have it yet; later versions have
  for (const [version, marked] of [
    ['2.6.48-beta.1', false],
    ['2.6.49', true],
    ['2.7.0', true],
    ['3.0.0', true],
    ['2.5.99', false],
  ] as const) {
    const at = start(storagePath, version);
    await at.nvr.ready;
    at.nvr.store.close();
    assert.equal(existsSync(join(storagePath, 'recordings', '.backupignore')), marked, version);
  }
}

// ------------------------------------------------------------------ the server it needs

{
  // A server before VION 2.6.48 restores a backup by replacing the whole storage of the plugins, so the recorder leaves
  // nothing out there (above). It does not ask for 2.6.48 in its requirements: the store only warns, «update all» does
  // not even look, and the rest of this release (retention, exports, recorders) must reach the older servers too
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
  assert.equal(allows('2.6.47'), true, `an older server takes this release without a warning: ${range}`);
  assert.equal(allows('2.2.8'), true, range);
  assert.equal(lock.packages[''].engines?.['camera.ui'], range, 'the lockfile says the same');
}

console.log(
  'backup.spec: recordings and exports left out of the server backup, marked at the start of an older install too; database and pictures kept; only on VION 2.6.48 and later, its own marker taken away on an older or unknown one — ok',
);
process.exit(0);
