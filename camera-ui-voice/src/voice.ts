/**
 * The core of VOICE, free of the plugin host: phrases through the queue of each camera, the screen time of every child,
 * the short conversation after a phrase, and what the status shows. The plugin (index.ts) gives it the cameras, the
 * sensors, the clock and the outside world; tests give it fakes of the same.
 */
import { Severity } from '@camera.ui/sdk';
import { PhraseQueue, isEcho } from '@vionvision/speech';

import { CALL_LANGUAGES, CallListener } from './call.js';
import { PresenceTracker } from './presence.js';
import { dayReports, today } from './report.js';
import { ScreenTimeEngine, freshState } from './screenTime.js';
import { restoreScreenTime } from './state.js';
import { LANGUAGE_NAMES, answerChild, fill, nudgePhrase, replyText, saidText, templateNotify, texts } from './speech.js';
import { MINUTE, activeInterval, formatClock, localTime } from './time.js';

import type { Notification } from '@camera.ui/sdk';
import type { OpenAudio, SpeakResult, SpeechEngine } from '@vionvision/speech';
import type { Point, Sighting } from './presence.js';
import type { DayReport } from './report.js';
import type { Facts, ScreenTimeAction, ScreenTimeConfig, ScreenTimeState } from './screenTime.js';
import type { Ask, Language } from './speech.js';
import type { Clock, WeeklyInterval } from './time.js';

export interface SpeakerPort {
  /** Why the camera cannot speak, or undefined. */
  problem(): string | undefined;
  speak(samples: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<SpeakResult>;
}

export interface CameraPort {
  id: string;
  name: string;
  speaker: SpeakerPort;
  zone(name: string): Point[] | undefined;
  snapshot(): Promise<Uint8Array | undefined>;
  /** The first utterance heard within the window. */
  listen(windowMs: number, signal?: AbortSignal): Promise<Float32Array | undefined>;
  /** The sound of the camera kept open, for a child calling VOICE by name. */
  hear(): Promise<OpenAudio>;
}

/** An event in the camera's recordings, as the NVR made it. */
export interface NvrEvent {
  eventId: string;
  /** When it closes: its recording is complete a file of the NVR later. */
  endTime: number;
}

/** The NVR, for the event of a violation; the specs give a fake. */
export interface NvrPort {
  addEvent(
    cameraId: string,
    event: { title: string; description: string; tags: string[]; startTime: number; recordSeconds: number; snapshot?: Uint8Array },
  ): Promise<NvrEvent | undefined>;
}

/** The reminders a notice of a violation tells of, as they were when it fell due (the third step: three of them). */
interface Reminders {
  since: number;
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
  /** Absent: the parents get the notice without an event in the recordings. */
  nvr?: NvrPort;
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
  controller: AbortController;
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
/** The event of a violation stays open, and a camera that records by events records, this long after the notice. */
export const VIOLATION_RECORD_SECONDS = 30;
/** A camera that hangs on a snapshot or an NVR that does not answer must not hold the notice. */
const SNAPSHOT_WAIT_MS = 8_000;
const NVR_WAIT_MS = 10_000;
/** How a call of VOICE is shown to the parents: the name the child said. */
const CALL_NAME = 'ВиОН';
/** State fields that change with every look; a change of only these waits for the minute. */
const COUNTERS = new Set(['lastTick', 'lastSeen', 'todayMs', 'workMs', 'history', 'candidateSince']);

// the camera's own phrase coming back through its microphone: the speech package decides, the specs check it here
export { isEcho };

export class Voice {
  private cameras = new Map<string, CameraPort>();
  private controllers = new Map<string, AbortController>();
  private stopped = false;
  private queues = new Map<string, PhraseQueue>();
  private scenarios = new Map<string, Scenario>();
  /** Conversations running per camera: nothing else is said while VOICE listens for an answer. */
  private talking = new Map<string, Promise<void>>();
  /** Phrases from outside waiting for a conversation per camera: it stops at the next exchange for them. */
  private waiting = new Map<string, number>();
  /** The last phrase said on each camera: what its microphone may hear again. */
  private lastSaid = new Map<string, string>();
  private looking = new Set<string>();
  /** Phrases being said per camera: the microphone open for a call hears them, they are not the child. */
  private speakingOn = new Map<string, number>();
  private calls: CallListener;
  private lastSaved = '';
  private lastSavedAt = 0;
  private saved: SavedState;
  readonly recent: Exchange[] = [];

  constructor(
    private deps: VoiceDeps,
    saved: unknown = { screenTime: {} },
  ) {
    this.saved = { screenTime: restoreScreenTime(saved) };
    if (JSON.stringify(this.saved) !== JSON.stringify(saved)) this.deps.log('invalid VOICE state entries were discarded');
    this.calls = new CallListener({
      clock: deps.clock,
      engine: deps.engine,
      open: (cameraId) => {
        const camera = this.cameras.get(cameraId);
        return camera ? camera.hear() : Promise.reject(new Error('the camera was released'));
      },
      busy: (cameraId) => this.talking.has(cameraId) || this.speakingOn.has(cameraId),
      language: () => this.deps.language(),
      onCall: (cameraId, question, heard) => void this.answerCall(cameraId, question, heard),
      name: (cameraId) => this.cameras.get(cameraId)?.name ?? cameraId,
      log: (message) => this.deps.log(message),
    });
  }

  // ---- cameras ----

  addCamera(camera: CameraPort): void {
    if (this.cameras.has(camera.id)) this.removeCamera(camera.id);
    this.cameras.set(camera.id, camera);
    this.controllers.set(camera.id, new AbortController());
  }

  removeCamera(cameraId: string): void {
    this.controllers.get(cameraId)?.abort();
    this.controllers.delete(cameraId);
    this.cameras.delete(cameraId);
    this.queues.get(cameraId)?.stop();
    this.queues.delete(cameraId);
    this.talking.delete(cameraId);
    this.lastSaid.delete(cameraId);
    this.calls.close(cameraId);
    for (const [key, scenario] of this.scenarios)
      if (scenario.cameraId === cameraId) {
        scenario.controller.abort();
        this.scenarios.delete(key);
      }
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const scenario of this.scenarios.values()) scenario.controller.abort();
    for (const queue of this.queues.values()) queue.stop();
    this.queues.clear();
    this.talking.clear();
    this.calls.closeAll();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const id of this.cameras.keys()) this.controllers.set(id, new AbortController());
    for (const scenario of this.scenarios.values()) scenario.controller = new AbortController();
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
    const controller = this.controllers.get(cameraId);
    const valid = () => !this.stopped && controller !== undefined && this.controllers.get(cameraId) === controller && !controller.signal.aborted;
    if (!valid()) return { status: 'failed', reason: 'the camera was released or VOICE was stopped' };
    if (this.talking.has(cameraId)) {
      // the conversation ends at its next exchange: three answers held "Пришёл папа" for a minute
      this.waiting.set(cameraId, (this.waiting.get(cameraId) ?? 0) + 1);
      try {
        while (this.talking.has(cameraId)) await this.waitFor(this.talking.get(cameraId)!, controller!.signal);
      } catch {
        return { status: 'failed', reason: 'the phrase was cancelled' };
      } finally {
        const left = (this.waiting.get(cameraId) ?? 1) - 1;
        if (left > 0) this.waiting.set(cameraId, left);
        else this.waiting.delete(cameraId);
      }
    }
    return this.speak(cameraId, text, source, valid, controller!.signal);
  }

  private async speak(cameraId: string, text: string, source: Exchange['source'], valid: () => boolean, signal: AbortSignal): Promise<SpeakResult> {
    text = text.trim();
    if (!text || text.length > MAX_INSTRUCTED) return { status: 'failed', reason: `a phrase must contain 1-${MAX_INSTRUCTED} characters` };
    if (!valid() || signal.aborted) return { status: 'failed', reason: 'the phrase was cancelled' };
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
        if (!valid() || signal.aborted) return { status: 'failed', reason: 'the phrase was cancelled' };
        const audio = await this.waitFor(this.deps.engine.synthesize(text, this.deps.language(), this.deps.speed()), signal);
        if (!valid() || signal.aborted) return { status: 'failed', reason: 'the phrase was cancelled' };
        this.speakingOn.set(cameraId, (this.speakingOn.get(cameraId) ?? 0) + 1);
        try {
          return await camera.speaker.speak(audio.samples, audio.sampleRate, signal);
        } finally {
          const left = (this.speakingOn.get(cameraId) ?? 1) - 1;
          if (left > 0) this.speakingOn.set(cameraId, left);
          else this.speakingOn.delete(cameraId);
          // the camera still plays the end of the phrase: half heard, it would come out as a phrase of the room
          this.calls.deafen(cameraId, LISTEN_DELAY_MS);
        }
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
    const controller = this.controllers.get(cameraId);
    if (this.stopped || !controller || controller.signal.aborted) return { status: 'failed', reason: 'the camera was released or VOICE was stopped' };
    const problem = this.cameras.get(cameraId)?.speaker.problem();
    if (problem) return { status: 'no_backchannel', reason: problem };
    const language = this.deps.language();
    let result;
    try {
      result = await this.waitFor(
        this.deps.ask({
          system:
            `You are VOICE, the voice of a home camera. Turn the owner's request into one short phrase to say aloud in ${LANGUAGE_NAMES[language]}, ` +
            'at most 30 words, friendly and natural. Say only what the request asks, add nothing. Answer as JSON {"say": "..."}.',
          prompt: `Request: ${JSON.stringify(instruction)}`,
          outputSchema: { type: 'object', properties: { say: { type: 'string', maxLength: 300 } }, required: ['say'] },
          timeoutMs: 20_000,
        }),
        controller.signal,
      );
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    if (this.controllers.get(cameraId) !== controller) return { status: 'failed', reason: 'the phrase was cancelled' };
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
    for (const [key, scenario] of this.scenarios)
      if (scenario.cameraId === cameraId && !wanted.has(key)) {
        scenario.controller.abort();
        this.scenarios.delete(key);
      }
    for (const config of configs) {
      const key = `${cameraId}/${config.id}`;
      const existing = this.scenarios.get(key);
      if (existing) {
        if (JSON.stringify(existing.engine.config) !== JSON.stringify(config)) {
          existing.controller.abort();
          existing.controller = new AbortController();
        }
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
        controller: new AbortController(),
        tracker,
      });
    }
    this.syncCalls(cameraId, false);
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
    if (this.stopped || !this.cameras.has(cameraId)) return;
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
    // the microphone opens with the looks: they run once VOICE has started, and a change of language is seen here too
    this.syncCalls(cameraId, true);
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
      if (wasPresent && !scenario.engine.state.present) {
        scenario.tracker.sessionEnded();
        scenario.controller.abort();
        scenario.controller = new AbortController();
      }
      // said beside the looks: a phrase takes seconds, the camera keeps being watched meanwhile
      for (const action of actions) {
        const controller = scenario.controller;
        const escalation = scenario.engine.state.escalation;
        // once due, the parents are told: VOICE has told the child so, and the child stepping away a moment later or a
        // classifier saying "no" for a minute does not take it back; a parent who gave time or let the break go does
        const notice = () =>
          !this.stopped &&
          this.scenarios.get(key) === scenario &&
          scenario.engine.config.enabled &&
          scenario.engine.reason(this.deps.clock.now(), this.deps.timeZone()) === action.facts.reason;
        // the reminders of this notice, kept now: by the time it goes a step may have begun another escalation (state saved
        // before 0.4.0 has no `since`: the first step is as far back as the steps between them)
        const reminders: Reminders | undefined = escalation && {
          since: escalation.since ?? escalation.at - (escalation.level - 1 + escalation.repeats) * scenario.engine.config.repeatMinutes * MINUTE,
        };
        const phrase = () =>
          !this.stopped &&
          this.scenarios.get(key) === scenario &&
          scenario.controller === controller &&
          scenario.engine.config.enabled &&
          scenario.engine.state.present &&
          scenario.engine.state.blindSince === undefined &&
          scenario.engine.state.escalation === escalation &&
          escalation?.level === action.facts.level &&
          scenario.engine.reason(this.deps.clock.now(), this.deps.timeZone()) === action.facts.reason &&
          (action.facts.reason === 'bedtime' || !activeInterval(this.deps.quiet(), this.deps.clock.now(), this.deps.timeZone()));
        const valid = action.type === 'notify' ? notice : phrase;
        scenario.acting = scenario.acting
          .then(() => this.act(key, scenario, action, controller.signal, valid, reminders))
          .catch((error: Error) => this.deps.log(`${scenario.engine.config.childName}: ${error.message}`));
      }
    }
    await this.persist(now);
  }

  /** A parent gives more time, or lets the next break go. */
  extend(key: string, minutes: number | undefined, skipBreak: boolean): void {
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > 240)) throw new Error('minutes: from 1 to 240');
    const scenario = this.scenarios.get(key);
    if (!scenario) throw new Error(`unknown scenario ${key}`);
    scenario.controller.abort();
    scenario.controller = new AbortController();
    if (minutes) scenario.engine.extend(minutes, this.deps.clock.now());
    if (skipBreak) scenario.engine.skipBreak();
    void this.persist(this.deps.clock.now(), true);
  }

  /** The zone of the clock times VOICE says and reports. */
  timeZone(): string {
    return this.deps.timeZone();
  }

  /** A child's past days: minutes, sessions, breaks, reminders and violations, the last `days` up to `lastDate`. */
  reportOf(key: string, lastDate: string | undefined, days: number): DayReport[] {
    const scenario = this.scenarios.get(key);
    if (!scenario) return [];
    const now = this.deps.clock.now();
    const timeZone = this.deps.timeZone();
    return dayReports(scenario.engine.state, { lastDate: lastDate ?? today(now, timeZone), days, now, timeZone, watching: scenario.engine.config.enabled });
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

  // ---- called by name ----

  /** Whether the microphone of the camera listens for «ВиОН», for the parents' status; '' when no child asks for it. */
  callStatusOf(cameraId: string): string {
    const t = texts(this.deps.language()).status;
    if (!this.callWanted(cameraId, true)) return this.callWanted(cameraId, false) ? t.callLanguage : '';
    const state = this.calls.stateOf(cameraId);
    if (state.state === 'failing') return fill(t.callFailed, { reason: state.reason });
    return state.state === 'listening' ? t.call : '';
  }

  /**
   * The child called VOICE by name: where they stand, in minutes; a request for more time goes to the parents. The
   * words do not go to the assistant: the microphone is open all the time, and a game shouting "Леон" would send its
   * lines out. VOICE cannot tell which child called: every child at the computer is answered, else the one seen last.
   */
  async answerCall(cameraId: string, question: string, heard: string): Promise<void> {
    const camera = this.cameras.get(cameraId);
    const controller = this.controllers.get(cameraId);
    if (!camera || !controller || this.stopped || controller.signal.aborted || this.talking.has(cameraId)) return;
    // VOICE's own phrase coming back: a child named Леон would have VOICE answer itself
    if (isEcho(heard, this.lastSaid.get(cameraId))) return;
    const candidates = [...this.scenarios.entries()].filter(([, s]) => s.cameraId === cameraId && s.engine.config.enabled && s.engine.config.answerOnCall);
    if (!candidates.length) return;
    const present = candidates.filter(([, s]) => s.engine.state.present);
    const seenLast = candidates.reduce((last, c) => ((c[1].engine.state.lastSeen ?? 0) > (last[1].engine.state.lastSeen ?? 0) ? c : last));
    const now = this.deps.clock.now();
    const timeZone = this.deps.timeZone();
    const quiet = Boolean(activeInterval(this.deps.quiet(), now, timeZone));
    const answered = (present.length ? present : [seenLast])
      .map(([key, scenario]) => ({ key, scenario, standing: scenario.engine.standing(now, timeZone) }))
      .filter(({ standing }) => !quiet || standing.kind === 'bedtime');
    if (!answered.length) {
      this.deps.log(`${camera.name}: called in the quiet hours, not answered`);
      return;
    }
    const language = this.deps.language();
    const names = answered.map(({ scenario }) => scenario.engine.config.childName).join(' / ');
    const reply = answered.map(({ scenario, standing }) => replyText(standing, scenario.engine.config.childName, language)).join(' ');
    // the answer takes the camera like a conversation: a reminder said now would be talked over
    let endTurn = () => {};
    const turn = new Promise<void>((resolve) => (endTurn = resolve));
    this.talking.set(cameraId, turn);
    const valid = () =>
      !this.stopped &&
      this.controllers.get(cameraId) === controller &&
      !controller.signal.aborted &&
      answered.every(({ key, scenario }) => this.scenarios.get(key) === scenario && scenario.engine.config.enabled);
    try {
      const answer = await answerChild(undefined, reply, question, language);
      const said = question ? `${CALL_NAME}, ${question}` : CALL_NAME;
      if (answer.intent === 'asks_more_time') {
        const t = texts(language).notify;
        const values = { name: names, text: said };
        await this.notifyParents(camera, fill(t.moreTimeTitle, values), fill(t.moreTime, values), `voice:${answered[0].key}:more`, valid);
      }
      if (!valid()) return;
      await this.speak(cameraId, answer.text, answer.source, valid, controller.signal);
      const last = this.recent[this.recent.length - 1];
      if (last?.cameraId === cameraId && last.said === answer.text) {
        last.heard = said;
        last.child = names;
      }
    } catch (error) {
      this.deps.log(`${camera.name}: the call was not answered: ${(error as Error).message}`);
    } finally {
      if (this.talking.get(cameraId) === turn) this.talking.delete(cameraId);
      endTurn();
    }
  }

  /** A child of the camera asks to be answered when calling; with `inLanguage`, in a language the name is known in. */
  private callWanted(cameraId: string, inLanguage: boolean): boolean {
    if (this.stopped || !this.cameras.has(cameraId)) return false;
    if (inLanguage && !CALL_LANGUAGES.includes(this.deps.language())) return false;
    return [...this.scenarios.values()].some((s) => s.cameraId === cameraId && s.engine.config.enabled && s.engine.config.answerOnCall);
  }

  /** Opens the microphone where a child may call (`open`), and closes it where none may any more. */
  private syncCalls(cameraId: string, open: boolean): void {
    const wanted = this.callWanted(cameraId, true);
    if (!wanted) this.calls.want(cameraId, false);
    else if (open) this.calls.want(cameraId, true);
  }

  // ---- inside ----

  private async act(key: string, scenario: Scenario, action: ScreenTimeAction, scenarioSignal: AbortSignal, valid: () => boolean, reminders?: Reminders): Promise<void> {
    const language = this.deps.language();
    const camera = this.cameras.get(scenario.cameraId);
    if (!camera) return;
    // the parents' notice says in the log why it did not go
    if (action.type === 'notify') {
      await this.tellParents(key, scenario, camera, action.facts, language, valid, reminders);
      return;
    }
    if (!valid()) return;
    const cameraSignal = this.controllers.get(camera.id)!.signal;
    const signal = AbortSignal.any([cameraSignal, scenarioSignal]);
    // the microphone hears the camera's own speaker: a phrase now would come back as the child's answer
    while (this.talking.has(camera.id)) await this.waitFor(this.talking.get(camera.id)!, signal);
    if (!valid() || signal.aborted) return;
    // a phrase that opens a conversation takes the camera before it is said: a door phrase that came while the reminder
    // was synthesized or said queued right behind it and played into the listening window
    let endTurn = () => {};
    const converses = scenario.engine.config.answerQuestions;
    const turn = new Promise<void>((resolve) => (endTurn = resolve));
    if (converses) this.talking.set(camera.id, turn);
    let talk: Promise<void> | undefined;
    try {
      const phrase = await this.waitFor(nudgePhrase(this.deps.ask, action.facts, language, action.kind), signal);
      if (!valid() || signal.aborted) return;
      if (phrase.fallback) this.deps.log(`${camera.name}: template phrase (${phrase.fallback})`);
      const result = await this.speak(camera.id, phrase.text, phrase.source, valid, signal);
      scenario.unspoken = result.status === 'spoken' ? undefined : (result.reason ?? result.status);
      // the journal counts what the child heard: a step VOICE could not say is not a reminder let pass
      if (result.status === 'spoken' && reminders) scenario.engine.noteSaid(reminders.since, action.facts.reason, action.facts.level, this.deps.timeZone());
      // the conversation runs beside the looks: the camera keeps being watched while the child answers
      if (result.status === 'spoken' && converses && valid()) talk = this.converse(key, scenario, camera, signal);
    } finally {
      if (converses) {
        void (talk ?? Promise.resolve()).finally(() => {
          if (this.talking.get(camera.id) === turn) this.talking.delete(camera.id);
          endTurn();
        });
      }
    }
  }

  private async converse(key: string, scenario: Scenario, camera: CameraPort, signal: AbortSignal): Promise<void> {
    const valid = () => !signal.aborted && this.scenarios.get(key) === scenario && this.cameras.get(camera.id) === camera && scenario.engine.config.enabled;
    try {
      const language = this.deps.language();
      for (let exchange = 0; exchange < MAX_EXCHANGES; exchange++) {
        if (!valid()) return;
        if (this.waiting.get(camera.id)) {
          this.deps.log(`${camera.name}: conversation ended for a phrase from outside`);
          return;
        }
        await this.delay(LISTEN_DELAY_MS, signal);
        if (!valid()) return;
        const audio = await this.waitFor(camera.listen(this.deps.listenSeconds() * 1000, signal), signal);
        if (!valid()) return;
        if (!audio?.length) return;
        const heard = (await this.waitFor(this.deps.engine.transcribe(audio, language), signal)).trim();
        if (!valid()) return;
        if (!heard) return;
        // VOICE's own phrase coming back through the microphone: its words ("only the parents give more time") would
        // read as the child asking, notify the parents and be answered again
        if (isEcho(heard, this.lastSaid.get(camera.id))) {
          this.deps.log(`${camera.name}: heard its own phrase, not an answer`);
          return;
        }
        const now = this.deps.clock.now();
        const facts: Facts = scenario.engine.facts(now, { timeZone: this.deps.timeZone(), language });
        const reply = replyText(scenario.engine.standing(now, this.deps.timeZone()), facts.childName, language);
        const answer = await this.waitFor(answerChild(this.deps.ask, reply, heard, language), signal);
        if (!valid()) return;
        if (answer.intent === 'asks_more_time') {
          const t = texts(language).notify;
          const values = { name: facts.childName, text: heard };
          await this.notifyParents(camera, fill(t.moreTimeTitle, values), fill(t.moreTime, values), `voice:${key}:more`, valid);
        }
        const result = await this.speak(camera.id, answer.text, answer.source, valid, signal);
        const last = this.recent[this.recent.length - 1];
        if (last) last.heard = heard;
        if (last) last.child = facts.childName;
        if (result.status !== 'spoken') return;
      }
    } catch (error) {
      this.deps.log(`${camera.name}: conversation stopped: ${(error as Error).message}`);
    }
  }

  /**
   * The parents learn that the child kept on: the notice with the picture opens an event in the camera's recordings
   * («Сыночка за компьютером во время сна», the reminders let pass) with its video. Every notice is in the log, sent or
   * not and why: one VOICE announced to the child at 22:36 (2026-10-09) left no trace anywhere. No second notice with a
   * clip: it would run the owner's automations again, and the event already has the video.
   */
  private async tellParents(
    key: string,
    scenario: Scenario,
    camera: CameraPort,
    facts: Facts,
    language: Language,
    valid: () => boolean,
    reminders: Reminders | undefined,
  ): Promise<void> {
    const t = texts(language);
    const { title, body } = templateNotify(facts, language);
    const refused = () => this.deps.log(`${camera.name}: the parents were not told «${title}»: VOICE stopped, the scenario changed or time was given`);
    if (!valid()) {
      refused();
      return;
    }
    // a reminder the child never heard is not "the child does not stop": the parents learn why it was not said
    const unheard = scenario.unspoken ? ` ${fill(t.notify.notSaid, { reason: scenario.unspoken })}` : '';
    const thumbnail = await this.withTimeout(camera.snapshot(), SNAPSHOT_WAIT_MS, 'the snapshot').catch(() => undefined);
    const now = this.deps.clock.now();
    const since = Math.min(reminders?.since ?? now, now);
    let event: NvrEvent | undefined;
    if (this.deps.nvr) {
      const values = { name: facts.childName, count: facts.level, since: formatClock(since, this.deps.timeZone()) };
      try {
        event = await this.withTimeout(
          this.deps.nvr.addEvent(camera.id, {
            title: fill(t.event[facts.reason], values),
            description: `${body} ${fill(t.event.reminders, values)}${unheard}`,
            tags: [t.event.tag],
            startTime: since,
            recordSeconds: VIOLATION_RECORD_SECONDS,
            ...(thumbnail ? { snapshot: thumbnail } : {}),
          }),
          NVR_WAIT_MS,
          'the NVR',
        );
      } catch (error) {
        this.deps.log(`${camera.name}: no event in the recordings: ${(error as Error).message}`);
      }
    }
    if (!valid()) {
      refused();
      return;
    }
    const notice: Notification = {
      title,
      body: body + unheard,
      severity: Severity.Warn,
      tag: `voice:${key}`,
      // for the parents only: the picture of a child's room does not go to every user of the house
      adminOnly: true,
      ...(thumbnail ? { thumbnail } : {}),
      data: { cameraId: camera.id, ...(event ? { eventId: event.eventId } : {}) },
      // the event when there is one, and the moment the reminders began for an app that does not open events by id
      deepLink: `/cameras/${encodeURIComponent(camera.name)}?${event ? `eventId=${encodeURIComponent(event.eventId)}&` : ''}startTs=${since}`,
    };
    try {
      await this.deps.publish(notice);
    } catch (error) {
      this.deps.log(`${camera.name}: the parents were not told «${title}»: ${(error as Error).message}`);
      return;
    }
    if (reminders) scenario.engine.noteTold(reminders.since, facts.reason, this.deps.timeZone());
    this.deps.log(`${camera.name}: the parents were told «${title}»${event ? `, event ${event.eventId}` : ', without an event in the recordings'}`);
  }

  /** The work, or an error when it takes longer than `ms`. */
  private withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s`)), ms);
      work.then(resolve, reject).finally(() => this.deps.clock.clearTimeout(timer));
    });
  }

  private async notifyParents(camera: CameraPort, title: string, body: string, tag: string, valid: () => boolean): Promise<void> {
    const thumbnail = await camera.snapshot().catch(() => undefined);
    if (!valid()) return;
    // for the parents only: the picture of a child's room and the child's words do not go to every user of the house
    await this.deps
      .publish({ title, body, severity: Severity.Warn, tag, adminOnly: true, ...(thumbnail ? { thumbnail } : {}) })
      .catch((error: Error) => this.deps.log(`notification not sent: ${error.message}`));
  }

  private remember(exchange: Exchange): void {
    this.recent.push(exchange);
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
  }

  /** Abort pending RPC/model work without leaving a conversation or its following phrases blocked. */
  private waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('the operation was cancelled'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.deps.clock.clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.deps.clock.setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
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
