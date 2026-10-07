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

export class DoorWatcher {
  private pending = new Map<string, { event: DetectionEvent; timer: unknown }>();
  private lastSaid = new Map<string, number>();

  constructor(private deps: DoorDeps) {}

  /** Every event of every camera passes here; only the start of an event at a door camera leads to speech. */
  onEvent(type: DetectionEventType, event: DetectionEvent): void {
    const waiting = this.pending.get(event.id);
    if (waiting) {
      waiting.event = event;
      return;
    }
    if (type !== 'start') return;
    if (!this.deps.rules().some((rule) => rule.doorCameras.includes(event.cameraId))) return;
    const timer = this.deps.clock.setTimeout(() => void this.decide(event.id), FACE_WAIT_MS);
    this.pending.set(event.id, { event, timer });
  }

  /** Waiting decisions are dropped: the plugin stops. */
  stop(): void {
    for (const { timer } of this.pending.values()) this.deps.clock.clearTimeout(timer);
    this.pending.clear();
  }

  private async decide(eventId: string): Promise<void> {
    const entry = this.pending.get(eventId);
    this.pending.delete(eventId);
    if (!entry) return;
    const { event } = entry;
    const now = this.deps.clock.now();
    const language = this.deps.language();
    const labels = labelsOf(event);
    const faces = facesOf(event);
    const known = faces.find((face) => face !== 'unknown');

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

      let text = this.phrase(known, faces.includes('unknown'), language);
      if (!known && rule.describe) {
        const description = await this.deps.describe(event.cameraId, language, DESCRIBE_TIMEOUT_MS).catch((error: Error) => {
          this.deps.log(`door: no description: ${error.message}`);
          return undefined;
        });
        if (description) text = description;
      }
      for (const speaker of rule.speakers) {
        const result = await this.deps.say(speaker, text);
        if (result.status !== 'spoken') this.deps.log(`door: ${speaker}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      }
    }
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
