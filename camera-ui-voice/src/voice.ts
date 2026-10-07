/**
 * The core of VOICE, free of the plugin host: phrases through the queue of each camera, the screen time of every child,
 * the short conversation after a phrase, and what the status shows. The plugin (index.ts) gives it the cameras, the
 * sensors, the clock and the outside world; tests give it fakes of the same.
 */
import { Severity } from '@camera.ui/sdk';

import { PresenceTracker } from './presence.js';
import { PhraseQueue } from './queue.js';
import { ScreenTimeEngine, freshState } from './screenTime.js';
import { LANGUAGE_NAMES, answerChild, fill, nudgePhrase, saidText, templateNotify, texts } from './speech.js';
import { MINUTE, activeInterval, formatClock, localTime } from './time.js';

import type { Notification } from '@camera.ui/sdk';
import type { SpeechEngine } from './engine.js';
import type { Point, Sighting } from './presence.js';
import type { Facts, ScreenTimeAction, ScreenTimeConfig, ScreenTimeState } from './screenTime.js';
import type { SpeakResult } from './speaker.js';
import type { Ask, Language } from './speech.js';
import type { Clock, WeeklyInterval } from './time.js';

export interface SpeakerPort {
  /** Why the camera cannot speak, or undefined. */
  problem(): string | undefined;
  speak(samples: Float32Array, sampleRate: number): Promise<SpeakResult>;
}

export interface CameraPort {
  id: string;
  name: string;
  speaker: SpeakerPort;
  zone(name: string): Point[] | undefined;
  snapshot(): Promise<Uint8Array | undefined>;
  /** The first utterance heard within the window. */
  listen(windowMs: number): Promise<Float32Array | undefined>;
}

export interface VoiceDeps {
  clock: Clock;
  engine: SpeechEngine;
  ask: Ask;
  publish: (notification: Notification) => Promise<void>;
  timeZone: () => string;
  language: () => Language;
  speed: () => number;
  listenSeconds: () => number;
  maxPerMinute: () => number;
  quiet: () => WeeklyInterval[];
  saveState: (state: SavedState) => Promise<void>;
  log: (message: string) => void;
}

export interface SavedState {
  screenTime: Record<string, ScreenTimeState>;
}

export interface Exchange {
  at: number;
  cameraId: string;
  child?: string;
  heard?: string;
  said: string;
  source: 'llm' | 'template' | 'owner';
  result: string;
}

interface Scenario {
  cameraId: string;
  engine: ScreenTimeEngine;
  tracker: PresenceTracker;
  /** Phrases of this child, one after the other, beside the looks. */
  acting: Promise<void>;
  /** Why the last reminder was not heard: the parents are told so with their notification. */
  unspoken?: string;
}

/** Recent phrases and answers kept for the parents' status; never the sound. */
const RECENT = 20;
const MAX_EXCHANGES = 3;
/**
 * The camera's microphone hears its own speaker: listening starts this long after the last packet left the plugin.
 * The server still transcodes the phrase and the camera buffers it: 300 ms heard VOICE's own words as the answer.
 */
export const LISTEN_DELAY_MS = 1_500;
const MAX_INSTRUCTED = 300;
/** State fields that change with every look; a change of only these waits for the minute. */
const COUNTERS = new Set(['lastTick', 'lastSeen', 'todayMs', 'workMs', 'history', 'candidateSince']);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * What the microphone heard is the camera's own phrase coming back, not the child: a run of the phrase's words, in its
 * order, makes most of what was heard. Shared words are not enough: "когда можно играть" after "…играть можно будет
 * завтра" is the child's question, and taken for an echo it went unanswered. One word is never an echo: a "да" is.
 */
export function isEcho(heard: string, said: string | undefined): boolean {
  if (!said) return false;
  const phrase = words(said);
  const got = words(heard);
  let longest = 0;
  for (let i = 0; i < got.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      let run = 0;
      while (i + run < got.length && j + run < phrase.length && got[i + run] === phrase[j + run]) run++;
      longest = Math.max(longest, run);
    }
  }
  return longest >= 2 && longest / got.length >= 0.6;
}

export class Voice {
  private cameras = new Map<string, CameraPort>();
  private queues = new Map<string, PhraseQueue>();
  private scenarios = new Map<string, Scenario>();
  /** Conversations running per camera: nothing else is said while VOICE listens for an answer. */
  private talking = new Map<string, Promise<void>>();
  /** Phrases from outside waiting for a conversation per camera: it stops at the next exchange for them. */
  private waiting = new Map<string, number>();
  /** The last phrase said on each camera: what its microphone may hear again. */
  private lastSaid = new Map<string, string>();
  private looking = new Set<string>();
  private lastSaved = '';
  private lastSavedAt = 0;
  readonly recent: Exchange[] = [];

  constructor(
    private deps: VoiceDeps,
    private saved: SavedState = { screenTime: {} },
  ) {}

  // ---- cameras ----

  addCamera(camera: CameraPort): void {
    this.cameras.set(camera.id, camera);
  }

  removeCamera(cameraId: string): void {
    this.cameras.delete(cameraId);
    this.queues.delete(cameraId);
    for (const [key, scenario] of this.scenarios) if (scenario.cameraId === cameraId) this.scenarios.delete(key);
  }

  camera(cameraId: string): CameraPort | undefined {
    return this.cameras.get(cameraId);
  }

  listCameras(): CameraPort[] {
    return [...this.cameras.values()];
  }

  // ---- speaking ----

  /**
   * Says the text on the camera: synthesized, then queued behind earlier phrases of that camera. A conversation with a
   * child goes first: a door phrase said into its listening window would be heard as the child's answer.
   */
  async say(cameraId: string, text: string, source: Exchange['source'] = 'owner'): Promise<SpeakResult> {
    if (this.talking.has(cameraId)) {
      // the conversation ends at its next exchange: three answers held "Пришёл папа" for a minute
      this.waiting.set(cameraId, (this.waiting.get(cameraId) ?? 0) + 1);
      try {
        while (this.talking.has(cameraId)) await this.talking.get(cameraId);
      } finally {
        const left = (this.waiting.get(cameraId) ?? 1) - 1;
        if (left > 0) this.waiting.set(cameraId, left);
        else this.waiting.delete(cameraId);
      }
    }
    return this.speak(cameraId, text, source);
  }

  private async speak(cameraId: string, text: string, source: Exchange['source']): Promise<SpeakResult> {
    const camera = this.cameras.get(cameraId);
    if (!camera) return { status: 'failed', reason: `unknown camera ${cameraId}` };
    const problem = camera.speaker.problem();
    if (problem) {
      this.remember({ at: this.deps.clock.now(), cameraId, said: text, source, result: `no_backchannel: ${problem}` });
      return { status: 'no_backchannel', reason: problem };
    }
    let queue = this.queues.get(cameraId);
    if (!queue) {
      queue = new PhraseQueue(this.deps.clock, this.deps.maxPerMinute, (message) => this.deps.log(`${camera.name}: ${message}`));
      this.queues.set(cameraId, queue);
    }
    const result = await queue.add({
      text,
      run: async () => {
        const audio = await this.deps.engine.synthesize(text, this.deps.language(), this.deps.speed());
        return camera.speaker.speak(audio.samples, audio.sampleRate);
      },
    });
    this.remember({ at: this.deps.clock.now(), cameraId, said: text, source, result: result.status + (result.reason ? `: ${result.reason}` : '') });
    if (result.status === 'spoken') this.lastSaid.set(cameraId, text);
    if (result.status === 'spoken') this.deps.log(`${camera.name}: said "${text}"`);
    else this.deps.log(`${camera.name}: not said (${result.status}${result.reason ? `, ${result.reason}` : ''}): "${text}"`);
    return result;
  }

  /** The LLM writes what to say from an instruction of the owner ("tell Artem dinner is ready"), then it is said. */
  async sayInstructed(cameraId: string, instruction: string): Promise<SpeakResult & { text?: string }> {
    const language = this.deps.language();
    const result = await this.deps.ask({
      system:
        `You are VOICE, the voice of a home camera. Turn the owner's request into one short phrase to say aloud in ${LANGUAGE_NAMES[language]}, ` +
        'at most 30 words, friendly and natural. Say only what the request asks, add nothing. Answer as JSON {"say": "..."}.',
      prompt: `Request: ${JSON.stringify(instruction)}`,
      outputSchema: { type: 'object', properties: { say: { type: 'string', maxLength: 300 } }, required: ['say'] },
      timeoutMs: 20_000,
    });
    if (!result.ok) return { status: 'failed', reason: `the assistant did not answer (${result.reason})` };
    const text = saidText(result);
    if (!text) return { status: 'failed', reason: 'the assistant wrote nothing' };
    // models do not always keep to maxLength: a page of text would hold the camera for minutes
    if (text.length > MAX_INSTRUCTED) return { status: 'failed', reason: `the assistant wrote ${text.length} characters, more than ${MAX_INSTRUCTED}` };
    return { ...(await this.say(cameraId, text, 'llm')), text };
  }

  // ---- screen time ----

  /** Puts the scenarios of a camera in place; the state of a child who stays is kept. */
  setScreenTime(cameraId: string, configs: ScreenTimeConfig[]): void {
    const wanted = new Set(configs.map((c) => `${cameraId}/${c.id}`));
    for (const [key, scenario] of this.scenarios) if (scenario.cameraId === cameraId && !wanted.has(key)) this.scenarios.delete(key);
    for (const config of configs) {
      const key = `${cameraId}/${config.id}`;
      const existing = this.scenarios.get(key);
      if (existing) {
        existing.engine.config = config;
        existing.tracker.setSource(config.source);
        continue;
      }
      const state = this.saved.screenTime[key] ?? freshState(localTime(this.deps.clock.now(), this.deps.timeZone()).date);
      this.saved.screenTime[key] = state;
      const tracker = new PresenceTracker(config.source, (name) => this.cameras.get(cameraId)?.zone(name));
      // a session that ran before a restart keeps who was seen: without it a child with the back to the camera fell
      // out of a face-bound scenario, the session ended and a break was credited without leaving the computer
      if (state.present) tracker.restore(state.name, state.attributeYes);
      this.scenarios.set(key, {
        cameraId,
        engine: new ScreenTimeEngine(config, state),
        acting: Promise.resolve(),
        tracker,
      });
    }
  }

  scenariosOf(cameraId: string): { key: string; engine: ScreenTimeEngine }[] {
    return [...this.scenarios.entries()].filter(([, s]) => s.cameraId === cameraId).map(([key, s]) => ({ key, engine: s.engine }));
  }

  findScenario(cameraId: string, child?: string): { key: string; engine: ScreenTimeEngine } | undefined {
    const all = this.scenariosOf(cameraId);
    if (!child) return all.length === 1 ? all[0] : undefined;
    const wanted = child.trim().toLowerCase();
    return all.find(({ engine }) => engine.config.childName.toLowerCase() === wanted || engine.config.id === wanted);
  }

  /** One look at a camera: presence of each child, and whatever the scenarios decide. No sighting: the camera is blind. */
  async look(cameraId: string, sighting: Sighting | undefined): Promise<void> {
    // a look still running (a slow save) is not overtaken by the next one: two ticks of one moment would count twice
    if (this.looking.has(cameraId)) return;
    this.looking.add(cameraId);
    try {
      await this.lookNow(cameraId, sighting);
    } finally {
      this.looking.delete(cameraId);
    }
  }

  private async lookNow(cameraId: string, sighting: Sighting | undefined): Promise<void> {
    const now = this.deps.clock.now();
    const timeZone = this.deps.timeZone();
    const quiet = Boolean(activeInterval(this.deps.quiet(), now, timeZone));
    for (const [key, scenario] of this.scenarios) {
      if (scenario.cameraId !== cameraId || !scenario.engine.config.enabled) continue;
      const wasPresent = scenario.engine.state.present;
      const present = sighting ? scenario.tracker.look(sighting) : undefined;
      const actions = scenario.engine.tick({
        now,
        present,
        name: scenario.tracker.seenName(),
        attributeYes: scenario.tracker.attributeHeld(),
        quiet,
        timeZone,
        language: this.deps.language(),
      });
      if (wasPresent && !scenario.engine.state.present) scenario.tracker.sessionEnded();
      // said beside the looks: a phrase takes seconds, the camera keeps being watched meanwhile
      for (const action of actions) {
        scenario.acting = scenario.acting
          .then(() => this.act(key, scenario, action))
          .catch((error: Error) => this.deps.log(`${scenario.engine.config.childName}: ${error.message}`));
      }
    }
    await this.persist(now);
  }

  /** A parent gives more time, or lets the next break go. */
  extend(key: string, minutes: number | undefined, skipBreak: boolean): void {
    const scenario = this.scenarios.get(key);
    if (!scenario) throw new Error(`unknown scenario ${key}`);
    if (minutes) scenario.engine.extend(minutes, this.deps.clock.now());
    if (skipBreak) scenario.engine.skipBreak();
    void this.persist(this.deps.clock.now(), true);
  }

  /** "Today: 1 h 20 min. Now: break until 18:40" for a child. */
  statusOf(key: string): string {
    const scenario = this.scenarios.get(key);
    if (!scenario) return '';
    const language = this.deps.language();
    const t = texts(language).status;
    const now = this.deps.clock.now();
    const timeZone = this.deps.timeZone();
    const { engine } = scenario;
    const today = Math.floor(engine.state.todayMs / MINUTE);
    const duration = today >= 60 ? fill(t.hours, { hours: Math.floor(today / 60), minutes: today % 60 }) : fill(t.onlyMinutes, { minutes: today });
    const parts = [fill(t.today, { duration })];
    const grant = engine.state.grantUntil;
    const reason = engine.reason(now, timeZone);
    if (grant !== undefined && now < grant) parts.push(fill(t.granted, { time: formatClock(grant, timeZone) }));
    else if (reason === 'bedtime') parts.push(fill(t.bedtime, { time: engine.facts(now, { timeZone, language }).wakeAt }));
    else if (reason === 'daily_limit') parts.push(t.daily_limit);
    else if (reason === 'break' || (engine.state.leftAt !== undefined && engine.state.workMs >= engine.config.sessionMinutes * MINUTE)) {
      parts.push(fill(t.break, { time: engine.facts(now, { timeZone, language }).breakEndsAt ?? '' }));
    } else parts.push(engine.state.present ? t.free : t.away);
    return `${engine.config.childName}: ${parts.join('. ')}`;
  }

  // ---- inside ----

  private async act(key: string, scenario: Scenario, action: ScreenTimeAction): Promise<void> {
    const language = this.deps.language();
    const camera = this.cameras.get(scenario.cameraId);
    if (!camera) return;
    if (action.type === 'notify') {
      const { title, body } = templateNotify(action.facts, language);
      // a reminder the child never heard is not "the child does not stop": the parents learn why it was not said
      const unheard = scenario.unspoken ? ` ${fill(texts(language).notify.notSaid, { reason: scenario.unspoken })}` : '';
      await this.notifyParents(camera, title, body + unheard, `voice:${key}`);
      return;
    }
    // the microphone hears the camera's own speaker: a phrase now would come back as the child's answer
    while (this.talking.has(camera.id)) await this.talking.get(camera.id);
    // a phrase that opens a conversation takes the camera before it is said: a door phrase that came while the reminder
    // was synthesized or said queued right behind it and played into the listening window
    let endTurn = () => {};
    const converses = scenario.engine.config.answerQuestions;
    if (converses) this.talking.set(camera.id, new Promise<void>((resolve) => (endTurn = resolve)));
    let talk: Promise<void> | undefined;
    try {
      const phrase = await nudgePhrase(this.deps.ask, action.facts, language, action.kind);
      if (phrase.fallback) this.deps.log(`${camera.name}: template phrase (${phrase.fallback})`);
      const result = await this.speak(camera.id, phrase.text, phrase.source);
      scenario.unspoken = result.status === 'spoken' ? undefined : (result.reason ?? result.status);
      // the conversation runs beside the looks: the camera keeps being watched while the child answers
      if (result.status === 'spoken' && converses) talk = this.converse(key, scenario, camera);
    } finally {
      if (converses) {
        void (talk ?? Promise.resolve()).finally(() => {
          this.talking.delete(camera.id);
          endTurn();
        });
      }
    }
  }

  private async converse(key: string, scenario: Scenario, camera: CameraPort): Promise<void> {
    try {
      const language = this.deps.language();
      for (let exchange = 0; exchange < MAX_EXCHANGES; exchange++) {
        if (this.waiting.get(camera.id)) {
          this.deps.log(`${camera.name}: conversation ended for a phrase from outside`);
          return;
        }
        await new Promise((resolve) => this.deps.clock.setTimeout(() => resolve(undefined), LISTEN_DELAY_MS));
        const audio = await camera.listen(this.deps.listenSeconds() * 1000);
        if (!audio?.length) return;
        const heard = (await this.deps.engine.transcribe(audio, language)).trim();
        if (!heard) return;
        // VOICE's own phrase coming back through the microphone: its words ("only the parents give more time") would
        // read as the child asking, notify the parents and be answered again
        if (isEcho(heard, this.lastSaid.get(camera.id))) {
          this.deps.log(`${camera.name}: heard its own phrase, not an answer`);
          return;
        }
        const facts: Facts = scenario.engine.facts(this.deps.clock.now(), { timeZone: this.deps.timeZone(), language });
        const answer = await answerChild(this.deps.ask, facts, heard, language);
        if (answer.intent === 'asks_more_time') {
          const t = texts(language).notify;
          const values = { name: facts.childName, text: heard };
          await this.notifyParents(camera, fill(t.moreTimeTitle, values), fill(t.moreTime, values), `voice:${key}:more`);
        }
        const result = await this.speak(camera.id, answer.text, answer.source);
        const last = this.recent[this.recent.length - 1];
        if (last) last.heard = heard;
        if (last) last.child = facts.childName;
        if (result.status !== 'spoken') return;
      }
    } catch (error) {
      this.deps.log(`${camera.name}: conversation stopped: ${(error as Error).message}`);
    }
  }

  private async notifyParents(camera: CameraPort, title: string, body: string, tag: string): Promise<void> {
    const thumbnail = await camera.snapshot().catch(() => undefined);
    // for the parents only: the picture of a child's room and the child's words do not go to every user of the house
    await this.deps
      .publish({ title, body, severity: Severity.Warn, tag, adminOnly: true, ...(thumbnail ? { thumbnail } : {}) })
      .catch((error: Error) => this.deps.log(`notification not sent: ${error.message}`));
  }

  private remember(exchange: Exchange): void {
    this.recent.push(exchange);
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
  }

  /**
   * Written when something besides the counting changed, and at least once a minute while a session runs: the counters
   * move on every look, and a write every 5 s wore the disk for nothing.
   */
  private async persist(now: number, force = false): Promise<void> {
    const snapshot = JSON.stringify(this.saved, (key, value: unknown) => (COUNTERS.has(key) ? undefined : value));
    if (!force && snapshot === this.lastSaved && now - this.lastSavedAt < MINUTE) return;
    this.lastSaved = snapshot;
    this.lastSavedAt = now;
    await this.deps.saveState(this.saved).catch((error: Error) => this.deps.log(`state not saved: ${error.message}`));
  }
}
