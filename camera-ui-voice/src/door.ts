/**
 * The "who is at the door" scenario: a door camera starts an event with a person, VOICE says who came in the rooms
 * with a speaker. Once per event (its start), once per person within the cooldown, and not in the rule's quiet hours.
 */
import { activeInterval } from './time.js';
import { fill, texts } from './speech.js';

import type { DetectionEvent, DetectionEventType } from '@camera.ui/sdk';
import type { DoorRule, PersonValues } from './settings.js';
import type { SpeakResult } from './speaker.js';
import type { Language } from './speech.js';
import type { Clock, WeeklyInterval } from './time.js';

export interface DoorDeps {
  clock: Clock;
  timeZone: () => string;
  language: () => Language;
  people: () => PersonValues[];
  rules: () => DoorRule[];
  /** Quiet hours of VOICE: nothing is said then, whatever the rule. */
  quiet: () => WeeklyInterval[];
  say: (speakerId: string, text: string) => Promise<SpeakResult>;
  /** A short description of who is at the door from a snapshot ("a courier with a box"), or undefined. */
  describe: (cameraId: string, language: Language, timeoutMs: number) => Promise<string | undefined>;
  log: (message: string) => void;
}

/** The face is often recognized a moment after the event starts: VOICE waits this long for it. */
export const FACE_WAIT_MS = 2_500;
export const DESCRIBE_TIMEOUT_MS = 5_000;

export function facesOf(event: DetectionEvent): string[] {
  const out = new Set<string>();
  for (const segment of event.segments ?? []) {
    for (const attribute of segment.attributes ?? []) if (attribute.type === 'face' && attribute.label) out.add(attribute.label);
  }
  return [...out];
}

export function labelsOf(event: DetectionEvent): string[] {
  const out = new Set<string>();
  for (const trigger of event.triggers ?? []) if (trigger.label) out.add(trigger.label);
  for (const segment of event.segments ?? []) for (const detection of segment.detections ?? []) out.add(detection.label);
  return [...out];
}

/** What an event of a door camera showed so far, gathered over its messages. */
interface Seen {
  cameraId: string;
  labels: Set<string>;
  faces: Set<string>;
  timer?: unknown;
  /** Decided (said or not): later messages of the event change nothing. */
  done: boolean;
  /** Forgets a decided event whose end never came, 10 minutes after its last message. */
  forget?: unknown;
}

const FORGET_MS = 10 * 60_000;

export class DoorWatcher {
  private events = new Map<string, Seen>();
  private lastSaid = new Map<string, number>();

  constructor(private deps: DoorDeps) {}

  /**
   * Every message of every event passes here. The server starts an event with the motion and no segment, sends the
   * person in a later segment message, and then updates that carry no segments again: deciding on the last message,
   * once, 2.5 s after the start, said nothing for a person who came a moment later. So what each message shows is
   * gathered, and the wait for a face starts when the first box of a rule's label arrives.
   */
  onEvent(type: DetectionEventType, event: DetectionEvent): void {
    let seen = this.events.get(event.id);
    if (!seen) {
      if (type === 'end' || !this.deps.rules().some((rule) => rule.doorCameras.includes(event.cameraId))) return;
      seen = { cameraId: event.cameraId, labels: new Set(), faces: new Set(), done: false };
      this.events.set(event.id, seen);
    }
    for (const label of labelsOf(event)) seen.labels.add(label);
    for (const face of facesOf(event)) seen.faces.add(face);
    if (!seen.done && seen.timer === undefined && this.wanted(seen)) {
      seen.timer = this.deps.clock.setTimeout(() => void this.decide(event.id), FACE_WAIT_MS);
    }
    // an event that ended is forgotten, unless its decision is under way: that finishes first
    if (type === 'end' && (seen.done || seen.timer === undefined)) {
      this.deps.clock.clearTimeout(seen.forget);
      this.events.delete(event.id);
    } else if (seen.done) this.forgetLater(event.id, seen);
  }

  /** Waiting decisions are dropped: the plugin stops. */
  stop(): void {
    for (const { timer, forget } of this.events.values()) {
      if (timer !== undefined) this.deps.clock.clearTimeout(timer);
      if (forget !== undefined) this.deps.clock.clearTimeout(forget);
    }
    this.events.clear();
  }

  /**
   * A decided event stays known while its messages come, so the rest of it does not start it again: forgotten 10
   * minutes after the decision, a person standing at the door for half an hour was announced every 10 minutes.
   */
  private forgetLater(eventId: string, seen: Seen): void {
    this.deps.clock.clearTimeout(seen.forget);
    seen.forget = this.deps.clock.setTimeout(() => this.events.delete(eventId), FORGET_MS);
  }

  private wanted(seen: Seen): boolean {
    return this.deps.rules().some((rule) => rule.doorCameras.includes(seen.cameraId) && rule.labels.some((label) => seen.labels.has(label)));
  }

  private async decide(eventId: string): Promise<void> {
    const seen = this.events.get(eventId);
    if (!seen || seen.done) return;
    seen.done = true;
    this.forgetLater(eventId, seen);
    const event = { cameraId: seen.cameraId };
    const now = this.deps.clock.now();
    const language = this.deps.language();
    const labels = [...seen.labels];
    const faces = [...seen.faces];
    const known = faces.find((face) => face !== 'unknown');

    // the rules at once: a room where VOICE talks with a child holds its phrase, the rooms of the next rule did wait
    const work: Promise<void>[] = [];
    for (const [index, rule] of this.deps.rules().entries()) {
      if (!rule.doorCameras.includes(event.cameraId)) continue;
      if (!rule.labels.some((label) => labels.includes(label))) continue;
      if (activeInterval([...rule.quiet, ...this.deps.quiet()], now, this.deps.timeZone())) {
        this.deps.log(`door: quiet hours, not saying who came (${known ?? 'not recognized'})`);
        continue;
      }
      const who = known ?? (faces.includes('unknown') ? 'unknown' : 'someone');
      const key = `${index}:${who}`;
      const last = this.lastSaid.get(key);
      if (last !== undefined && now - last < rule.cooldownSeconds * 1000) continue;
      this.lastSaid.set(key, now);
      work.push(this.announce(rule, event.cameraId, known, faces.includes('unknown'), language));
    }
    await Promise.all(work);
  }

  private async announce(rule: DoorRule, cameraId: string, known: string | undefined, stranger: boolean, language: Language): Promise<void> {
    let text = this.phrase(known, stranger, language);
    if (!known && rule.describe) {
      const description = await this.deps.describe(cameraId, language, DESCRIBE_TIMEOUT_MS).catch((error: Error) => {
        this.deps.log(`door: no description: ${error.message}`);
        return undefined;
      });
      if (description) text = description;
    }
    // every room at once: one after the other, the last room heard it seconds late
    await Promise.all(
      rule.speakers.map(async (speaker) => {
        const result = await this.deps.say(speaker, text);
        if (result.status !== 'spoken') this.deps.log(`door: ${speaker}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      }),
    );
  }

  phrase(known: string | undefined, stranger: boolean, language: Language): string {
    const t = texts(language).door;
    if (known) {
      const person = this.deps.people().find((p) => p.name?.trim().toLowerCase() === known.toLowerCase());
      return fill(t[person?.gender ?? 'neutral'], { name: known });
    }
    return stranger ? t.unknown : t.label;
  }
}
