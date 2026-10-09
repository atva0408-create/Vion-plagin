/**
 * Listening to a camera's microphone, two ways:
 * - for an answer (VOICE): the sound is opened only for a short window after a phrase, and the first utterance is cut
 *   out by voice activity; the stream closes as soon as it ends or the window passes;
 * - a conversation (the intercom's door agent): the sound stays open while the agent talks with a visitor, and each
 *   utterance comes out as it ends, except while the agent itself speaks (its own phrase comes back through the
 *   microphone).
 * The sound is decoded to 16 kHz mono by ffmpeg; nothing is written to disk.
 *
 * Not the camera's audio sensor: a camera has one audio sensor slot (YAMNet and the like), and speech recognition
 * there would push it out.
 */
import { spawn } from 'node:child_process';

import { LISTEN_RATE } from './engine.js';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Clock } from './clock.js';
import type { SpeechEngine, VoiceActivity } from './engine.js';

/** The part of the SDK's `CameraDeviceSource` listening uses. */
export interface AudioSource {
  audioCodecs?: readonly unknown[];
  generateRTSPUrl(options: { video?: boolean; audio?: boolean }): string;
}

/** The part of the SDK's `CameraDevice` listening uses. */
export interface ListenCamera {
  readonly name: string;
  readonly sources: readonly AudioSource[];
  readonly streamSource: AudioSource;
}

export interface Listener {
  /** The first utterance heard within the window, or undefined when nobody spoke. */
  listen(camera: ListenCamera, windowMs: number): Promise<Float32Array | undefined>;
}

/** Spawns ffmpeg reading the camera's sound as 16 kHz mono float samples on stdout. */
export function cameraAudio(ffmpeg: string, camera: ListenCamera): ChildProcessByStdio<null, Readable, Readable> {
  const source = camera.sources.find((s) => s.audioCodecs?.length) ?? camera.streamSource;
  const url = source.generateRTSPUrl({ video: false, audio: true });
  return spawn(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-vn', '-ac', '1', '-ar', String(LISTEN_RATE), '-f', 'f32le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Turns chunks of little-endian float32 bytes into samples, keeping a cut sample for the next chunk. */
export class FloatChunks {
  private carry: Buffer = Buffer.alloc(0);

  take(chunk: Buffer): Float32Array {
    const bytes = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = bytes.length - (bytes.length % 4);
    this.carry = bytes.subarray(usable);
    const samples = new Float32Array(usable / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
    return samples;
  }
}

/** An utterance that started inside the window may finish after it, up to this long. */
const MAX_UTTERANCE_MS = 8_000;

export class FfmpegListener implements Listener {
  constructor(
    private ffmpegPath: () => Promise<string>,
    private engine: SpeechEngine,
    private log: (message: string) => void,
  ) {}

  async listen(camera: ListenCamera, windowMs: number): Promise<Float32Array | undefined> {
    const [ffmpeg, vad] = await Promise.all([this.ffmpegPath(), this.engine.voiceActivity()]);
    const child = cameraAudio(ffmpeg, camera);
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-500);
    });

    return new Promise((resolve) => {
      const chunks = new FloatChunks();
      let done = false;
      let windowOver = false;
      const finish = (utterance: Float32Array | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(windowTimer);
        clearTimeout(hardStop);
        child.kill('SIGKILL');
        resolve(utterance);
      };
      const windowTimer = setTimeout(() => {
        windowOver = true;
        if (!vad.speaking()) {
          vad.flush();
          finish(vad.utterance());
        }
      }, windowMs);
      const hardStop = setTimeout(() => {
        vad.flush();
        finish(vad.utterance());
      }, windowMs + MAX_UTTERANCE_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        vad.accept(chunks.take(chunk));
        const utterance = vad.utterance();
        if (utterance) finish(utterance);
        else if (windowOver && !vad.speaking()) finish(undefined);
      });
      child.on('close', (code) => {
        if (!done && code !== 0 && code !== null) this.log(`listening on ${camera.name} stopped: ${errors.trim() || `ffmpeg exit ${code}`}`);
        vad.flush();
        finish(vad.utterance());
      });
      child.on('error', (error) => {
        this.log(`listening on ${camera.name} failed: ${error.message}`);
        finish(undefined);
      });
    });
  }
}

/**
 * Utterances of a conversation, from samples fed as they come (ffmpeg from a camera, or RTP of a SIP call).
 * While deaf (the agent speaks, and a little after) samples are dropped and a half-heard utterance is thrown away, so
 * the agent never answers its own voice.
 */
export class Hearing {
  private deafUntilMs = 0;
  private utteranceListeners: ((samples: Float32Array) => void)[] = [];
  private audioListeners: ((samples: Float32Array) => void)[] = [];

  constructor(
    private vad: VoiceActivity,
    private clock: Clock,
  ) {}

  onUtterance(listener: (samples: Float32Array) => void): void {
    this.utteranceListeners.push(listener);
  }

  /** Every sample heard while not deaf, for a voice message. */
  onAudio(listener: (samples: Float32Array) => void): void {
    this.audioListeners.push(listener);
  }

  /** Drop what comes until the time (ms of the clock); a phrase cut by it is thrown away. */
  deafUntil(until: number): void {
    if (until <= this.deafUntilMs) return;
    this.deafUntilMs = until;
    this.vad.flush();
    while (this.vad.utterance()) {
      // what was being heard when the agent began to speak: not an answer to it
    }
  }

  deaf(): boolean {
    return this.clock.now() < this.deafUntilMs;
  }

  speaking(): boolean {
    return !this.deaf() && this.vad.speaking();
  }

  feed(samples: Float32Array): void {
    if (this.deaf()) return;
    for (const listener of this.audioListeners) listener(samples);
    this.vad.accept(samples);
    for (let utterance = this.vad.utterance(); utterance; utterance = this.vad.utterance()) {
      for (const listener of this.utteranceListeners) listener(utterance);
    }
  }

  /** The end of the sound: an utterance cut by it comes out too. */
  end(): void {
    if (this.deaf()) return;
    this.vad.flush();
    for (let utterance = this.vad.utterance(); utterance; utterance = this.vad.utterance()) {
      for (const listener of this.utteranceListeners) listener(utterance);
    }
  }
}

/** A camera's sound opened for a conversation; `stop()` closes it. */
export interface OpenAudio {
  hearing: Hearing;
  /** Resolves when the sound ends: undefined when stopped, else why. */
  ended: Promise<string | undefined>;
  stop(): void;
}

/** Opens the camera's sound for a conversation: it stays open until `stop()`. */
export async function listenToCamera(ffmpegPath: () => Promise<string>, engine: SpeechEngine, camera: ListenCamera, clock: Clock): Promise<OpenAudio> {
  const [ffmpeg, vad] = await Promise.all([ffmpegPath(), engine.voiceActivity()]);
  const hearing = new Hearing(vad, clock);
  const child = cameraAudio(ffmpeg, camera);
  const chunks = new FloatChunks();
  let stopped = false;
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-500);
  });
  child.stdout.on('data', (chunk: Buffer) => hearing.feed(chunks.take(chunk)));
  const ended = new Promise<string | undefined>((resolve) => {
    child.on('close', (code) => {
      hearing.end();
      resolve(stopped ? undefined : errors.trim() || `ffmpeg exit ${code}`);
    });
    child.on('error', (error) => resolve(stopped ? undefined : error.message));
  });
  return {
    hearing,
    ended,
    stop: () => {
      stopped = true;
      child.kill('SIGKILL');
    },
  };
}
