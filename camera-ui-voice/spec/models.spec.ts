// Speech models from the models mirror: size and checksum checked, nothing half-written left. Run: npx tsx spec/models.spec.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { ModelStore, untar } from '../src/models.js';
import { runTests, test } from './helpers.js';

import type { AddressInfo } from 'node:net';
import type { ModelPack } from '../src/models.js';

const served = new Map<string, Buffer>();
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  const body = served.get(req.url ?? '');
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.VION_MODELS_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** An archive made by tar as the mirror's are (`tar --format=ustar`). */
function archive(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'voice-pack-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return gzipSync(execFileSync('tar', ['--format=ustar', '-cf', '-', '-C', dir, '.']));
}

function pack(id: string, body: Buffer): ModelPack {
  served.set(`/v1/voice/${id}.tar.gz`, body);
  return { id, file: `${id}.tar.gz`, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

test('a pack is downloaded once, checked and unpacked; the next call uses what is on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-models-'));
  const p = pack('vad-test', archive({ 'silero_vad.onnx': 'onnx', 'espeak-ng-data/ru_dict': 'dict' }));
  const store = new ModelStore(root);
  requests = 0;
  const dir = await store.ensure(p);
  assert.equal(readFileSync(join(dir, 'silero_vad.onnx'), 'utf8'), 'onnx');
  assert.equal(readFileSync(join(dir, 'espeak-ng-data', 'ru_dict'), 'utf8'), 'dict');
  assert.deepEqual(readdirSync(root), ['vad-test']);
  await store.ensure(p);
  await new ModelStore(root).ensure(p);
  assert.equal(requests, 1);
});

test('a wrong checksum: nothing is unpacked and no part file stays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-models-'));
  const good = pack('tts-test', archive({ 'model.onnx': 'voice' }));
  const tampered = archive({ 'model.onnx': 'other voice' });
  served.set('/v1/voice/tts-test.tar.gz', tampered);
  await assert.rejects(new ModelStore(root).ensure({ ...good, size: tampered.length }), /checksum mismatch/);
  assert.deepEqual(readdirSync(root), []);
});

test('a download cut short (wrong size): refused, nothing left', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-models-'));
  const p = pack('stt-test', archive({ 'tokens.txt': 'a b c' }));
  await assert.rejects(new ModelStore(root).ensure({ ...p, size: p.size + 10 }), /bytes instead of/);
  assert.deepEqual(readdirSync(root), []);
});

test('two callers at once share one download', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-models-'));
  const p = pack('shared-test', archive({ 'a.txt': 'a' }));
  requests = 0;
  const store = new ModelStore(root);
  await Promise.all([store.ensure(p), store.ensure(p), store.ensure(p)]);
  assert.equal(requests, 1);
});

test('an archive entry that leaves the folder is refused', () => {
  const header = Buffer.alloc(512);
  header.write('../evil.txt', 0);
  header.write('0000644\0', 100);
  header.write('00000000004\0', 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  const tar = Buffer.concat([header, Buffer.from('evil'.padEnd(512, '\0')), Buffer.alloc(1024)]);
  assert.throws(() => untar(tar), /outside the folder/);
});

await runTests();
server.close();
