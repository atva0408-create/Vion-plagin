/**
 * The agent's sound at a panel, from the speech package: phrases synthesized on this server and sent into the panel's
 * talk channel, the panel's microphone opened for the whole conversation, utterances recognized here. The sound of the
 * visitor never leaves the server; only the voice message is kept, as an Opus file of the visit.
 *
 * Phrases the agent says often (the greeting, "one moment", "please repeat") are kept synthesized, so the first phrase
 * after "the agent answers" does not wait for the synthesis (ТЗ 6.10).
 */
import { spawn } from 'node:child_process';

import { LISTEN_RATE, listenToCamera } from '@vionvision/speech';

import type { Audio, CameraSpeaker, Clock, Language, ListenCamera, SpeechEngine } from '@vionvision/speech';
import type { ConversationIO } from './agent/conversation.js';

const CACHED_PHRASES = 24;

/** Synthesized phrases by language, speed and text; the oldest goes first. */
export class PhraseCache {
  private entries = new Map<string, Promise<Audio>>();

  constructor(private readonly engine: SpeechEngine) {}

  get(text: string, language: Language, speed: number): Promise<Audio> {
    const key = `${language}\u0000${speed}\u0000${text}`;
    const found = this.entries.get(key);
    if (found) {
      this.entries.delete(key);
      this.entries.set(key, found);
      return found;
    }
    const made = this.engine.synthesize(text, language, speed);
    this.entries.set(key, made);
    // a failed synthesis is not kept: the next phrase tries again
    made.catch(() => this.entries.delete(key));
    while (this.entries.size > CACHED_PHRASES) this.entries.delete(this.entries.keys().next().value!);
    return made;
  }
}

export interface PanelSound {
  camera: ListenCamera;
  speaker: CameraSpeaker;
  engine: SpeechEngine;
  cache: PhraseCache;
  clock: Clock;
  ffmpegPath: () => Promise<string>;
  language: () => Language;
  speed: () => number;
}

export function panelSound(s: PanelSound): ConversationIO {
  return {
    prepare: async (text) => {
      const audio = await s.cache.get(text, s.language(), s.speed());
      return {
        durationMs: Math.round((audio.samples.length / audio.sampleRate) * 1000),
        play: () => s.speaker.speak(audio.samples, audio.sampleRate),
      };
    },
    listen: () => listenToCamera(s.ffmpegPath, s.engine, s.camera, s.clock),
    transcribe: (samples) => s.engine.transcribe(samples, s.language()),
  };
}

/** The voice message as Opus in Ogg, by the server's ffmpeg. */
export function saveOpus(ffmpeg: string, samples: Float32Array, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'f32le',
      '-ar',
      String(LISTEN_RATE),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      '24k',
      '-y',
      file,
    ];
    const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-500);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `ffmpeg exit ${code}`))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}
