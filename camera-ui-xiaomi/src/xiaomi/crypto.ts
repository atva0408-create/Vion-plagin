import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, randomBytes } from 'node:crypto';

// The commands of a P2P session (miss) are encrypted the way the Mi Home app does it: a NaCl box key shared by our
// key pair of the session and the camera's public key, used as a plain ChaCha20 key with an 8-byte random nonce in
// front of every message. Node has X25519 and ChaCha20; HSalsa20, the step of NaCl between them, is written here.

// DER wrappers of a raw X25519 key (RFC 8410): Node imports raw keys only through them
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

const SIGMA = Buffer.from('expand 32-byte k');

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

/** HSalsa20 of NaCl: a 32-byte key derived from `key` and the 16-byte `input`. */
export function hsalsa20(key: Buffer, input: Buffer): Buffer {
  const word = (buffer: Buffer, offset: number) => buffer.readUInt32LE(offset);
  const x = [
    word(SIGMA, 0),
    word(key, 0),
    word(key, 4),
    word(key, 8),
    word(key, 12),
    word(SIGMA, 4),
    word(input, 0),
    word(input, 4),
    word(input, 8),
    word(input, 12),
    word(SIGMA, 8),
    word(key, 16),
    word(key, 20),
    word(key, 24),
    word(key, 28),
    word(SIGMA, 12),
  ];
  const quarter = (a: number, b: number, c: number, d: number) => {
    x[b] ^= rotl((x[a] + x[d]) | 0, 7);
    x[c] ^= rotl((x[b] + x[a]) | 0, 9);
    x[d] ^= rotl((x[c] + x[b]) | 0, 13);
    x[a] ^= rotl((x[d] + x[c]) | 0, 18);
  };
  for (let round = 0; round < 20; round += 2) {
    quarter(0, 4, 8, 12);
    quarter(5, 9, 13, 1);
    quarter(10, 14, 2, 6);
    quarter(15, 3, 7, 11);
    quarter(0, 1, 2, 3);
    quarter(5, 6, 7, 4);
    quarter(10, 11, 8, 9);
    quarter(15, 12, 13, 14);
  }
  const out = Buffer.alloc(32);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((index, i) => out.writeUInt32LE(x[index] >>> 0, i * 4));
  return out;
}

/** The key of NaCl's box for our private key and the camera's public key, both hex (crypto_box_beforenm). */
export function sharedKey(devicePublicHex: string, clientPrivateHex: string): Buffer {
  const devicePublic = Buffer.from(devicePublicHex, 'hex');
  const clientPrivate = Buffer.from(clientPrivateHex, 'hex');
  if (devicePublic.length !== 32 || clientPrivate.length !== 32) throw new Error('A key of the camera session is not 32 bytes of hex');
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519, clientPrivate]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, devicePublic]), format: 'der', type: 'spki' }),
  });
  return hsalsa20(secret, Buffer.alloc(16));
}

/** ChaCha20 with a 12-byte nonce and the block counter at 0, as Go's chacha20.NewUnauthenticatedCipher. */
function chacha20(key: Buffer, nonce8: Buffer, data: Buffer): Buffer {
  // OpenSSL takes the counter (4 bytes) and the nonce (12 bytes, here 4 zero bytes and the 8 of the message) as one IV
  const iv = Buffer.concat([Buffer.alloc(8), nonce8]);
  const cipher = createCipheriv('chacha20', key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function encode(data: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(8);
  return Buffer.concat([nonce, chacha20(key, nonce, data)]);
}

export function decode(data: Buffer, key: Buffer): Buffer {
  if (data.length < 8) throw new Error('An encrypted message of the camera is shorter than its nonce');
  return chacha20(key, data.subarray(0, 8), data.subarray(8));
}
