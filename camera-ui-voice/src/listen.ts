/**
 * Listening for an answer: the camera's sound is opened only for a short window after VOICE has spoken, decoded to
 * 16 kHz mono by ffmpeg, and the first utterance is cut out by voice activity. Nothing is written to disk, and the
 * stream is closed as soon as the utterance ends or the window passes.
 *
 * Not the camera's audio sensor: a camera has one audio sensor slot (YAMNet and the like), and speech recognition
 * there would push it out.
 */
import { spawn } from 'node:child_process';

import { LISTEN_RATE } from './engine.js';

import type { CameraDevice } from '@camera.ui/sdk';
import type { SpeechEngine } from './engine.js';

export interface Listener {
  /** The first utterance heard within the window, or undefined when nobody spoke. */
  listen(camera: CameraDevice, windowMs: number): Promise<Float32Array | undefined>;
}

/** An utterance that started inside the window may finish after it, up to this long. */
const MAX_UTTERANCE_MS = 8_000;

export class FfmpegListener implements Listener {
  constructor(
    private ffmpegPath: () => Promise<string>,
    private engine: SpeechEngine,
    private log: (message: string) => void,
  ) {}

  async listen(camera: CameraDevice, windowMs: number): Promise<Float32Array | undefined> {
    const source = camera.sources.find((s) => s.audioCodecs?.length) ?? camera.streamSource;
    const url = source.generateRTSPUrl({ video: false, audio: true });
    const [ffmpeg, vad] = await Promise.all([this.ffmpegPath(), this.engine.voiceActivity()]);
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-vn', '-ac', '1', '-ar', String(LISTEN_RATE), '-f', 'f32le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-500);
    });

    return new Promise((resolve) => {
      let carry = Buffer.alloc(0);
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
        const bytes = Buffer.concat([carry, chunk]);
        const usable = bytes.length - (bytes.length % 4);
        carry = bytes.subarray(usable);
        const samples = new Float32Array(usable / 4);
        for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
        vad.accept(samples);
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
