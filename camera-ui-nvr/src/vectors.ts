/** Float vectors stored as little-endian float32 BLOBs, compared by cosine similarity. */

export function toBlob(vector: number[] | Float32Array): Uint8Array {
  const f = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // copy: SQLite hands out views whose byteOffset need not be 4-aligned
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Unit-length copy (zero vectors stay zero). */
export function normalize(vector: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = out[i] / norm;
  return out;
}

/** Dot product of two unit vectors = cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
