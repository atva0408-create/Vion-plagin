// The wire: the proofs and frames are the same numbers NIKA's Python makes (the vector below is also in her
// tests/test_vion_link.py), a frame changed, replayed, reordered or sent back the other way is refused, the lines of a
// stream come apart where they should and too long a line is an error.
// Run: npx tsx spec/protocol.spec.ts
import assert from 'node:assert/strict';

import { CODE_DIGITS, Framer, LineReader, mac, newCode, proofs, sameMac } from '../src/protocol.js';

// ---- the vector shared with NIKA (made with Python's hmac, independently of this code)
{
  const token = 'a'.repeat(64);
  const n1 = '0123456789abcdef0123456789abcdef';
  const n2 = 'fedcba9876543210fedcba9876543210';
  const proof = proofs(token, n1, n2);
  assert.equal(proof.vion, 'cafa5fd92da33edc913a908b367a366fb6a0e50aafac61390f431181de64e433');
  assert.equal(proof.nika, '5758e2dead1b1e5cc46d22a945a4f8e43c337e54de24312c8e1ef617bfb79fcb');
  assert.equal(proof.session, '69d4c36e0aaa194c51c428de3bb3eb532bb57c5f52e74bb98b06c23a0b7a3935');
  const frame = JSON.parse(new Framer(proof.session, 'v').frame({ t: 'ping' })) as { seq: number; body: string; mac: string };
  assert.deepEqual(frame, { seq: 1, body: '{"t":"ping"}', mac: '1c1c57af0cd1a6555da74f0481319923ce37124ee5d3dbf0b7d8068a61c9fd8e' });
}

// ---- frames: in order and from the other side only
{
  const key = mac('k', 'session');
  const vion = new Framer(key, 'v');
  const nika = new Framer(key, 'n');
  const one = vion.frame({ t: 'notify', id: '1', text: 'Привет' });
  const two = vion.frame({ t: 'ping' });
  assert.deepEqual(nika.open(JSON.parse(one)), { t: 'notify', id: '1', text: 'Привет' });
  assert.throws(() => nika.open(JSON.parse(one)), /out of order/, 'a frame replayed');
  assert.deepEqual(nika.open(JSON.parse(two)), { t: 'ping' });

  const fresh = new Framer(key, 'n');
  const skipped = new Framer(key, 'v');
  skipped.frame({ t: 'a' });
  assert.throws(() => fresh.open(JSON.parse(skipped.frame({ t: 'b' }))), /out of order/, 'a frame dropped on the way');

  const changed = JSON.parse(new Framer(key, 'v').frame({ t: 'say', text: 'тихо' })) as { body: string };
  changed.body = changed.body.replace('тихо', 'громко');
  assert.throws(() => new Framer(key, 'n').open(changed), /not made with the key/, 'a body changed on the way');

  const own = new Framer(key, 'v');
  assert.throws(() => new Framer(key, 'v').open(JSON.parse(own.frame({ t: 'x' }))), /not made with the key/, 'a frame sent back to its sender');
  assert.throws(() => new Framer('other', 'n').open(JSON.parse(new Framer(key, 'v').frame({ t: 'x' }))), /not made with the key/, 'another key');
  assert.throws(() => new Framer(key, 'n').open({ seq: 1, body: 5, mac: 'x' }), /out of order/, 'a body that is no text');
}

// ---- proofs: compared in full
{
  assert.ok(sameMac('ab', 'ab'));
  assert.ok(!sameMac('ab', 'ac'));
  assert.ok(!sameMac('a', 'ab'));
  assert.ok(!sameMac(undefined, 'ab'));
  assert.ok(!sameMac(12, '12'));
}

// ---- codes: always CODE_DIGITS digits
{
  for (let i = 0; i < 2000; i++) assert.match(newCode(), new RegExp(`^\\d{${CODE_DIGITS}}$`));
}

// ---- lines
{
  const reader = new LineReader(32);
  assert.deepEqual(reader.push('{"t":"a"}\n{"t'), ['{"t":"a"}']);
  assert.deepEqual(reader.push('":"b"}\r\n\n'), ['{"t":"b"}'], 'CRLF and empty lines');
  // a chunk ends inside a letter of two bytes
  const bytes = Buffer.from('{"t":"привет"}\n');
  const cut = bytes.indexOf(Buffer.from('р')) + 1;
  assert.deepEqual(reader.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(reader.push(bytes.subarray(cut)), ['{"t":"привет"}']);
  assert.throws(() => new LineReader(32).push('x'.repeat(40)), /longer than 32/, 'too long without an end');
  assert.throws(() => new LineReader(32).push(`${'x'.repeat(40)}\n`), /longer than 32/, 'too long with its end in the same chunk');
}

console.log('protocol: ok');
