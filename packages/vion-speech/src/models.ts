/**
 * Speech models: archives on the ViON models mirror, fetched on first use, checked by size and sha256 and unpacked
 * into the storage of the plugin that speaks. Nothing is fetched until a camera is to speak or listen.
 *
 * Where each file comes from and under which license: docs/VOICE_IMPLEMENTATION.md in the ViON repository.
 */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, writeSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import type { Language } from './language.js';

export interface ModelPack {
  id: string;
  /** Archive under <models host>/v1/voice/. */
  file: string;
  size: number;
  sha256: string;
}

export const PACKS = {
  espeak: { id: 'espeak-ng-data', file: 'espeak-ng-data.tar.gz', size: 8958606, sha256: '02700a9805556213cbcbf200f07d0b78cda946737015b8f0fb6f700ea3927abe' },
  vad: { id: 'vad-silero', file: 'vad-silero.tar.gz', size: 508189, sha256: '562e9161fc95ebed430d688cea9447ea31ff4fba7800641e2650a947f7bf8381' },
  ttsRu: { id: 'tts-ru-denis', file: 'tts-ru-denis.tar.gz', size: 58356680, sha256: '9e5a5b2b8fb3784070f8726025c42d456044a441098f874e0ccfd0b19c426700' },
  ttsEn: { id: 'tts-en-kristin', file: 'tts-en-kristin.tar.gz', size: 58434731, sha256: '903eddcb62662c1cdb5e81304d696296a3fec58614070f765a1d052cb265afc5' },
  ttsDe: { id: 'tts-de-thorsten', file: 'tts-de-thorsten.tar.gz', size: 58384305, sha256: '22939fc145e7929f89148aa96d1263ef890e42aedd3c48725402a0d50f37e292' },
  sttRu: {
    id: 'stt-ru-zipformer-small',
    file: 'stt-ru-zipformer-small.tar.gz',
    size: 20990579,
    sha256: '9c31f8337a1e2d2f86dfe94c47732dcf13421b97c76b62605de6ab70f87a62e0',
  },
  sttWhisper: { id: 'stt-whisper-base', file: 'stt-whisper-base.tar.gz', size: 93529406, sha256: 'd28916d9f0de09fdcc91d4f77fd0e295740dd5cd88d54e9f5c3494d614ea395c' },
} satisfies Record<string, ModelPack>;

/** The voice of each language: its pack and the model file inside. */
export const VOICES: Record<Language, { pack: ModelPack; model: string }> = {
  ru: { pack: PACKS.ttsRu, model: 'ru_RU-denis-medium.onnx' },
  en: { pack: PACKS.ttsEn, model: 'en_US-kristin-medium.onnx' },
  de: { pack: PACKS.ttsDe, model: 'de_DE-thorsten-medium.onnx' },
};

export function modelsHost(): string {
  return (process.env.VION_MODELS_HOST ?? 'https://models.vionvision.tech').replace(/\/+$/, '');
}

/**
 * Unpacks a tar stream (ustar, as `tar --format=ustar` writes) into a folder as it arrives, so a 90 MB model never sits
 * in memory whole. Entries that would leave the folder are refused.
 */
export class TarExtractor extends Writable {
  private pending: Buffer = Buffer.alloc(0);
  private file: { fd: number; left: number; pad: number } | undefined;
  private skip = 0;
  private ended = false;

  constructor(private target: string) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    try {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      this.drain();
      done();
    } catch (error) {
      this.closeFile();
      done(error as Error);
    }
  }

  override _final(done: (error?: Error | null) => void): void {
    const cut = Boolean(this.file) || this.skip > 0 || (!this.ended && this.pending.length > 0);
    this.closeFile();
    done(cut ? new Error('the archive ends in the middle of a file') : null);
  }

  private drain(): void {
    for (;;) {
      if (this.skip) {
        const n = Math.min(this.skip, this.pending.length);
        this.skip -= n;
        this.pending = this.pending.subarray(n);
        if (this.skip) return;
      }
      if (this.file) {
        const n = Math.min(this.file.left, this.pending.length);
        if (n) writeSync(this.file.fd, this.pending, 0, n);
        this.file.left -= n;
        this.pending = this.pending.subarray(n);
        if (this.file.left) return;
        this.skip = this.file.pad;
        this.closeFile();
        continue;
      }
      if (this.ended || this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every((byte) => byte === 0)) {
        this.ended = true;
        return;
      }
      this.entry(header);
    }
  }

  private entry(header: Buffer): void {
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const prefix = header.subarray(257, 263).toString('latin1').startsWith('ustar') ? text(345, 155) : '';
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    const pad = Math.ceil(size / 512) * 512 - size;
    if (type === '5') return;
    if (type !== '0') throw new Error(`unsupported archive entry ${name} (type ${type})`);
    const path = normalize(name).replace(/^(\.\/)+/, '');
    if (!path || isAbsolute(path) || path.split(sep).includes('..')) throw new Error(`archive entry outside the folder: ${name}`);
    const full = join(this.target, path);
    mkdirSync(dirname(full), { recursive: true });
    this.file = { fd: openSync(full, 'w'), left: size, pad };
    if (!size) {
      this.closeFile();
      this.skip = pad;
    }
  }

  private closeFile(): void {
    if (this.file) closeSync(this.file.fd);
    this.file = undefined;
  }
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Downloads and unpacks the packs into <root>/<pack id> (a plugin gives <storage>/voice-models); a pack that is there is not fetched again. */
export class ModelStore {
  private pending = new Map<string, Promise<string>>();

  constructor(
    private root: string,
    private fetcher: Fetcher = (url, init) => fetch(url, init),
    private log: (message: string) => void = () => undefined,
  ) {}

  dir(pack: ModelPack): string {
    return join(this.root, pack.id);
  }

  async has(pack: ModelPack): Promise<boolean> {
    try {
      return (await readFile(join(this.dir(pack), '.sha256'), 'utf8')).trim() === pack.sha256;
    } catch {
      return false;
    }
  }

  /** The folder of the pack, fetched first if needed; two callers share one download. */
  ensure(pack: ModelPack): Promise<string> {
    let running = this.pending.get(pack.id);
    if (!running) {
      running = this.fetchPack(pack).finally(() => this.pending.delete(pack.id));
      this.pending.set(pack.id, running);
    }
    return running;
  }

  private async fetchPack(pack: ModelPack): Promise<string> {
    const target = this.dir(pack);
    if (await this.has(pack)) return target;
    const url = `${modelsHost()}/v1/voice/${pack.file}`;
    const part = join(this.root, `${pack.id}.part`);
    const unpacking = join(this.root, `${pack.id}.unpacking`);
    await mkdir(this.root, { recursive: true });
    this.log(`downloading ${url} (${(pack.size / 1024 / 1024).toFixed(1)} MB)`);
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
      const hash = createHash('sha256');
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(part));
      if (received !== pack.size) throw new Error(`${url}: ${received} bytes instead of ${pack.size}`);
      const sha256 = hash.digest('hex');
      if (sha256 !== pack.sha256) throw new Error(`${url}: checksum mismatch`);

      await rm(unpacking, { recursive: true, force: true });
      await pipeline(createReadStream(part), createGunzip(), new TarExtractor(unpacking));
      await writeFile(join(unpacking, '.sha256'), pack.sha256);
      await rm(target, { recursive: true, force: true });
      await rename(unpacking, target);
      this.log(`model ${pack.id} ready`);
      return target;
    } finally {
      await rm(part, { force: true });
      await rm(unpacking, { recursive: true, force: true });
    }
  }

  /** Packs that are on disk, for the status. */
  async installed(): Promise<string[]> {
    const out: string[] = [];
    for (const pack of Object.values(PACKS)) if (await this.has(pack)) out.push(pack.id);
    return out;
  }
}
