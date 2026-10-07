/**
 * Speech synthesis, recognition and voice activity on this machine, with sherpa-onnx (Apache-2.0): no sound leaves the
 * server. Models load on first use and are let go after a few idle minutes, so an idle plugin holds no model memory
 * and uses no processor.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { PACKS, VOICES } from './models.js';

import type { ModelStore } from './models.js';
import type { Language } from './speech.js';

export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

/** Voice activity over a stream of 16 kHz samples: whole utterances come out when the speaker pauses. */
export interface VoiceActivity {
  accept(samples: Float32Array): void;
  /** The first finished utterance, if any. */
  utterance(): Float32Array | undefined;
  speaking(): boolean;
  /** Ends the stream: an utterance cut by the end of the window comes out too. */
  flush(): void;
}

export interface SpeechEngine {
  synthesize(text: string, language: Language, speed: number): Promise<Audio>;
  transcribe(samples: Float32Array, language: Language): Promise<string>;
  voiceActivity(): Promise<VoiceActivity>;
}

export const LISTEN_RATE = 16_000;
const IDLE_UNLOAD_MS = 3 * 60_000;
const THREADS = 2;

type Sherpa = any;

function loadSherpa(): Sherpa {
  try {
    return createRequire(import.meta.url)('sherpa-onnx-node');
  } catch (error) {
    throw new Error(`the speech engine (sherpa-onnx-node) is not installed for this system: ${(error as Error).message}`);
  }
}

interface Loaded<T> {
  value: T;
  timer?: NodeJS.Timeout;
}

export class SherpaEngine implements SpeechEngine {
  private sherpa: Sherpa | undefined;
  private tts = new Map<Language, Loaded<Promise<any>>>();
  private stt = new Map<string, Loaded<Promise<any>>>();

  constructor(
    private store: ModelStore,
    private log: (message: string) => void,
  ) {}

  async synthesize(text: string, language: Language, speed: number): Promise<Audio> {
    const tts = await this.use(this.tts, language, async () => {
      const voice = VOICES[language];
      const [dir, espeak] = await Promise.all([this.store.ensure(voice.pack), this.store.ensure(PACKS.espeak)]);
      return this.lib().OfflineTts.createAsync({
        model: {
          vits: { model: join(dir, voice.model), tokens: join(dir, 'tokens.txt'), dataDir: join(espeak, 'espeak-ng-data') },
          numThreads: THREADS,
          provider: 'cpu',
        },
        maxNumSentences: 2,
      });
    });
    const audio = await tts.generateAsync({ text, sid: 0, speed });
    return { samples: audio.samples as Float32Array, sampleRate: audio.sampleRate as number };
  }

  async transcribe(samples: Float32Array, language: Language): Promise<string> {
    const key = language === 'ru' ? 'ru' : `whisper-${language}`;
    const recognizer = await this.use(this.stt, key, async () => {
      const feat = { sampleRate: LISTEN_RATE, featureDim: 80 };
      if (language === 'ru') {
        const dir = await this.store.ensure(PACKS.sttRu);
        return this.lib().OfflineRecognizer.createAsync({
          featConfig: feat,
          modelConfig: {
            transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
            tokens: join(dir, 'tokens.txt'),
            modelType: 'transducer',
            numThreads: THREADS,
            provider: 'cpu',
          },
          decodingMethod: 'greedy_search',
        });
      }
      const dir = await this.store.ensure(PACKS.sttWhisper);
      return this.lib().OfflineRecognizer.createAsync({
        featConfig: feat,
        modelConfig: {
          whisper: { encoder: join(dir, 'base-encoder.int8.onnx'), decoder: join(dir, 'base-decoder.int8.onnx'), language, task: 'transcribe' },
          tokens: join(dir, 'base-tokens.txt'),
          numThreads: THREADS,
          provider: 'cpu',
        },
      });
    });
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: LISTEN_RATE, samples });
    const result = await recognizer.decodeAsync(stream);
    return String(result?.text ?? '').trim();
  }

  async voiceActivity(): Promise<VoiceActivity> {
    const dir = await this.store.ensure(PACKS.vad);
    const vad = new (this.lib().Vad)(
      {
        sileroVad: { model: join(dir, 'silero_vad.onnx'), threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.6, windowSize: 512 },
        sampleRate: LISTEN_RATE,
        numThreads: 1,
        provider: 'cpu',
      },
      30,
    );
    let pending = new Float32Array(0);
    return {
      accept(samples) {
        const joined = new Float32Array(pending.length + samples.length);
        joined.set(pending);
        joined.set(samples, pending.length);
        let offset = 0;
        for (; offset + 512 <= joined.length; offset += 512) vad.acceptWaveform(joined.subarray(offset, offset + 512));
        pending = joined.slice(offset);
      },
      utterance() {
        if (vad.isEmpty()) return undefined;
        const segment = vad.front();
        vad.pop();
        return new Float32Array(segment.samples);
      },
      speaking: () => vad.isDetected(),
      flush: () => vad.flush(),
    };
  }

  private lib(): Sherpa {
    this.sherpa ??= loadSherpa();
    return this.sherpa;
  }

  /** The loaded model, shared by callers that come while it loads; let go after a while without use. */
  private async use<K, T>(cache: Map<K, Loaded<Promise<T>>>, key: K, create: () => Promise<T>): Promise<T> {
    let entry = cache.get(key);
    if (!entry) {
      const started = Date.now();
      const value = create().then((loaded) => {
        this.log(`speech model ${String(key)} loaded in ${Date.now() - started} ms`);
        return loaded;
      });
      entry = { value };
      cache.set(key, entry);
      value.catch(() => cache.delete(key));
    }
    clearTimeout(entry.timer);
    // the native memory goes with the object
    entry.timer = setTimeout(() => {
      cache.delete(key);
      this.log(`speech model ${String(key)} unloaded`);
    }, IDLE_UNLOAD_MS);
    entry.timer.unref();
    return entry.value;
  }
}
