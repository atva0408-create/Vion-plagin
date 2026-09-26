import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import type { SegmentRow } from './store.js';

/** Cuts [startUs, endUs] out of consecutive TS segments into an MP4 without re-encoding. */
export async function exportClip(opts: {
  ffmpegPath: string;
  segments: SegmentRow[];
  startUs: number;
  endUs: number;
  outDir: string;
  filename: string;
  timelapseIntervalSec?: number;
}): Promise<{ path: string; size: number; durationMs: number }> {
  const segments = opts.segments.filter((s) => s.end_us > opts.startUs && s.start_us < opts.endUs);
  if (!segments.length) throw new Error('No recordings in the selected range');
  await mkdir(opts.outDir, { recursive: true });
  const out = join(opts.outDir, opts.filename);

  const offsetSec = Math.max(0, (opts.startUs - segments[0].start_us) / 1e6);
  const durationSec = Math.max(0.1, (Math.min(opts.endUs, segments.at(-1)!.end_us) - Math.max(opts.startUs, segments[0].start_us)) / 1e6);
  const input = `concat:${segments.map((s) => s.path).join('|')}`;

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ss', offsetSec.toFixed(3), '-t', durationSec.toFixed(3)];
  if (opts.timelapseIntervalSec && opts.timelapseIntervalSec > 0) {
    // one frame per interval, played at 30 fps
    args.push('-vf', `fps=1/${opts.timelapseIntervalSec},setpts=N/30/TB`, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an');
  } else {
    args.push('-map', '0:v:0', '-c', 'copy');
  }
  args.push('-movflags', '+faststart', out);

  await run(opts.ffmpegPath, args);
  const { size } = await stat(out);
  return { path: out, size, durationMs: Math.round(durationSec * 1000) };
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))));
  });
}

/** Writes an uncompressed (store) ZIP of the given files; MP4 does not compress further. */
export async function writeZip(target: string, files: { path: string; name: string }[]): Promise<number> {
  const out = createWriteStream(target);
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(b, (err) => (err ? reject(err) : resolve()));
      offset += b.length;
    });

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const localOffset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(0, 8); // store
    header.writeUInt32LE(dosTime(), 10);
    header.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([header, name]));

    let crc = 0;
    let size = 0;
    for await (const chunk of createReadStream(file.path)) {
      const b = chunk as Buffer;
      crc = crc32(b, crc);
      size += b.length;
      await write(b);
    }
    if (size >= 0xffffffff) throw new Error('Export too large for a ZIP archive');

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(dosTime(), 12);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([entry, name]));
  }

  const cd = Buffer.concat(central);
  const cdOffset = offset;
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  await write(end);
  await new Promise<void>((resolve) => out.end(resolve));
  return offset;
}

function dosTime(d = new Date()): number {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return ((date << 16) | time) >>> 0;
}
