/**
 * RC4 as the Mi Home cloud uses it: a key stream whose first 1024 bytes are dropped. Written out because OpenSSL 3
 * no longer offers RC4 to Node without its legacy provider.
 */
export function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }

  let x = 0;
  let y = 0;
  const next = (): number => {
    x = (x + 1) & 0xff;
    y = (y + s[x]) & 0xff;
    [s[x], s[y]] = [s[y], s[x]];
    return s[(s[x] + s[y]) & 0xff];
  };

  for (let i = 0; i < 1024; i++) next();

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ next();
  return out;
}
