/**
 * The door agent's conversation with sound: it says the agent's phrases through the panel and hears the visitor, one
 * at a time (half duplex), until the agent ends it, a person takes the call over, or the time runs out.
 *
 * - While a phrase is said, and a little after, the microphone is deaf: the panel's own speaker comes back through it.
 *   What it still hears of the phrase (a run of its words) is not an answer either (the speech package's echo check).
 * - The LLM may take a few seconds: after 1.5 s the agent says "one moment" once, so the visitor does not walk away.
 * - The owner's words typed in the call card are said as they come, between the visitor's phrases.
 * - When the agent asked the owners, their answer is waited for 45 s, then the agent says they cannot answer.
 *
 * Sound in and out is given (`ConversationIO`): the panel's talk channel and microphone, or the RTP of a SIP call.
 */
import { isEcho } from '@vionvision/speech';

import type { Clock, Hearing, SpeakResult } from '@vionvision/speech';
import type { Outcome } from '../types.js';
import type { AgentAction, AgentReply, DoorAgent } from './dialog.js';

export interface PreparedPhrase {
  /** how long the phrase lasts when said */
  durationMs: number;
  /** says it; resolves when the last of it went out */
  play(): Promise<SpeakResult>;
}

export interface ConversationIO {
  /** synthesizes the phrase; it is said by `play()` */
  prepare(text: string): Promise<PreparedPhrase>;
  /** opens the microphone */
  listen(): Promise<{ hearing: Hearing; ended: Promise<string | undefined>; stop(): void }>;
  transcribe(samples: Float32Array): Promise<string>;
}

export interface ConversationHooks {
  action(action: AgentAction): void;
  /** a phrase was said, or could not be */
  said(text: string, result: SpeakResult): void;
  /** the voice message: its samples at 16 kHz */
  voicemail(samples: Float32Array): void;
}

export interface ConversationTiming {
  /** after a phrase, how long to wait for the visitor before "can you hear me" */
  silenceMs: number;
  fillerAfterMs: number;
  /** deaf this long after a phrase ends */
  tailMs: number;
  maxMs: number;
  ownerWaitMs: number;
  voicemailMs: number;
}

export const DEFAULT_TIMING: ConversationTiming = {
  silenceMs: 8_000,
  fillerAfterMs: 1_500,
  tailMs: 500,
  maxMs: 3 * 60_000,
  ownerWaitMs: 45_000,
  voicemailMs: 30_000,
};

/** How often the voice message looks whether the visitor still speaks, how long a pause ends it, how long to wait for a start. */
const VOICEMAIL_LOOK_MS = 500;
const VOICEMAIL_PAUSE_MS = 2_500;
const VOICEMAIL_START_MS = 6_000;

type Input = { kind: 'utterance'; samples: Float32Array } | { kind: 'owner'; text: string; userId?: string } | { kind: 'wake' };

export class Conversation {
  private inputs: Input[] = [];
  private wake: (() => void) | undefined;
  private stopped: Outcome | 'taken_over' | undefined;
  private lastSaid: string | undefined;
  private voicemailSamples: Float32Array[] | undefined;
  private timers: unknown[] = [];

  constructor(
    private readonly agent: DoorAgent,
    private readonly io: ConversationIO,
    private readonly clock: Clock,
    private readonly hooks: ConversationHooks,
    private readonly timing: ConversationTiming = DEFAULT_TIMING,
    private readonly filler = 'Секунду.',
  ) {}

  /** The owner's words for the visitor, typed in the call card. */
  ownerSays(text: string, userId?: string): void {
    this.push({ kind: 'owner', text, userId });
  }

  /** A person took the call over, or the visitor left: the agent stops at once, without a phrase. */
  stop(why: Outcome | 'taken_over'): void {
    this.stopped ??= why;
    this.push({ kind: 'wake' });
  }

  private push(input: Input): void {
    this.inputs.push(input);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private next(timeoutMs: number): Promise<Input | undefined> {
    const queued = this.inputs.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.wake = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.wake = () => {
        this.clock.clearTimeout(timer);
        resolve(this.inputs.shift());
      };
    });
  }

  private async say(reply: AgentReply, hearing: Hearing | undefined): Promise<void> {
    for (const action of reply.actions) this.hooks.action(action);
    if (!reply.say || this.stopped) return;
    const phrase = await this.io.prepare(reply.say);
    // deaf from now until the phrase and its echo are over
    hearing?.deafUntil(this.clock.now() + phrase.durationMs + 1_000 + this.timing.tailMs);
    const result = await phrase.play();
    this.lastSaid = reply.say;
    this.hooks.said(reply.say, result);
    if (reply.actions.some((action) => action.kind === 'voicemail')) this.voicemailSamples = [];
  }

  /** Runs the conversation to its end; the outcome of the visit as the agent saw it. */
  async run(): Promise<Outcome | 'taken_over'> {
    let audio: Awaited<ReturnType<ConversationIO['listen']>> | undefined;
    try {
      audio = await this.io.listen();
    } catch {
      audio = undefined;
    }
    const hearing = audio?.hearing;
    hearing?.onUtterance((samples) => {
      if (!this.voicemailSamples) this.push({ kind: 'utterance', samples });
    });
    hearing?.onAudio((samples) => this.voicemailSamples?.push(samples));
    const deadline = this.clock.now() + this.timing.maxMs;
    try {
      const first = await this.agent.start();
      await this.say(first, hearing);
      if (first.end) return first.end;
      if (!hearing) {
        // no microphone: the greeting is all the agent can give
        await this.say(this.agent.timeUp(), undefined);
        return this.agent.stop('agent');
      }
      let ownerSince: number | undefined;
      for (;;) {
        if (this.stopped) return this.stopped === 'taken_over' ? 'taken_over' : this.agent.stop(this.stopped);
        if (this.voicemailSamples) {
          const samples = await this.recordVoicemail(hearing);
          if (this.stopped) continue;
          this.hooks.voicemail(samples);
          const text = samples.length ? await this.io.transcribe(samples).catch(() => '') : '';
          const reply = this.agent.voicemailDone(text);
          await this.say(reply, hearing);
          return reply.end ?? 'message';
        }
        const now = this.clock.now();
        if (now >= deadline) {
          const reply = this.agent.timeUp();
          await this.say(reply, hearing);
          return reply.end ?? this.agent.stop();
        }
        ownerSince = this.agent.waitingForOwner ? (ownerSince ?? now) : undefined;
        const wait = ownerSince !== undefined ? ownerSince + this.timing.ownerWaitMs - now : this.timing.silenceMs;
        const input = await this.next(Math.max(0, Math.min(wait, deadline - now)));
        if (this.stopped) continue;
        let reply: AgentReply;
        if (!input) {
          if (ownerSince !== undefined) {
            ownerSince = undefined;
            reply = this.agent.ownerTimeout();
          } else if (this.clock.now() >= deadline) continue;
          else if (hearing.speaking()) continue;
          else reply = this.agent.silence();
        } else if (input.kind === 'owner') {
          ownerSince = undefined;
          reply = this.agent.ownerSays(input.text, input.userId);
        } else if (input.kind === 'wake') continue;
        else {
          const text = await this.io.transcribe(input.samples).catch(() => '');
          // the end of its own phrase, heard after the deafness: not the visitor
          if (text && isEcho(text, this.lastSaid)) continue;
          reply = await this.withFiller(this.agent.heardText(text), hearing);
        }
        await this.say(reply, hearing);
        if (reply.end) return reply.end;
      }
    } finally {
      for (const timer of this.timers) this.clock.clearTimeout(timer);
      audio?.stop();
    }
  }

  /** The agent's answer; "one moment" said first when it takes long (the LLM thinking). */
  private async withFiller(answer: Promise<AgentReply>, hearing: Hearing): Promise<AgentReply> {
    let done = false;
    const filler = new Promise<void>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        if (done || this.stopped) return resolve();
        void this.say({ say: this.filler, actions: [], listen: true }, hearing).finally(resolve);
      }, this.timing.fillerAfterMs);
      this.timers.push(timer);
      void answer.finally(() => {
        if (!done) this.clock.clearTimeout(timer);
        done = true;
        resolve();
      });
    });
    const reply = await answer;
    done = true;
    await filler;
    return reply;
  }

  private async recordVoicemail(hearing: Hearing): Promise<Float32Array> {
    const start = this.clock.now();
    const end = start + this.timing.voicemailMs;
    let lastSpeech: number | undefined;
    // until the time is up, the visitor stopped talking for a while (or never began), or the call ends
    while (!this.stopped && this.clock.now() < end) {
      await this.next(Math.min(VOICEMAIL_LOOK_MS, end - this.clock.now()));
      const now = this.clock.now();
      if (hearing.speaking()) lastSpeech = now;
      if (lastSpeech !== undefined ? now - lastSpeech >= VOICEMAIL_PAUSE_MS : now - start >= VOICEMAIL_START_MS) break;
    }
    const parts = this.voicemailSamples ?? [];
    this.voicemailSamples = undefined;
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    return samples;
  }
}
