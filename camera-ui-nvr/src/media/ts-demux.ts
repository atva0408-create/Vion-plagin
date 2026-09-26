/**
 * Minimal MPEG-TS demuxer for recorded video: finds the video PID through PAT/PMT, reassembles PES
 * packets into access units (Annex-B for H.264/HEVC, exactly what the browser's VideoDecoder expects
 * without a `description`) and reports keyframes and the byte offset each access unit starts at.
 */

export const TS_PACKET = 188;
const SYNC = 0x47;

export type VideoCodec = 'h264' | 'h265';

export interface AccessUnit {
  /** Annex-B payload of the access unit. */
  data: Buffer;
  /** Presentation timestamp in 90 kHz ticks (33 bit, not unwrapped). */
  pts: number;
  keyframe: boolean;
  /** File offset of the TS packet that started this PES (for seeking). */
  offset: number;
}

const STREAM_TYPES: Record<number, VideoCodec> = { 0x1b: 'h264', 0x24: 'h265' };

export class TsDemuxer {
  public videoPid = -1;
  public codec: VideoCodec | undefined;

  private pmtPid = -1;
  private pes: Buffer[] = [];
  private pesOffset = 0;
  private remainder: Buffer = Buffer.alloc(0);
  private position = 0;

  constructor(
    private readonly onAccessUnit: (au: AccessUnit) => void,
    known?: { videoPid: number; codec: VideoCodec },
  ) {
    if (known) {
      this.videoPid = known.videoPid;
      this.codec = known.codec;
    }
  }

  /** Feeds raw TS bytes; `startOffset` is the absolute file offset of `chunk` for the first call. */
  public push(chunk: Buffer, startOffset?: number): void {
    if (startOffset !== undefined && this.remainder.length === 0) {
      this.position = startOffset;
    }

    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const base = this.position - this.remainder.length;
    let i = 0;

    // resync on garbage
    while (i < data.length && data[i] !== SYNC) i++;

    for (; i + TS_PACKET <= data.length; i += TS_PACKET) {
      if (data[i] !== SYNC) {
        let j = i + 1;
        while (j < data.length && data[j] !== SYNC) j++;
        i = j - TS_PACKET;
        continue;
      }
      this.packet(data.subarray(i, i + TS_PACKET), base + i);
    }

    this.remainder = Buffer.from(data.subarray(i));
    this.position = base + data.length;
  }

  /** Emits the last pending access unit (end of file). */
  public flush(): void {
    this.emitPes();
  }

  private packet(pkt: Buffer, offset: number): void {
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const afc = (pkt[3] >> 4) & 0x3;
    let p = 4;
    if (afc === 2 || afc === 3) p += 1 + pkt[4];
    if (afc === 0 || afc === 2 || p >= TS_PACKET) return;
    const payload = pkt.subarray(p);

    if (pid === 0) {
      this.parsePat(payload, pusi);
    } else if (pid === this.pmtPid) {
      this.parsePmt(payload, pusi);
    } else if (pid === this.videoPid) {
      if (pusi) {
        this.emitPes();
        this.pesOffset = offset;
      }
      if (pusi || this.pes.length) this.pes.push(Buffer.from(payload));
    }
  }

  private parsePat(payload: Buffer, pusi: boolean): void {
    const s = pusi ? 1 + payload[0] : 0;
    const sectionLength = ((payload[s + 1] & 0x0f) << 8) | payload[s + 2];
    const end = Math.min(payload.length, s + 3 + sectionLength - 4);
    for (let i = s + 8; i + 4 <= end; i += 4) {
      const program = (payload[i] << 8) | payload[i + 1];
      if (program !== 0) {
        this.pmtPid = ((payload[i + 2] & 0x1f) << 8) | payload[i + 3];
        return;
      }
    }
  }

  private parsePmt(payload: Buffer, pusi: boolean): void {
    const s = pusi ? 1 + payload[0] : 0;
    const sectionLength = ((payload[s + 1] & 0x0f) << 8) | payload[s + 2];
    const programInfoLength = ((payload[s + 10] & 0x0f) << 8) | payload[s + 11];
    const end = Math.min(payload.length, s + 3 + sectionLength - 4);
    for (let i = s + 12 + programInfoLength; i + 5 <= end;) {
      const type = payload[i];
      const pid = ((payload[i + 1] & 0x1f) << 8) | payload[i + 2];
      const esInfo = ((payload[i + 3] & 0x0f) << 8) | payload[i + 4];
      const codec = STREAM_TYPES[type];
      if (codec && this.videoPid < 0) {
        this.videoPid = pid;
        this.codec = codec;
      }
      i += 5 + esInfo;
    }
  }

  private emitPes(): void {
    if (!this.pes.length) return;
    const pes = Buffer.concat(this.pes);
    this.pes = [];
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;

    const flags = pes[7];
    const headerLength = pes[8];
    let pts = 0;
    if (flags & 0x80) {
      pts = readTimestamp(pes, 9);
    }
    const data = pes.subarray(9 + headerLength);
    if (!data.length) return;
    this.onAccessUnit({ data, pts, keyframe: isKeyframe(data, this.codec ?? 'h264'), offset: this.pesOffset });
  }
}

function readTimestamp(b: Buffer, i: number): number {
  return (
    (b[i] & 0x0e) * 536870912 + // << 29
    (b[i + 1] << 22) +
    ((b[i + 2] & 0xfe) << 14) +
    (b[i + 3] << 7) +
    ((b[i + 4] & 0xfe) >> 1)
  );
}

/** Iterates Annex-B NAL units (start-code separated), yielding the NAL payloads. */
export function *nalUnits(data: Buffer): Generator<Buffer> {
  let start = -1;
  let i = 0;
  while (i + 3 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const sc = data[i + 2] === 1 ? 3 : 4;
      if (start >= 0) yield data.subarray(start, i);
      i += sc;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

export function nalType(nal: Buffer, codec: VideoCodec): number {
  return codec === 'h264' ? nal[0] & 0x1f : (nal[0] >> 1) & 0x3f;
}

export function isKeyframe(data: Buffer, codec: VideoCodec): boolean {
  for (const nal of nalUnits(data)) {
    const t = nalType(nal, codec);
    if (codec === 'h264' ? t === 5 : t >= 16 && t <= 21) return true;
  }
  return false;
}

/** 33-bit PTS difference in ticks, tolerant of a single wrap-around. */
export function ptsDelta(from: number, to: number): number {
  const WRAP = 2 ** 33;
  let d = to - from;
  if (d < -WRAP / 2) d += WRAP;
  if (d > WRAP / 2) d -= WRAP;
  return d;
}
