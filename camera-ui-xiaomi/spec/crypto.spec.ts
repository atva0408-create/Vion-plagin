// The encryption of the commands of a camera session: the NaCl box key (X25519 and HSalsa20) and ChaCha20. The
// expected keys come from another implementation (PyNaCl's crypto_box_beforenm, the first one also NaCl's own test):
// a key computed wrongly here would be refused by every camera, and a stand-in camera using this code would not see it.
// Run: npx tsx spec/crypto.spec.ts
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';

import { decode, encode, hsalsa20, sharedKey } from '../src/xiaomi/crypto.js';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('the box key of a key pair and a public key is the one NaCl computes', () => {
  // RFC 7748 Alice's private key and Bob's public key
  const alicePrivate = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
  const bobPublic = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
  assert.equal(sharedKey(bobPublic, alicePrivate).toString('hex'), '1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');

  const ownPrivate = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('hex');
  const otherPublic = '5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b';
  assert.equal(sharedKey(otherPublic, ownPrivate).toString('hex'), 'ec88f6e13b22bf9f04d480e0d8525c08ac7e2f48e212742bcbcafa104a74b08d');
});

test('HSalsa20 is the step between the X25519 secret and the box key', () => {
  const secret = Buffer.from('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742', 'hex');
  assert.equal(hsalsa20(secret, Buffer.alloc(16)).toString('hex'), '1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
});

test('a key that is not 32 bytes of hex is refused, not used', () => {
  assert.throws(() => sharedKey('abcd', '00'.repeat(32)), /32 bytes/);
});

test('a message is encrypted with ChaCha20 from block 0, the 8 random bytes in front being the end of the nonce', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const message = Buffer.from('{"operation":2}');
  const sent = encode(message, key);
  assert.equal(sent.length, 8 + message.length);
  // RFC 8439 ChaCha20 with the 12-byte nonce 00000000 || <the 8 bytes>, counter 0
  const reference = createCipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), sent.subarray(0, 8)]));
  assert.deepEqual(sent.subarray(8), reference.update(message));
  assert.deepEqual(decode(sent, key), message);
});

test('ChaCha20 at counter 0 with a zero key and nonce gives the keystream of RFC 8439 A.1', () => {
  const keystream = decode(Buffer.concat([Buffer.alloc(8), Buffer.alloc(32)]), Buffer.alloc(32));
  assert.equal(keystream.toString('hex'), '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7');
});

test('two encryptions of the same message differ: every message has a nonce of its own', () => {
  const key = Buffer.alloc(32, 7);
  assert.notDeepEqual(encode(Buffer.from('same'), key), encode(Buffer.from('same'), key));
});

test('a message shorter than its nonce is an error', () => {
  assert.throws(() => decode(Buffer.alloc(3), Buffer.alloc(32)), /shorter than its nonce/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
