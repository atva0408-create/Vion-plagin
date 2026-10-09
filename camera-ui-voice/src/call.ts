/**
 * VOICE called by name: «ВиОН, сколько мне ещё отдыхать?». While a child's scenario asks for it, the microphone of the
 * camera stays open; voice activity cuts what is said into phrases, and each short phrase is recognized on this server
 * to see whether it starts with the name. Nothing is written anywhere, and a phrase without the name is dropped unread:
 * neither logged nor kept.
 *
 * There is no keyword model for Russian (sherpa-onnx has them for Chinese and English), and hotwords do not move this
 * recognizer towards "вион" even at a boost of 8 (measured on the bench, 2026-10-09): the name is found by the ways
 * the recognizer writes it.
 */
import { LISTEN_RATE } from '@vionvision/speech';

import type { OpenAudio, SpeechEngine } from '@vionvision/speech';
import type { Language } from './speech.js';
import type { Clock } from './time.js';

/** The languages VOICE can be called in: the name was measured with the Russian recognizer only. */
export const CALL_LANGUAGES: readonly Language[] = ['ru'];

/**
 * How the Russian recognizer writes «ВиОН», measured with VOICE's own voice at three speeds and through the live chain
 * on the bench: вион, леон, лион, реон, рион, прион, верон, рейон, виен, виллан. A word of that shape, and not "вон",
 * "лен", "вин", "блин", "вино", "район", "Лена" or "Ливан", which the recognizer also wrote for the name or which start
 * ordinary phrases.
 */
const NAME_RU = /^(?:в|л|р|пр|б)[ие]й?[рл]{0,2}и?[оеа]н$/u;
const EXACT_RU = 'вион';
/** The name cut short, as the recognizer also wrote it alone ("вио"). */
const CUT_RU = new Set(['вио']);
/** Words a call may start with before the name: «эй, ВиОН»; the recognizer wrote "эй" as "и". */
const LEADS_RU = new Set(['эй', 'и', 'ну', 'а', 'слушай', 'привет', 'скажи']);
/** «ви он» in two words; not "ли он", which starts an ordinary question. */
const SPLIT_RU = new Set(['ви', 'ве']);
/**
 * Stems of a question about the time at the computer. A word that only sounds like the name ("Леон!" shouted in a
 * game, "Верон, иди ужинать") calls VOICE only with one of them; "вион" itself calls alone.
 */
const TOPIC_RU = ['сколько', 'когда', 'можно', 'врем', 'игра', 'поигра', 'отдых', 'перерыв', 'еще', 'остал', 'минут', 'дай', 'разреш', 'спать', 'компьют', 'долго'];

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export interface Called {
  /** The words after the name; '' for the name alone. */
  question: string;
  /** The name as the recognizer writes it when it hears it well, not a word that only sounds like it. */
  exact: boolean;
}

/** The name at the start of the phrase, undefined when the phrase does not start with it. */
export function calledWith(text: string, language: Language): Called | undefined {
  if (!CALL_LANGUAGES.includes(language)) return undefined;
  const words = wordsOf(text);
  const at = LEADS_RU.has(words[0] ?? '') ? 1 : 0;
  const first = words[at];
  if (first === undefined) return undefined;
  if (NAME_RU.test(first) || CUT_RU.has(first)) return { question: words.slice(at + 1).join(' '), exact: first === EXACT_RU };
  const second = words[at + 1];
  if (SPLIT_RU.has(first) && second !== undefined && NAME_RU.test(first + second)) {
    return { question: words.slice(at + 2).join(' '), exact: first + second === EXACT_RU };
  }
  return undefined;
}

/** Whether the words ask about the time at the computer. */
export function onTopic(text: string): boolean {
  return wordsOf(text).some((word) => TOPIC_RU.some((stem) => word.startsWith(stem)));
}

export interface CallDeps {
  clock: Clock;
  engine: SpeechEngine;
  /** Opens the sound of the camera; it stays open until stopped. */
  open: (cameraId: string) => Promise<OpenAudio>;
  /** VOICE speaks or talks with the child there: what the microphone hears now is not a call. */
  busy: (cameraId: string) => boolean;
  language: () => Language;
  /** The child called: the words after the name ('' for the name alone) and the whole phrase heard. */
  onCall: (cameraId: string, question: string, heard: string) => void;
  name: (cameraId: string) => string;
  log: (message: string) => void;
}

/** A call is a short phrase: longer ones (a film, a game, a talk in the room) are not even recognized. */
export const MAX_CALL_MS = 12_000;
const MIN_CALL_MS = 300;
/** After the name alone the question may come as a phrase of its own: «ВиОН… сколько мне ещё отдыхать?». */
export const QUESTION_WAIT_MS = 4_000;
/** Opening the sound again after it failed: a camera without sound or offline is not hammered. */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
/** Sound that ran this long before it ended was working: the next failure starts the delays over. */
const HEALTHY_MS = 60_000;

export type CallState = { state: 'off' } | { state: 'listening' } | { state: 'failing'; reason: string };

interface Ear {
  audio?: OpenAudio;
  openedAt?: number;
  opening: boolean;
  failures: number;
  reason?: string;
  retry?: unknown;
  /** Phrases are recognized one at a time; one more may wait, the rest are dropped. */
  queue: Promise<void>;
  queued: number;
  /** The name was called alone then: the next phrase is the question. */
  calledAt?: number;
  /** That name was "вион" itself: answered even when no question follows. */
  calledExact?: boolean;
  questionTimer?: unknown;
}

/** The open microphones of the cameras where a child may call VOICE. */
export class CallListener {
  private ears = new Map<string, Ear>();

  constructor(private deps: CallDeps) {}

  /** Keeps the microphone of the camera open, or closes it. */
  want(cameraId: string, on: boolean): void {
    if (!on) {
      this.close(cameraId);
      return;
    }
    let ear = this.ears.get(cameraId);
    if (!ear) {
      ear = { opening: false, failures: 0, queue: Promise.resolve(), queued: 0 };
      this.ears.set(cameraId, ear);
    }
    if (!ear.audio && !ear.opening && ear.retry === undefined) void this.open(cameraId, ear);
  }

  close(cameraId: string): void {
    const ear = this.ears.get(cameraId);
    if (!ear) return;
    this.ears.delete(cameraId);
    if (ear.retry !== undefined) this.deps.clock.clearTimeout(ear.retry);
    if (ear.questionTimer !== undefined) this.deps.clock.clearTimeout(ear.questionTimer);
    ear.audio?.stop();
    ear.audio = undefined;
  }

  closeAll(): void {
    for (const cameraId of [...this.ears.keys()]) this.close(cameraId);
  }

  /** VOICE has just spoken there: its phrase, half heard by the microphone, is thrown away with what follows for a while. */
  deafen(cameraId: string, ms: number): void {
    const ear = this.ears.get(cameraId);
    if (!ear) return;
    this.stopWaiting(ear);
    try {
      ear.audio?.hearing.deafUntil(this.deps.clock.now() + ms);
    } catch (error) {
      // the native voice activity throws on a state it does not expect: the phrase VOICE said was still said
      this.deps.log(`${this.deps.name(cameraId)}: listening for a call could not pause: ${(error as Error).message}`);
    }
  }

  stateOf(cameraId: string): CallState {
    const ear = this.ears.get(cameraId);
    if (!ear) return { state: 'off' };
    if (ear.reason && !ear.audio) return { state: 'failing', reason: ear.reason };
    return { state: 'listening' };
  }

  private async open(cameraId: string, ear: Ear): Promise<void> {
    ear.opening = true;
    let audio: OpenAudio;
    try {
      audio = await this.deps.open(cameraId);
    } catch (error) {
      ear.opening = false;
      this.failed(cameraId, ear, error instanceof Error ? error.message : String(error));
      return;
    }
    ear.opening = false;
    // closed while it opened: the microphone must not stay open after all
    if (this.ears.get(cameraId) !== ear) {
      audio.stop();
      return;
    }
    ear.audio = audio;
    ear.openedAt = this.deps.clock.now();
    audio.hearing.onUtterance((samples) => this.heard(cameraId, ear, samples));
    void audio.ended.then((reason) => {
      if (ear.audio === audio) ear.audio = undefined;
      // stopped by VOICE: nothing failed
      if (reason === undefined || this.ears.get(cameraId) !== ear) return;
      if (this.deps.clock.now() - (ear.openedAt ?? 0) >= HEALTHY_MS) ear.failures = 0;
      this.failed(cameraId, ear, reason);
    });
  }

  private failed(cameraId: string, ear: Ear, reason: string): void {
    if (this.ears.get(cameraId) !== ear) return;
    // once per run of failures: a camera without sound would fill the log every few minutes
    if (ear.failures === 0) this.deps.log(`${this.deps.name(cameraId)}: listening for a call failed, VOICE tries again: ${reason}`);
    ear.reason = reason;
    const delay = RETRY_MS[Math.min(ear.failures, RETRY_MS.length - 1)];
    ear.failures++;
    ear.retry = this.deps.clock.setTimeout(() => {
      ear.retry = undefined;
      if (this.ears.get(cameraId) === ear && !ear.audio && !ear.opening) void this.open(cameraId, ear);
    }, delay);
  }

  private heard(cameraId: string, ear: Ear, samples: Float32Array): void {
    const ms = (samples.length / LISTEN_RATE) * 1000;
    if (ms < MIN_CALL_MS || ms > MAX_CALL_MS) return;
    if (this.deps.busy(cameraId) || ear.queued >= 2) return;
    ear.reason = undefined;
    ear.queued++;
    ear.queue = ear.queue
      .then(() => this.recognize(cameraId, ear, samples))
      .catch((error: Error) => this.deps.log(`${this.deps.name(cameraId)}: a call was not recognized: ${error.message}`))
      .finally(() => {
        ear.queued--;
      });
  }

  private async recognize(cameraId: string, ear: Ear, samples: Float32Array): Promise<void> {
    if (this.ears.get(cameraId) !== ear || this.deps.busy(cameraId)) return;
    const language = this.deps.language();
    const text = (await this.deps.engine.transcribe(samples, language)).trim();
    if (this.ears.get(cameraId) !== ear || this.deps.busy(cameraId) || !text) return;
    const called = calledWith(text, language);
    if (ear.calledAt !== undefined) {
      // the question after the name alone; a child who calls again with the question is asking it too
      const exact = ear.calledExact === true || called?.exact === true;
      const question = called ? called.question : text;
      this.stopWaiting(ear);
      if (exact || onTopic(question)) this.deps.onCall(cameraId, question, text);
      return;
    }
    if (!called) return;
    if (called.question) {
      if (called.exact || onTopic(called.question)) this.deps.onCall(cameraId, called.question, text);
      return;
    }
    ear.calledAt = this.deps.clock.now();
    ear.calledExact = called.exact;
    ear.questionTimer = this.deps.clock.setTimeout(() => this.questionDue(cameraId, ear, text), QUESTION_WAIT_MS);
  }

  /**
   * No question came after the name: "вион" alone still gets where the child stands, unless the question is being
   * said; a word that only sounds like the name, alone ("Леон!"), is let go.
   */
  private questionDue(cameraId: string, ear: Ear, heard: string): void {
    ear.questionTimer = undefined;
    if (ear.calledAt === undefined || this.ears.get(cameraId) !== ear) return;
    const saying = ear.queued > 0 || Boolean(ear.audio?.hearing.speaking());
    if (saying && this.deps.clock.now() - ear.calledAt < QUESTION_WAIT_MS + MAX_CALL_MS) {
      ear.questionTimer = this.deps.clock.setTimeout(() => this.questionDue(cameraId, ear, heard), 500);
      return;
    }
    const exact = ear.calledExact;
    this.stopWaiting(ear);
    if (exact) this.deps.onCall(cameraId, '', heard);
  }

  private stopWaiting(ear: Ear): void {
    ear.calledAt = undefined;
    ear.calledExact = undefined;
    if (ear.questionTimer !== undefined) this.deps.clock.clearTimeout(ear.questionTimer);
    ear.questionTimer = undefined;
  }
}
