import { generateKeyPairSync } from 'node:crypto';

/** A Curve25519 key pair as hex (the NaCl box keys the cameras use): a new one for every connection. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const priv = privateKey.export({ format: 'jwk' }).d;
  if (!pub || !priv) throw new Error('Could not create a key pair');
  return { publicKey: Buffer.from(pub, 'base64url').toString('hex'), privateKey: Buffer.from(priv, 'base64url').toString('hex') };
}
