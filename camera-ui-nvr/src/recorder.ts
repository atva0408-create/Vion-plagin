import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createWriteStream, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { probeCodec } from './media/codec.js';
import { keyframeStart, ptsDelta, TS_PACKET, TsDemuxer } from './media/ts-demux.js';

import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { CodecInfo } from './media/codec.js';
import type { Store } from './store.js';

export interface RecorderOptions {
  cameraId: string;
  role: string;
  /** go2rtc MPEG-TS endpoint (`/api/stream.ts?src=…`): preferred, no transcoding process needed. */
  tsUrl?: string;
  /** Fallback: RTSP restream copied to MPEG-TS by ffmpeg. */
  rtspUrl: string;
  /**
   * Record sound. go2rtc's own MPEG-TS carries only AAC, and cameras mostly send G.711, so with sound
   * on the stream always goes through ffmpeg, which turns any audio into AAC.
   */
  audio?: boolean;
  ffmpegPath: string;
  dir: string;
  store: Store;
  mode: 'continuous' | 'event';
  preBufferSec: number;
  postBufferSec: number;
  segmentSec: number;
  log: (level: 'log' | 'warn' | 'error' | 'debug', message: string) => void;
  onStateChange: (recording: boolean) => void;
  onSegment: () => void;
}

interface Gop {
  tsUs: number;
  packets: Buffer[];
  bytes: number;
}

interface OpenSegment {
  id: number;
  path: string;
  stream: WriteStream;
  startUs: number;
  endUs: number;
  bytes: number;
  keyframes: [number, number][];
  lastFlush: number;
  /** The last write of the index row failed (said once, not at every flush). */
  indexFailed?: boolean;
}

/** A video frame whose picture NAL has not arrived yet: its packets in arrival order, the sound between them included. */
interface HeldFrame {
  packets: Buffer[];
  /** The last bytes seen of the frame: a start code may be split between two packets. */
  tail: Buffer;
  tsUs: number | undefined;
}

const FLUSH_MS = 4000;
/** Video that runs this long without a keyframe is reported: nothing can start or be cut until one comes. */
const NO_KEYFRAME_WARN_MS = 30_000;
/** A frame waits for its picture NAL no longer than this many TS packets (~750 KiB, far more than any parameter sets and SEI). */
const HELD_MAX_PACKETS = 4096;
const EMPTY = Buffer.alloc(0);
/** Two frames in a row further apart than this by the stream's own clock (PTS, 90 kHz): the clock was restarted. */
const PTS_JUMP_TICKS = 5 * 90_000;
/** How far the recorded time may be from the wall clock before it is brought back. */
const DRIFT_MAX_US = 5_000_000;
/** A lag is drift, and corrected, only once every frame has had it for this long. */
const DRIFT_PERSIST_US = 60_000_000;
/** The anchor follows the stream in whole hours: 33 bits of PTS tell a difference only up to 13 hours. */
const PTS_HOUR = 3600 * 90_000;
const PTS_WRAP = 2 ** 33;

/**
 * Records one camera stream tier. ffmpeg copies the go2rtc RTSP restream into MPEG-TS (no transcode);
 * the recorder splits it into segment files at keyframes and indexes every keyframe for seeking.
 */
export class Recorder {
  private proc: ChildProcess | undefined;
  private httpAbort: AbortController | undefined;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private backoffMs = 2000;

  private demux: TsDemuxer;
  private codec: CodecInfo | undefined;
  private patPacket: Buffer | undefined;
  private pmtPacket: Buffer | undefined;
  private pmtPid = -1;
  private pending = Buffer.alloc(0);

  private anchor: { pts: number; us: number } | undefined;
  /** PTS of the video frame before this one. */
  private lastPts: number | undefined;
  /** The frames arriving late in a row: since when (wall clock), and the smallest lag among them. */
  private late: { sinceUs: number; minUs: number } | undefined;
  private held: HeldFrame | undefined;
  /** When the last keyframe came, or the first frame of a stream that has had none yet. */
  private keyframeMs: number | undefined;
  private keyframeWarned = false;
  private gop: Gop | undefined;
  private ring: Gop[] = [];
  private segment: OpenSegment | undefined;
  private recordUntilUs = 0;
  /** Recording started by hand; kept apart from `recordUntilUs` so stopping it never cuts a detection's recording. */
  private manualUntilUs = 0;
  private triggeredAtUs = 0;
  private recording = false;
  /** Last GOP written to a closed segment: the pre-buffer of the next one must not repeat it. */
  private lastWrittenGopUs = -1;
  /** Closes nobody awaits (a file cut at its length, the end of a stream) that are still writing: `stop()` waits for them. */
  private readonly closing = new Set<Promise<void>>();

  constructor(private opts: RecorderOptions) {
    this.demux = this.createDemuxer();
    mkdirSync(opts.dir, { recursive: true });
  }

  private createDemuxer(): TsDemuxer {
    return new TsDemuxer((au) => {
      if (au.keyframe && !this.codec && this.demux.codec) {
        this.codec = probeCodec(au.data, this.demux.codec);
        if (this.codec) this.opts.log('log', `${this.label} ${this.codec.codecString} ${this.codec.width}x${this.codec.height}`);
      }
    });
  }

  private get label(): string {
    return `[${this.opts.cameraId}/${this.opts.role}]`;
  }

  public get isRecording(): boolean {
    return this.recording;
  }

  public get mode(): string {
    return this.opts.mode;
  }

  public start(): void {
    this.stopped = false;
    this.spawn();
  }

  public update(opts: Partial<RecorderOptions>): void {
    const restart =
      (opts.rtspUrl !== undefined && opts.rtspUrl !== this.opts.rtspUrl) ||
      (opts.tsUrl !== undefined && opts.tsUrl !== this.opts.tsUrl) ||
      (opts.audio !== undefined && opts.audio !== this.opts.audio);
    this.opts = { ...this.opts, ...opts };
    if (restart) {
      this.proc?.kill('SIGKILL');
      this.httpAbort?.abort();
    }
  }

  /** Event mode: keep recording until `untilUs` (extended by each detection update). */
  public trigger(untilUs: number): void {
    if (!this.segment && !this.triggeredAtUs) this.triggeredAtUs = Date.now() * 1000;
    this.recordUntilUs = Math.max(this.recordUntilUs, untilUs);
  }

  /** Records until `untilUs` whatever the detections say; 0 ends the manual recording (detections keep theirs). */
  public setManual(untilUs: number): void {
    if (untilUs > 0 && !this.segment && !this.triggeredAtUs) this.triggeredAtUs = Date.now() * 1000;
    this.manualUntilUs = untilUs;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
    this.httpAbort?.abort();
    await this.closeSegment();
    // a file cut a moment ago may still be closing: its index is written after its last bytes, and at shutdown the
    // database is closed as soon as the recorders have stopped
    await Promise.all(this.closing);
  }

  private spawn(): void {
    if (this.stopped) return;
    if (this.opts.tsUrl && !this.opts.audio) {
      this.fetchTs(this.opts.tsUrl);
      return;
    }
    const args = [
      '-fflags',
      '+genpts',
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-timeout',
      '15000000',
      '-i',
      this.opts.rtspUrl,
      '-map',
      '0:v:0',
      ...(this.opts.audio
        ? // `?`: a camera without a microphone still records its video
          ['-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k']
        : ['-c', 'copy', '-an']),
      '-f',
      'mpegts',
      '-mpegts_flags',
      '+resend_headers',
      '-muxdelay',
      '0',
      'pipe:1',
    ];
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const startedAt = Date.now();

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.on('error', (err) => this.opts.log('error', `${this.label} ffmpeg: ${err.message}`));
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = undefined;
      const detail = stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : '';
      this.onStreamEnd(`ffmpeg ${code ?? 'signal'}${detail}`, startedAt);
    });
  }

  /** Reads go2rtc's own MPEG-TS stream over HTTP(S) (self-signed local certificate). */
  private fetchTs(url: string): void {
    const abort = new AbortController();
    this.httpAbort = abort;
    const startedAt = Date.now();
    const u = new URL(url);
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    let finished = false;
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      if (this.httpAbort === abort) this.httpAbort = undefined;
      this.onStreamEnd(reason, startedAt);
    };
    const req = request(u, { method: 'GET', rejectUnauthorized: false, signal: abort.signal, timeout: 20_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(`HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (chunk: Buffer) => this.onData(chunk));
      res.on('end', () => finish('stream closed'));
      res.on('error', (err) => finish(err.message));
    });
    req.on('timeout', () => req.destroy(new Error('no data for 20s')));
    req.on('error', (err) => finish(err.message));
    req.end();
  }

  private onStreamEnd(reason: string, startedAt: number): void {
    this.closeSegmentSoon();
    this.resetStream();
    if (this.stopped) return;
    if (Date.now() - startedAt > 60_000) this.backoffMs = 2000;
    this.opts.log('warn', `${this.label} stream ended (${reason}); retrying in ${this.backoffMs / 1000}s`);
    this.restartTimer = setTimeout(() => this.spawn(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private resetStream(): void {
    this.pending = Buffer.alloc(0);
    this.anchor = undefined;
    this.lastPts = undefined;
    this.late = undefined;
    this.held = undefined;
    this.keyframeMs = undefined;
    this.gop = undefined;
    this.ring = [];
    // the next connection may carry another codec, resolution or PID (camera reconfigured, fallback
    // source): learn the stream again instead of filtering it with the old one
    this.demux = this.createDemuxer();
    this.codec = undefined;
    this.patPacket = undefined;
    this.pmtPacket = undefined;
    this.pmtPid = -1;
  }

  private onData(chunk: Buffer): void {
    this.demux.push(chunk);
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let i = 0;
    while (i < data.length && data[i] !== 0x47) i++;
    for (; i + TS_PACKET <= data.length; i += TS_PACKET) {
      if (data[i] !== 0x47) {
        while (i < data.length && data[i] !== 0x47) i++;
        i -= TS_PACKET;
        continue;
      }
      this.onPacket(Buffer.from(data.subarray(i, i + TS_PACKET)));
    }
    this.pending = Buffer.from(data.subarray(i));
  }

  private onPacket(pkt: Buffer): void {
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];

    if (pid === 0) {
      this.patPacket = pkt;
      const s = 4 + 1 + pkt[4];
      this.pmtPid = ((pkt[s + 10] & 0x1f) << 8) | pkt[s + 11];
      return;
    }
    if (pid === this.pmtPid) {
      this.pmtPacket = pkt;
      return;
    }
    const audio = this.opts.audio === true && pid === this.demux.audioPid;
    if ((pid !== this.demux.videoPid && !audio) || !this.demux.codec) return;

    if (pusi && !audio) {
      // the frame before this one ended without a picture (parameter sets or SEI alone): it starts nothing
      this.release(false);
      this.watchKeyframes();
      const pes = payloadOf(pkt);
      const pts = pes && pes[7] & 0x80 ? readPts(pes, 9) : undefined;
      const frameUs = pts === undefined ? undefined : this.frameTime(pts);
      if (pes) {
        this.held = { packets: [], tail: EMPTY, tsUs: frameUs };
        this.hold(pkt, pes.subarray(9 + pes[8]));
        return;
      }
    }
    if (this.held) this.hold(pkt, audio ? undefined : tsPayload(pkt));
    else this.keep(pkt);
  }

  /**
   * The wall-clock time of a video frame: the anchor (the first frame, at the moment it arrived) plus the stream's
   * own clock. Frames keep the spacing the camera gave them however late they arrive. Packets that waited in a buffer
   * while this process was busy (a statistics query, a re-index) or the network stalled come in one burst; they used
   * to be stamped by their arrival whenever that was more than 5 s late, which moved them, and the stream after them,
   * by the length of the stall. A new anchor is taken when the PTS itself breaks between two frames (the camera
   * restarted its clock), not for a frame that is late.
   *
   * The recorded time is still kept near the wall clock over days (a camera clock runs fast or slow, the clock of
   * the server is set), by two rules a stall cannot trigger. A frame more than 5 s ahead of the wall clock gets a new
   * anchor at once, as before: waiting makes a frame late, never early. A lag of more than 5 s is corrected only
   * after every frame for a minute has had it, and by the smallest lag among them (so a server clock set forward is
   * followed a minute later, where it was at once): a stall delays frames only for the moment it takes to drain the
   * buffer, and a frame much later than the best of the run, the mark of a stall, starts the minute again.
   */
  private frameTime(pts: number): number {
    const now = Date.now() * 1000;
    if (this.lastPts !== undefined && Math.abs(ptsDelta(this.lastPts, pts)) > PTS_JUMP_TICKS) this.anchor = undefined;
    this.lastPts = pts;
    if (!this.anchor) {
      this.anchor = { pts, us: now };
      this.late = undefined;
    }
    let delta = ptsDelta(this.anchor.pts, pts);
    // exact, so no frame gets another time by it; without it the difference wraps after 13 hours of one connection
    while (delta >= PTS_HOUR) {
      this.anchor = { pts: (this.anchor.pts + PTS_HOUR) % PTS_WRAP, us: this.anchor.us + 3_600_000_000 };
      delta -= PTS_HOUR;
    }
    const tsUs = this.anchor.us + Math.round((delta / 90) * 1000);
    const lagUs = now - tsUs;
    if (lagUs < -DRIFT_MAX_US) {
      this.anchor = { pts, us: now };
      this.late = undefined;
      return now;
    }
    if (lagUs <= DRIFT_MAX_US) {
      this.late = undefined;
      return tsUs;
    }
    if (!this.late || lagUs - this.late.minUs > DRIFT_MAX_US) {
      this.late = { sinceUs: now, minUs: lagUs };
      return tsUs;
    }
    this.late.minUs = Math.min(this.late.minUs, lagUs);
    if (now - this.late.sinceUs < DRIFT_PERSIST_US) return tsUs;
    const driftUs = this.late.minUs;
    this.anchor.us += driftUs;
    this.late = undefined;
    return tsUs + driftUs;
  }

  /**
   * A keyframe is told by its picture NAL, and cameras send parameter sets and SEI in front of it (an SEI with every
   * frame on Hikvision and Dahua, VPS/SPS/PPS with HEVC) that fill the first TS packet and more. Looking at the first
   * packet alone found no keyframe in such a stream, ever: nothing was recorded while the log looked healthy. So the
   * packets of a frame wait here until its picture NAL has arrived, which for most frames is their first packet; a
   * GOP and a segment still start with the first packet of the keyframe, where the index and the reader expect it.
   */
  private hold(pkt: Buffer, es: Buffer | undefined): void {
    const held = this.held!;
    held.packets.push(pkt);
    const data = es && (held.tail.length ? Buffer.concat([held.tail, es]) : es);
    const keyframe = data ? keyframeStart(data, this.demux.codec!) : undefined;
    if (keyframe !== undefined) this.release(keyframe);
    // bounded: when the video stalls inside such a frame and the sound goes on, the packets must not pile up without end
    else if (held.packets.length >= HELD_MAX_PACKETS) this.release(false);
    // Keep a three-byte start code plus the first HEVC header byte if the second byte is in the next packet.
    else if (data) held.tail = data.subarray(Math.max(0, data.length - 4));
  }

  private release(keyframe: boolean): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    if (keyframe && held.tsUs !== undefined) this.onKeyframe(held.tsUs);
    for (const pkt of held.packets) this.keep(pkt);
  }

  private keep(pkt: Buffer): void {
    if (!this.gop) return; // wait for the first keyframe
    this.gop.packets.push(pkt);
    this.gop.bytes += TS_PACKET;
    if (this.segment) this.write(pkt);
  }

  /** Called for every video frame. Says once per recorder that the video has no keyframes: the log looks healthy otherwise. */
  private watchKeyframes(): void {
    if (this.keyframeWarned) return;
    const now = Date.now();
    this.keyframeMs ??= now;
    if (now - this.keyframeMs <= NO_KEYFRAME_WARN_MS) return;
    this.keyframeWarned = true;
    const what = `no keyframe in the video for ${NO_KEYFRAME_WARN_MS / 1000} s: a recording starts and a file is cut only at a keyframe`;
    this.opts.log('warn', `${this.label} ${what} (check the keyframe interval of the camera)`);
  }

  private onKeyframe(tsUs: number): void {
    this.keyframeMs = Date.now();
    if (this.gop) {
      this.ring.push(this.gop);
      const keepUs = Math.max(this.opts.preBufferSec, 1) * 1_000_000 + 4_000_000;
      while (this.ring.length > 1 && tsUs - this.ring[1].tsUs > keepUs) this.ring.shift();
      // bound memory: never keep more than ~64 MiB of pre-buffer
      let total = this.ring.reduce((n, g) => n + g.bytes, 0);
      while (this.ring.length > 1 && total > 64 * 1024 * 1024) total -= this.ring.shift()!.bytes;
    }
    this.gop = { tsUs, packets: [], bytes: 0 };

    const wantRecord = this.opts.mode === 'continuous' || tsUs < this.recordUntilUs || tsUs < this.manualUntilUs;
    if (this.segment) {
      const age = tsUs - this.segment.startUs;
      if (!wantRecord) {
        this.closeSegmentSoon();
      } else if (age >= this.opts.segmentSec * 1_000_000) {
        this.closeSegmentSoon();
        this.openSegment(tsUs, []);
      } else {
        this.segment.keyframes.push([this.segment.bytes, tsUs]);
      }
    } else if (wantRecord && this.codec) {
      // event mode: start from the buffered GOPs covering the pre-buffer
      const fromUs = Math.min(tsUs, this.triggeredAtUs || tsUs) - this.opts.preBufferSec * 1_000_000;
      this.triggeredAtUs = 0;
      // the GOP containing `fromUs` and everything after it
      let first = this.ring.length;
      for (let idx = this.ring.length - 1; idx >= 0; idx--) {
        first = idx;
        if (this.ring[idx].tsUs <= fromUs) break;
      }
      const backlog = this.opts.mode === 'event' ? this.ring.slice(first).filter((g) => g.tsUs > this.lastWrittenGopUs) : [];
      this.openSegment(backlog[0]?.tsUs ?? tsUs, backlog);
    }
  }

  private openSegment(startUs: number, backlog: Gop[]): void {
    try {
      this.openSegmentUnsafe(startUs, backlog);
    } catch (error) {
      // disk full / unwritable / DB busy: skip this segment, the next keyframe tries again
      this.opts.log('error', `${this.label} cannot open a segment: ${(error as Error).message}`);
    }
  }

  private openSegmentUnsafe(startUs: number, backlog: Gop[]): void {
    if (!this.codec || !this.patPacket || !this.pmtPacket) return;
    const day = new Date(startUs / 1000).toISOString().slice(0, 10);
    const dir = join(this.opts.dir, day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Math.round(startUs / 1000)}-${this.opts.role}.ts`);
    const stream = createWriteStream(path);
    // without a listener a write error (ENOSPC, EIO) is an uncaught exception that kills the plugin
    stream.on('error', (error) => this.onWriteError(stream, error));
    let id: number;
    try {
      id = this.opts.store.addSegment({
        camera_id: this.opts.cameraId,
        role: this.opts.role,
        start_us: startUs,
        end_us: startUs,
        path,
        bytes: 0,
        codec: this.codec.codec,
        codec_string: this.codec.codecString,
        width: this.codec.width,
        height: this.codec.height,
        video_pid: this.demux.videoPid,
        audio_pid: this.opts.audio ? this.demux.audioPid : -1,
        keyframes: '[]',
      });
    } catch (error) {
      // no row, no segment: the file must not stay open and on disk, or every keyframe adds one more while the database fails
      stream.once('close', () => void rm(path, { force: true }).catch((e: Error) => this.opts.log('error', `${this.label} cannot remove ${path}: ${e.message}`)));
      stream.destroy();
      throw error;
    }
    this.segment = { id, path, stream, startUs, endUs: startUs, bytes: 0, keyframes: [], lastFlush: Date.now() };
    this.write(this.patPacket);
    this.write(this.pmtPacket);
    for (const gop of backlog) {
      this.segment.keyframes.push([this.segment.bytes, gop.tsUs]);
      for (const p of gop.packets) this.write(p);
    }
    if (this.gop) this.segment.keyframes.push([this.segment.bytes, this.gop.tsUs]);
    // index the first keyframes now: playback and scrub reaching a brand-new segment (rollover at the
    // live tip) must not see an empty index until the first periodic flush
    this.saveIndex(this.segment);
    this.setRecording(true);
    this.opts.onSegment();
  }

  private onWriteError(stream: NodeJS.WritableStream, error: Error): void {
    this.opts.log('error', `${this.label} write failed: ${error.message}`);
    const seg = this.segment;
    if (seg?.stream !== stream || !seg) return;
    this.segment = undefined;
    this.lastWrittenGopUs = Math.max(this.lastWrittenGopUs, seg.keyframes.at(-1)?.[1] ?? -1);
    try {
      if (seg.keyframes.length) this.opts.store.updateSegment(seg.id, seg.endUs, seg.bytes, JSON.stringify(seg.keyframes));
      else this.opts.store.deleteSegment(seg.id);
    } catch (error) {
      // the row keeps what the last flush wrote. Said once for a run of failures, like the flushes of this file (saveIndex)
      if (!seg.indexFailed) this.opts.log('error', `${this.label} cannot update the index: ${(error as Error).message}`);
      seg.indexFailed = true;
    }
    this.setRecording(false);
    this.opts.onSegment();
  }

  private write(pkt: Buffer): void {
    const seg = this.segment!;
    seg.stream.write(pkt);
    seg.bytes += pkt.length;
    const lastKf = seg.keyframes.at(-1);
    if (this.gop) seg.endUs = Math.max(seg.endUs, this.gop.tsUs, lastKf?.[1] ?? 0);
    if (Date.now() - seg.lastFlush > FLUSH_MS) {
      seg.lastFlush = Date.now();
      seg.endUs = Math.max(seg.endUs, Date.now() * 1000 - 500_000);
      this.saveIndex(seg);
    }
  }

  /**
   * Writes the index row of an open segment. The database can fail (SQLITE_FULL on a full disk, an I/O error) and
   * this runs in the `data` handler of the stream: an exception there is uncaught and ends the plugin process, and
   * with it the recording of every camera. The file keeps recording and the next flush writes the row again.
   */
  private saveIndex(seg: OpenSegment): void {
    try {
      this.opts.store.updateSegment(seg.id, seg.endUs, seg.bytes, JSON.stringify(seg.keyframes));
      seg.indexFailed = false;
    } catch (error) {
      if (!seg.indexFailed) this.opts.log('error', `${this.label} cannot update the index: ${(error as Error).message}`);
      seg.indexFailed = true;
    }
  }

  /** Closes the segment without waiting for it: a rejection nobody awaits ends the process, so a failure is logged here. */
  private closeSegmentSoon(): void {
    const closing = this.closeSegment()
      .catch((error: Error) => this.opts.log('error', `${this.label} closing a segment failed: ${error.message}`))
      .finally(() => this.closing.delete(closing));
    this.closing.add(closing);
  }

  private async closeSegment(): Promise<void> {
    const seg = this.segment;
    if (!seg) return;
    this.segment = undefined;
    seg.endUs = Math.max(seg.endUs, Date.now() * 1000);
    this.lastWrittenGopUs = Math.max(this.lastWrittenGopUs, seg.keyframes.at(-1)?.[1] ?? -1);
    await new Promise<void>((resolve) => seg.stream.end(() => resolve()));
    try {
      if (seg.keyframes.length === 0) {
        this.opts.store.deleteSegment(seg.id);
      } else {
        this.opts.store.updateSegment(seg.id, seg.endUs, seg.bytes, JSON.stringify(seg.keyframes));
      }
    } catch (error) {
      // the recorder goes on: the row keeps what the last flush wrote, the rest of this file is not in the archive
      this.opts.log('error', `${this.label} cannot save the index of ${seg.path}: ${(error as Error).message}`);
    }
    if (!this.segment) this.setRecording(false);
    this.opts.onSegment();
  }

  private setRecording(recording: boolean): void {
    if (this.recording === recording) return;
    this.recording = recording;
    this.opts.onStateChange(recording);
  }

  /** Current open segment id (live tip), if recording. */
  public get liveSegmentId(): number | undefined {
    return this.segment?.id;
  }
}

function tsPayload(pkt: Buffer): Buffer | undefined {
  const afc = (pkt[3] >> 4) & 0x3;
  let p = 4;
  if (afc === 2 || afc === 3) p += 1 + pkt[4];
  if (afc === 0 || afc === 2 || p >= TS_PACKET) return undefined;
  return pkt.subarray(p);
}

/** The payload of a packet that starts a PES. */
function payloadOf(pkt: Buffer): Buffer | undefined {
  const payload = tsPayload(pkt);
  return payload && payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1 ? payload : undefined;
}

function readPts(b: Buffer, i: number): number {
  return (b[i] & 0x0e) * 536870912 + (b[i + 1] << 22) + ((b[i + 2] & 0xfe) << 14) + (b[i + 3] << 7) + ((b[i + 4] & 0xfe) >> 1);
}
