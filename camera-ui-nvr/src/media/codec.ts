import { nalType, nalUnits } from './ts-demux.js';

import type { VideoCodec } from './ts-demux.js';

export interface CodecInfo {
  codec: VideoCodec;
  /** WebCodecs codec string, e.g. `avc1.64001F` / `hvc1.1.6.L120.B0`. */
  codecString: string;
  width: number;
  height: number;
  /** Parameter sets (Annex-B, with start codes) to prepend to keyframes that lack them. */
  parameterSets: Buffer;
}

class BitReader {
  private bit = 0;
  constructor(private readonly buf: Buffer) {}

  public u(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const byte = this.buf[this.bit >> 3] ?? 0;
      v = v * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }

  public ue(): number {
    let zeros = 0;
    while (this.u(1) === 0 && zeros < 32) zeros++;
    return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
  }

  public se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  }

  public skip(n: number): void {
    this.bit += n;
  }
}

/** Removes emulation-prevention bytes (00 00 03 -> 00 00). */
function rbsp(nal: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const START = Buffer.from([0, 0, 0, 1]);

function parseH264Sps(nal: Buffer): { codecString: string; width: number; height: number } {
  const profile = nal[1];
  const constraints = nal[2];
  const level = nal[3];
  const r = new BitReader(rbsp(nal.subarray(4)));
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
        if (r.u(1)) {
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1);
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let crop = { l: 0, r: 0, t: 0, b: 0 };
  if (r.u(1)) crop = { l: r.ue(), r: r.ue(), t: r.ue(), b: r.ue() };
  const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subH = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    codecString: `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`,
    width: widthMbs * 16 - subW * (crop.l + crop.r),
    height: (2 - frameMbsOnly) * heightMapUnits * 16 - subH * (crop.t + crop.b),
  };
}

function parseH265Sps(nal: Buffer): { codecString: string; width: number; height: number } {
  const r = new BitReader(rbsp(nal.subarray(2)));
  r.u(4); // sps_video_parameter_set_id
  const maxSubLayers = r.u(3);
  r.u(1);
  // profile_tier_level
  const profileSpace = r.u(2);
  const tier = r.u(1);
  const profileIdc = r.u(5);
  const compat = r.u(32);
  const constraintBytes: number[] = [];
  for (let i = 0; i < 6; i++) constraintBytes.push(r.u(8));
  const levelIdc = r.u(8);
  const subProfilePresent: boolean[] = [];
  const subLevelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayers; i++) {
    subProfilePresent.push(r.u(1) === 1);
    subLevelPresent.push(r.u(1) === 1);
  }
  if (maxSubLayers > 0) for (let i = maxSubLayers; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayers; i++) {
    if (subProfilePresent[i]) r.skip(88);
    if (subLevelPresent[i]) r.u(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chroma = r.ue();
  if (chroma === 3) r.u(1);
  let width = r.ue();
  let height = r.ue();
  if (r.u(1)) {
    const sub = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    const l = r.ue();
    const rr = r.ue();
    const t = r.ue();
    const b = r.ue();
    width -= sub * (l + rr);
    height -= subH * (t + b);
  }

  // hvc1.<space><profile>.<compat reversed hex>.<tier><level>.<constraints>
  let reversed = 0;
  for (let i = 0; i < 32; i++) reversed = reversed * 2 + ((compat >>> i) & 1);
  const space = ['', 'A', 'B', 'C'][profileSpace] ?? '';
  let lastNonZero = -1;
  constraintBytes.forEach((b, i) => {
    if (b !== 0) lastNonZero = i;
  });
  const constraints = constraintBytes.slice(0, lastNonZero + 1).map((b) => b.toString(16).toUpperCase());
  const codecString = [
    'hvc1',
    `${space}${profileIdc}`,
    reversed.toString(16).toUpperCase(),
    `${tier ? 'H' : 'L'}${levelIdc}`,
    ...(constraints.length ? constraints : ['B0']),
  ].join('.');
  return { codecString, width, height };
}

/** Extracts codec info from a keyframe access unit, or undefined when it carries no SPS. */
export function probeCodec(data: Buffer, codec: VideoCodec): CodecInfo | undefined {
  const sets: Buffer[] = [];
  let info: { codecString: string; width: number; height: number } | undefined;
  for (const nal of nalUnits(data)) {
    const t = nalType(nal, codec);
    const isSps = codec === 'h264' ? t === 7 : t === 33;
    const isParam = codec === 'h264' ? t === 7 || t === 8 : t >= 32 && t <= 34;
    if (isParam) sets.push(START, nal);
    if (isSps && !info) {
      try {
        info = codec === 'h264' ? parseH264Sps(nal) : parseH265Sps(nal);
      } catch {
        // malformed SPS: fall through
      }
    }
  }
  return info ? { codec, ...info, parameterSets: Buffer.concat(sets) } : undefined;
}

/** Ensures a keyframe starts with parameter sets so it decodes on its own. */
export function withParameterSets(data: Buffer, codec: VideoCodec, info: CodecInfo | undefined): Buffer {
  if (!info?.parameterSets.length) return data;
  for (const nal of nalUnits(data)) {
    const t = nalType(nal, codec);
    if (codec === 'h264' ? t === 7 : t === 33) return data;
  }
  return Buffer.concat([info.parameterSets, data]);
}
