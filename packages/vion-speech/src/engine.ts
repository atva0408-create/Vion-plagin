/**
 * Speech synthesis, recognition and voice activity on this machine, with sherpa-onnx (Apache-2.0): no sound leaves the
 * server. Models load on first use and are let go after a few idle minutes, so an idle plugin holds no model memory
 * and uses no processor.
 */
import { join } from 'node:path';

import { PACKS, VOICES } from './models.js';

import type { Language } from './language.js';
import type { ModelStore } from './models.js';

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
/**
 * sherpa-onnx 1.13.8 counts the samples a voice activity was given in int32 that never wrap: the head and the tail of
 * its buffer (circular-buffer.h) and the silero model's current_sample_. Past 2^31, 37 hours at 16 kHz, it writes
 * outside the buffer: VOICE listening for a call died of SIGSEGV 37 h after it opened the microphone (bench,
 * 2026-10-30). Its reset() zeroes them all (VoiceActivityDetector::Reset), so the voice activity is reset after half
 * of that, at the first moment nobody speaks...
 */
const RESET_AFTER = 2 ** 30;
/** ...and at this many anyway when it hears speech all the time (a TV): the phrase is cut, still far below 2^31. */
const RESET_BY = RESET_AFTER + 2 ** 29;

type Sherpa = any;

/**
 * Loads the native module `sherpa-onnx-node`. Given by the plugin: the module is installed with the plugin, and only
 * the plugin's own `require` finds it (this package is bundled into the plugin, its sources live elsewhere).
 */
export type SherpaLoader = () => unknown;

function loadSherpa(load: SherpaLoader): Sherpa {
  try {
    return load();
  } catch (error) {
    throw new Error(`the speech engine (sherpa-onnx-node) is not installed for this system: ${(error as Error).message}`);
  }
}

interface Loaded<T> {
  value: T;
  timer?: NodeJS.Timeout;
  /** Syntheses or recognitions running on the model now. */
  users: number;
}

export class SherpaEngine implements SpeechEngine {
  private sherpa: Sherpa | undefined;
  private tts = new Map<Language, Loaded<Promise<any>>>();
  private stt = new Map<string, Loaded<Promise<any>>>();
  /**
   * The objects of the native work running now. It runs on another thread with bare pointers to them, which the
   * garbage collector does not see: unreachable from here, they could be freed under it.
   */
  private running = new Set<unknown[]>();

  constructor(
    private store: ModelStore,
    private log: (message: string) => void,
    private load: SherpaLoader,
    /** How long a model stays loaded without use; the specs shorten it. */
    private idleMs = IDLE_UNLOAD_MS,
  ) {}

  async synthesize(text: string, language: Language, speed: number): Promise<Audio> {
    const load = async () => {
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
    };
    const audio = await this.use(this.tts, language, load, (tts) => this.native<any>([tts], tts.generateAsync({ text, sid: 0, speed })));
    return { samples: audio.samples as Float32Array, sampleRate: audio.sampleRate as number };
  }

  async transcribe(samples: Float32Array, language: Language): Promise<string> {
    const key = language === 'ru' ? 'ru' : `whisper-${language}`;
    const load = async () => {
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
    };
    return this.use(this.stt, key, load, async (recognizer) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: LISTEN_RATE, samples });
      // the decoding reads the stream once more when it ends, for the text
      const result = await this.native<any>([recognizer, stream], recognizer.decodeAsync(stream));
      return String(result?.text ?? '').trim();
    });
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
    /** Samples the native voice activity was given since it was made or reset. */
    let fed = 0;
    /** Utterances taken out before a reset, which drops the ones it holds. */
    const ready: Float32Array[] = [];
    const take = () => {
      const segment = vad.front();
      vad.pop();
      return new Float32Array(segment.samples);
    };
    const reset = () => {
      // a phrase still heard comes out as if the sound ended there
      vad.flush();
      while (!vad.isEmpty()) ready.push(take());
      vad.reset();
      fed = 0;
    };
    return {
      accept(samples) {
        const joined = new Float32Array(pending.length + samples.length);
        joined.set(pending);
        joined.set(samples, pending.length);
        let offset = 0;
        for (; offset + 512 <= joined.length; offset += 512) {
          vad.acceptWaveform(joined.subarray(offset, offset + 512));
          fed += 512;
          if (fed >= RESET_BY || (fed >= RESET_AFTER && !vad.isDetected())) reset();
        }
        pending = joined.slice(offset);
      },
      utterance() {
        if (ready.length) return ready.shift();
        if (vad.isEmpty()) return undefined;
        return take();
      },
      speaking: () => vad.isDetected(),
      flush: () => vad.flush(),
    };
  }

  private lib(): Sherpa {
    this.sherpa ??= loadSherpa(this.load);
    return this.sherpa;
  }

  /** Native work on another thread: the objects it was given stay reachable until it ends. */
  private async native<R>(objects: unknown[], work: Promise<R>): Promise<R> {
    this.running.add(objects);
    try {
      return await work;
    } finally {
      this.running.delete(objects);
    }
  }

  /**
   * Runs the work on the loaded model, shared by callers that come while it loads. The model is let go after a while
   * without use, counted from the end of the last work on it: never under a synthesis or a recognition still running.
   */
  private async use<K, T, R>(cache: Map<K, Loaded<Promise<T>>>, key: K, create: () => Promise<T>, work: (model: T) => Promise<R>): Promise<R> {
    let entry = cache.get(key);
    if (!entry) {
      const started = Date.now();
      const value = create().then((loaded) => {
        this.log(`speech model ${String(key)} loaded in ${Date.now() - started} ms`);
        return loaded;
      });
      const created: Loaded<Promise<T>> = { value, users: 0 };
      entry = created;
      cache.set(key, created);
      // only this entry: the timer of a load that failed later took out the good one loaded after it
      value.catch(() => {
        clearTimeout(created.timer);
        if (cache.get(key) === created) cache.delete(key);
      });
    }
    const current = entry;
    clearTimeout(current.timer);
    current.users++;
    try {
      return await work(await current.value);
    } finally {
      current.users--;
      if (current.users === 0 && cache.get(key) === current) {
        // the native memory goes with the object
        current.timer = setTimeout(() => {
          if (cache.get(key) !== current) return;
          cache.delete(key);
          this.log(`speech model ${String(key)} unloaded`);
        }, this.idleMs);
        current.timer.unref();
      }
    }
  }
}
