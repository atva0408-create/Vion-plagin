/**
 * The intercom at work: a press becomes a visit and a call, the call rings whom the mode says, the agent answers when
 * nobody does, a door opens by a person or a rule, and the visit ends with a summary for the owners. The decisions are
 * the pure functions of the other modules (call.ts, route.ts, rules.ts, the agent); this class runs them with timers,
 * keeps the store, and talks to the world through `IntercomHost`, which the plugin gives (cameras, sensors, the
 * recorder, notifications) and the specs fake.
 *
 * Every method a person calls takes the `actor` the server vouches for, and checks the rights here (access.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Severity } from '@camera.ui/sdk';
import { LANGUAGE_NAMES, formatClock, localTime } from '@vionvision/speech';

import { IntercomError, canOpen, canSetMode, isAdmin, needAdmin } from './access.js';
import { DoorAgent } from './agent/dialog.js';
import { Conversation, DEFAULT_TIMING } from './agent/conversation.js';
import { ownerText, ownerTexts, summarizeVisit } from './agent/summary.js';
import { agentTexts } from './agent/texts.js';
import { ALL_USERS, newCall, step } from './call.js';
import { CodeGuard, codeUsable, findCode, hashSecret, newCode, secretMatches, tokenHash, tokenMatches } from './codes.js';
import { faceIdentifications, knownPerson, plateIdentifications } from './identify.js';
import { checkCodeRequest, checkInstruction, checkPanel, checkPerson } from './inputs.js';
import { activeInstructions, matchInstruction } from './instructions.js';
import { currentMode, expiredMode } from './modes.js';
import { route } from './route.js';
import { mayOpen } from './rules.js';
import { checkSettings, withDefaults } from './settings.js';
import { instructionOver } from './schedule.js';
import { MODES } from './types.js';

import type { Notification } from '@camera.ui/sdk';
import type { Clock, Language } from '@vionvision/speech';
import type { Actor } from './access.js';
import type { AgentAction, Ask } from './agent/dialog.js';
import type { ConversationIO } from './agent/conversation.js';
import type { Call, CallEvent, StepContext, StepResult } from './call.js';
import type { FaceSighting, PlateSighting } from './identify.js';
import type { PanelWorld } from './inputs.js';
import type { CurrentMode } from './modes.js';
import type { Route } from './route.js';
import type { IntercomSettings } from './settings.js';
import type { VisitPage, VisitQuery, Store } from './store.js';
import type { GuestCode, Identification, Instruction, ModeId, ModeState, Outcome, Panel, PanelDoor, Person, Visit } from './types.js';

export { ALL_USERS };
/** Ringing with no agent to take over ends as missed after this. */
export const RING_MAX_MS = 60_000;
/** A person's call: at most this long. */
export const ANSWERED_MAX_MS = 10 * 60_000;
/** The recorder is asked for this many minutes, and again before they run out. */
const RECORD_MINUTES = 5;
const RECORD_EVERY_MS = 4 * 60_000;
/** Faces and plates seen this long before a press count for the visit. */
const SEEN_BEFORE_MS = 60_000;
/** "Rang and ran": this many visits with nobody within the window silence the panel for the next while. */
const NOBODY_STREAK = 3;
const NOBODY_WINDOW_MS = 10 * 60_000;
const SILENCE_MS = 10 * 60_000;
/** A visitor gone from the picture this long when the agent would answer: "rang and ran". */
const NOBODY_SEEN_MS = 5_000;
const MAX_SNAPSHOTS = 6;
/** A plate that opened a gate does not open it again within this. */
const PLATE_AGAIN_MS = 2 * 60_000;
/** A presence visit is not made again for the same panel within this. */
const PRESENCE_AGAIN_MS = 5 * 60_000;
/** a code typed at the keypad with no call: its visit waits this long for more tries, ringing nobody */
const QUIET_CODE_MS = 60_000;
const SIMULATION_TTL_MS = 15 * 60_000;
const INSTRUCTIONS_KEPT_MS = 30 * 24 * 60 * 60_000;

export interface DoorResult {
  result: 'confirmed' | 'sent' | 'failed';
  error?: string;
}

/** What the intercom needs of one panel's camera, sensors and engine. */
export interface PanelPort {
  snapshot(): Promise<Uint8Array | undefined>;
  /** why the agent cannot speak through this panel, undefined when it can */
  speakProblem(): string | undefined;
  /** the panel's speaker and microphone for the agent */
  sound(): ConversationIO;
  /** opens the door and waits for the door to confirm (its contact, or the lock's state) */
  open(door: PanelDoor): Promise<DoorResult>;
  /** the call was answered in ViON: the panel's own monitors stop ringing */
  answered?(): Promise<void>;
  /** the call ended in ViON */
  hangUp?(): Promise<void>;
  /** whether the camera saw a person within the time; undefined when it cannot tell (no object detection) */
  personSeen(withinMs: number): boolean | undefined;
}

export interface NvrPort {
  startRecording(cameraId: string, minutes: number): Promise<void>;
  /** events of the camera overlapping the span, with their triggers */
  events(cameraId: string, from: number, to: number): Promise<{ id: string; triggers: string[] }[]>;
  favorite(eventId: string): Promise<void>;
}

export interface IntercomHost {
  clock: Clock;
  store: Store;
  /** where snapshots and voice messages of visits are kept */
  dataDir: string;
  pluginVersion: string;
  port(panel: Panel): PanelPort | undefined;
  publish(notification: Notification): Promise<void>;
  nvr(): Promise<NvrPort | undefined>;
  /** "a ring at the gate" on the house's speakers (VOICE), not on the panels */
  announce(text: string, panelCameraIds: string[]): Promise<void>;
  /** the assistant's model; undefined when the plugin may not ask it */
  ask(): Ask | undefined;
  /** one phrase about who is at the door, from a snapshot ("a man in a uniform with a box") */
  describe?(jpeg: Uint8Array, language: Language, timeoutMs: number): Promise<string | undefined>;
  /** where the panel is, for the agent ("the gate from the street") */
  place?(panel: Panel): string | undefined;
  /** a voice message as a file */
  saveVoicemail(samples: Float32Array, file: string): Promise<void>;
  /** the result of an instruction, posted into the assistant's thread it was made in; false when it could not be */
  postToThread?(threadId: string, userId: string, text: string, visitId: string): Promise<boolean>;
  /** the panels changed: engines and own sensors follow */
  panelsChanged(): void;
  /** the panel model choices, for checks */
  panelWorld(): PanelWorld;
  timeZone(): string;
  log(message: string): void;
  warn(message: string): void;
}

interface Live {
  call: Call;
  visit: Visit;
  panel: Panel;
  route: Route;
  timers: unknown[];
  agent?: DoorAgent;
  conversation?: Conversation;
  /** the owner's words that came before the agent was ready */
  ownerQueue: { text: string; userId: string }[];
  faces: FaceSighting[];
  plates: PlateSighting[];
  /** codes and PINs said or typed in this visit */
  local: Identification[];
  question?: { text: string; options: string[]; at: number };
  sees?: string;
  /** the agent could not speak: why */
  mute?: string;
  codeTries: number;
  spoke: boolean;
  usedLlm: boolean;
  finishing?: Promise<void>;
  /** a code typed with no call: a visit of its own that rings nobody and is not a call for the household */
  quiet?: boolean;
  /** the recorder is asked again every few minutes while the visit lasts; not a timer of the ringing */
  recordTimer?: unknown;
}

interface Simulation {
  agent: DoorAgent;
  at: number;
  actions: AgentAction[];
}

export interface CallView {
  callId: string;
  visitId: string;
  panelId: string;
  panelName: string;
  cameraId: string;
  state: Call['state'];
  startedAt: number;
  answeredBy?: string;
  outcome?: Outcome;
  who?: string;
  recipients: string[];
  presses: number;
  transcript: Visit['transcript'];
  question?: { text: string; options: { id: string; label: string }[] };
  flags: string[];
  /** the call rings without sound (do not disturb): a page that opens during it rings silently too */
  silent: boolean;
}

const NOTIFY_SEVERITY: Record<Instruction['notify'], Severity | undefined> = { none: undefined, quiet: Severity.Info, normal: Severity.Info, urgent: Severity.Warn };

export class Intercom {
  private everyone: string[] | undefined;
  private live = new Map<string, Live>();
  private byCall = new Map<string, Live>();
  private guard = new CodeGuard();
  private seen = new Map<string, { faces: FaceSighting[]; plates: PlateSighting[] }>();
  private nobodyAt = new Map<string, number[]>();
  private silencedUntil = new Map<string, number>();
  private plateOpened = new Map<string, number>();
  private presentSince = new Map<string, number>();
  private presenceVisitAt = new Map<string, number>();
  private simulations = new Map<string, Simulation>();
  private lastPurge = 0;

  constructor(private readonly host: IntercomHost) {}

  private get store(): Store {
    return this.host.store;
  }

  now(): number {
    return this.host.clock.now();
  }

  // ---- settings and mode ----

  settings(): IntercomSettings {
    return withDefaults(this.store.getMeta<Partial<IntercomSettings>>('settings'));
  }

  language(): Language {
    return this.settings().language ?? 'ru';
  }

  timeZone(): string {
    return this.settings().timeZone ?? this.host.timeZone();
  }

  modeState(): ModeState {
    return this.store.getMeta<ModeState>('mode') ?? { mode: 'home' };
  }

  currentMode(): CurrentMode {
    return currentMode(this.modeState(), this.settings().night, this.now(), this.timeZone());
  }

  getSettings(actor: Actor): IntercomSettings {
    needAdmin(actor);
    return this.settings();
  }

  setSettings(actor: Actor, patch: Record<string, unknown>): IntercomSettings {
    needAdmin(actor);
    const checked = checkSettings(this.settings(), patch ?? {});
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    const portChanged = checked.value.sipPort !== this.settings().sipPort;
    this.store.setMeta('settings', checked.value);
    // the panels that call over SIP move to the new port
    if (portChanged) this.host.panelsChanged();
    return checked.value;
  }

  setMode(actor: Actor, mode: string, until?: number): { mode: ModeId; until?: number } {
    if (!canSetMode(actor, this.settings())) throw new IntercomError('forbidden', 'you may not change the mode');
    if (!(MODES as readonly string[]).includes(mode)) throw new IntercomError('invalid', `mode: one of ${MODES.join(', ')}`);
    if (until !== undefined && (!Number.isFinite(until) || until <= this.now())) throw new IntercomError('invalid', 'until: a moment in the future');
    if (until !== undefined && until - this.now() > 60 * 24 * 60 * 60_000) throw new IntercomError('invalid', 'until: at most 60 days ahead');
    const state: ModeState = { mode: mode as ModeId, ...(mode !== 'home' && until !== undefined ? { until } : {}), setBy: actor.userId, setAt: this.now() };
    this.store.setMeta('mode', state);
    this.host.log(`mode ${state.mode}${state.until ? ` until ${new Date(state.until).toISOString()}` : ''} (${actor.userId})`);
    return { mode: state.mode, until: state.until };
  }

  // ---- the state for the interface ----

  intercomState(actor: Actor): Record<string, unknown> {
    const mode = this.currentMode();
    const settings = this.settings();
    return {
      panels: this.store.panels().map((panel) => ({
        id: panel.id,
        name: panel.name,
        cameraId: panel.cameraId,
        enabled: panel.enabled,
        doorbellSensorIds: panel.doorbellSensorIds,
        doors: panel.doors.map((door) => ({ id: door.id, name: door.name, floorplanConnectionId: door.floorplanConnectionId })),
        canOpen: canOpen(actor, panel),
        speakProblem: this.host.port(panel)?.speakProblem(),
        model: panel.driver?.profileId,
      })),
      mode: { ...mode, setBy: this.modeState().setBy, canSet: canSetMode(actor, settings) },
      calls: [...this.live.values()].filter((live) => live.call.state !== 'ended' && !live.quiet).map((live) => this.view(live)),
      instructions: activeInstructions(this.store.instructions(), '', this.now(), this.timeZone()).length,
      agent: { enabled: settings.agent.enabled },
      isAdmin: isAdmin(actor),
    };
  }

  callState(_actor: Actor, callId: string): CallView {
    const live = this.byCall.get(callId);
    if (live) return this.view(live);
    const visit = this.store.queryVisits({ limit: 200 }).visits.find((v) => v.actions.some((a) => a.detail === `call:${callId}`));
    if (!visit) throw new IntercomError('not_found', 'no such call');
    const panel = this.store.panel(visit.panelId);
    return {
      callId,
      visitId: visit.id,
      panelId: visit.panelId,
      panelName: panel?.name ?? '',
      cameraId: panel?.cameraId ?? '',
      state: 'ended',
      startedAt: visit.startedAt,
      answeredBy: visit.answeredBy,
      outcome: visit.outcome,
      recipients: [],
      presses: visit.presses,
      transcript: visit.transcript,
      flags: visit.flags,
      silent: true,
    };
  }

  private view(live: Live): CallView {
    const texts = ownerTexts(this.language()).quickAnswers;
    return {
      callId: live.call.id,
      visitId: live.visit.id,
      panelId: live.panel.id,
      panelName: live.panel.name,
      cameraId: live.panel.cameraId,
      state: live.call.state,
      startedAt: live.call.startedAt,
      answeredBy: live.call.answeredBy,
      outcome: live.call.outcome,
      who: this.who(live),
      recipients: live.call.recipients,
      presses: live.call.presses,
      transcript: live.agent ? [...live.agent.transcript] : live.visit.transcript,
      ...(live.question
        ? { question: { text: live.question.text, options: live.question.options.map((id) => ({ id, label: texts[id as keyof typeof texts] ?? id })) } }
        : {}),
      flags: [...new Set([...live.visit.flags, ...(live.agent?.flags ?? [])])],
      silent: live.route.silent,
    };
  }

  /** Who is at the door, as the owners read it: a known person, the expected visitor, what they said, or a stranger. */
  private who(live: Live): string | undefined {
    const known = knownPerson(this.identifications(live), this.store.people());
    if (known?.strength === 'strong') return known.person.name;
    const matched = live.agent?.matched?.instruction.expect.label;
    if (matched && matched !== '*') return matched;
    const v = live.agent?.visitor;
    return [v?.name, v?.company].filter(Boolean).join(', ') || undefined;
  }

  panelCameraIds(): string[] {
    return this.store
      .panels()
      .filter((panel) => panel.enabled)
      .map((panel) => panel.cameraId);
  }

  // ---- what the cameras see ----

  /** Faces and plates the panel camera saw: they make the identification of the visit now or of the next press. */
  sighting(cameraId: string, faces: { name: string; score: number }[], plates: { plate: string; score: number }[]): void {
    const now = this.now();
    for (const panel of this.store.panels().filter((p) => p.cameraId === cameraId && p.enabled)) {
      const recent = this.seen.get(panel.id) ?? { faces: [], plates: [] };
      recent.faces = [...recent.faces.filter((s) => now - s.at < SEEN_BEFORE_MS), ...faces.map((f) => ({ ...f, at: now }))];
      recent.plates = [...recent.plates.filter((s) => now - s.at < SEEN_BEFORE_MS), ...plates.map((p) => ({ ...p, at: now }))];
      this.seen.set(panel.id, recent);
      const live = this.live.get(panel.id);
      if (live) {
        live.faces.push(...faces.map((f) => ({ ...f, at: now })));
        live.plates.push(...plates.map((p) => ({ ...p, at: now })));
      } else if (plates.length && panel.openByPlate) void this.openByPlate(panel, recent.plates);
    }
  }

  /** A person stands (or no longer stands) in the zone of a panel; a long stay without a ring is a visit (scenarios §7.3). */
  presence(cameraId: string, present: boolean): void {
    for (const panel of this.store.panels().filter((p) => p.cameraId === cameraId && p.presenceZone)) {
      if (!present) this.presentSince.delete(panel.id);
      else if (!this.presentSince.has(panel.id)) this.presentSince.set(panel.id, this.now());
    }
  }

  private identifications(live: Live): Identification[] {
    const people = this.store.people();
    return [...faceIdentifications(live.faces, people), ...plateIdentifications(live.plates, people), ...live.local];
  }

  // ---- a press ----

  /** A press of a panel's button (its own engine or a doorbell sensor). */
  press(panelId: string): void {
    const panel = this.store.panel(panelId);
    if (!panel?.enabled) return;
    const now = this.now();
    const live = this.live.get(panelId);
    // a ring after a code typed at the keypad: the quiet visit of the code ends, the ring is a call of its own
    if (live?.quiet && live.call.state !== 'ended') this.event(live, { type: 'hang_up', outcome: 'declined' });
    else if (live && live.call.state !== 'ended') {
      const result = step(live.call, { type: 'press' }, this.stepContext(live));
      live.call = result.call;
      live.visit.presses = result.call.presses;
      if (result.insistent) {
        if (!live.visit.flags.includes('insistent')) live.visit.flags.push('insistent');
        void this.notify({ title: ownerText(this.language(), 'insistentTitle', { panel: panel.name }), ...this.callLink(live), data: { panelId, callId: live.call.id } });
      }
      return;
    }
    this.startCall(panel, now, 'ring');
  }

  private stepContext(live: Live): StepContext {
    return { now: this.now(), agentEnabled: this.agentEnabled(live), ...(this.everyone ? { everyone: this.everyone } : {}) };
  }

  /** The users of ViON, as the server tells them: who a call to "all" rings, so that all of them declining ends it. */
  setUsers(userIds: string[]): void {
    this.everyone = [...new Set(userIds.filter((id) => typeof id === 'string' && id))];
  }

  private agentEnabled(live: Live): boolean {
    return this.settings().agent.enabled && live.route.agentAfterMs !== null && !this.host.port(live.panel)?.speakProblem() && !live.mute;
  }

  private startCall(panel: Panel, now: number, trigger: Visit['trigger']): Live {
    const settings = this.settings();
    const timeZone = this.timeZone();
    const recent = this.seen.get(panel.id) ?? { faces: [], plates: [] };
    const faces = recent.faces.filter((s) => now - s.at < SEEN_BEFORE_MS);
    const plates = recent.plates.filter((s) => now - s.at < SEEN_BEFORE_MS);
    const people = this.store.people();
    const ids = [...faceIdentifications(faces, people), ...plateIdentifications(plates, people)];
    const known = knownPerson(ids, people);
    const active = activeInstructions(this.store.instructions(), panel.id, now, timeZone);
    const best = matchInstruction(active, ids, {}).best;
    const expected = best?.strength === 'strong';
    const mode = this.currentMode();
    let autoOpenDoorId: string | undefined;
    if (known?.strength === 'strong' && known.person.openWithoutRing) {
      autoOpenDoorId = panel.doors.find((door) => mayOpen({ doorId: door.id, now, timeZone, identifications: ids, people, active, codes: [], heard: {} }).ok)?.id;
    }
    const recipients = panel.callUserIds === 'all' ? [ALL_USERS] : panel.callUserIds;
    let decided = route({
      mode,
      settings: settings.modes[mode.mode],
      recipients,
      known,
      autoOpenDoorId,
      expected,
      forceCall: Boolean(expected && best?.instruction.callOwner === 'yes'),
      silenced: (this.silencedUntil.get(panel.id) ?? 0) > now,
    });
    // "do not call me, answer yourself": an expected visitor the instruction keeps from the owners
    if (expected && best?.instruction.callOwner === 'no' && !decided.autoOpenDoorId && !decided.blocked) {
      decided = {
        ...decided,
        ring: [],
        chime: false,
        agentAfterMs: settings.modes[mode.mode].agentAfterSeconds === null ? null : 0,
        reason: 'an instruction says to answer without calling',
      };
    }

    const visit: Visit = {
      id: randomUUID(),
      panelId: panel.id,
      startedAt: now,
      trigger,
      presses: 1,
      who: { identification: ids, ...(known?.strength === 'strong' ? { personId: known.person.id, name: known.person.name } : {}) },
      transcript: [],
      actions: [],
      flags: [],
      nvrEventIds: [],
      snapshots: [],
      seenBy: [],
    };
    const call = newCall(randomUUID(), visit.id, panel.id, decided.ring, now);
    visit.actions.push({ at: now, kind: 'notify', detail: `call:${call.id}`, by: 'intercom' });
    const live: Live = { call, visit, panel, route: decided, timers: [], ownerQueue: [], faces, plates, local: [], codeTries: 0, spoke: false, usedLlm: false };
    this.live.set(panel.id, live);
    this.byCall.set(call.id, live);
    this.store.saveVisit(visit);
    this.host.log(`${panel.name}: a ${trigger}, ${decided.reason}`);
    void this.begin(live);
    return live;
  }

  /** What follows a press: the snapshot, the recorder, then the ring, the rule's opening, or the agent. */
  private async begin(live: Live): Promise<void> {
    const { panel, route: decided } = live;
    const port = this.host.port(panel);
    this.record(live);
    const snapshot = port ? await this.withTimeout(port.snapshot(), 800).catch(() => undefined) : undefined;
    if (snapshot) void this.keepSnapshot(live, snapshot);
    if (live.call.state === 'ended') return;

    if (decided.blocked) {
      const person = decided.blocked;
      live.visit.flags.push('blocked');
      const severity = person.blockedSeverity === 'critical' ? Severity.Critical : Severity.Info;
      void this.notify({
        title: ownerText(this.language(), 'blockedTitle', { panel: panel.name, name: person.name }),
        severity,
        silent: person.blockedSeverity === 'quiet',
        thumbnail: snapshot,
        ...this.callLink(live),
      });
      this.event(live, { type: 'to_agent' });
      return;
    }
    if (decided.autoOpenDoorId) {
      const door = panel.doors.find((d) => d.id === decided.autoOpenDoorId);
      const known = knownPerson(this.identifications(live), this.store.people());
      if (door && known) {
        const identification = this.identifications(live).find((id) => id.personId === known.person.id && id.strength === 'strong');
        await this.sayOnce(panel, agentTexts(this.language()).openName.replace('{name}', known.person.name));
        await this.openDoor(live.panel, door, `rule:${known.person.id}`, live, identification);
        this.event(live, { type: 'auto_open' });
        return;
      }
    }
    if (decided.ring.length) {
      const order = panel.ringMode === 'order' && decided.ring.length > 1 && !decided.ring.includes(ALL_USERS);
      void this.publishCall(live, order ? [decided.ring[0]] : decided.ring, snapshot);
      if (order) {
        this.timer(live, panel.orderFirstSeconds * 1000, () => {
          if (live.call.state === 'ringing') void this.publishCall(live, decided.ring, snapshot);
        });
      }
      if (decided.chime) {
        const who = this.who(live);
        const text = who ? `${panel.name}: ${who}` : ownerText(this.language(), 'ringTitle', { panel: panel.name });
        void this.host.announce(text, this.panelCameraIds()).catch((error: Error) => this.host.warn(`announce: ${error.message}`));
      }
      this.timer(live, decided.agentAfterMs ?? RING_MAX_MS, () => this.event(live, { type: 'ring_timeout' }));
    } else this.event(live, { type: 'ring_timeout' });
  }

  private callLink(live: Live): { deepLink: string; tag: string } {
    return { deepLink: `/intercom/call/${live.call.id}`, tag: `intercom:${live.call.id}` };
  }

  private async publishCall(live: Live, recipients: string[], snapshot: Uint8Array | undefined): Promise<void> {
    const t = (key: string, values?: Record<string, string | undefined>) => ownerText(this.language(), key, values);
    const who = this.who(live);
    await this.notify({
      title: t('ringTitle', { panel: live.panel.name }),
      body: who ?? t('ringStranger'),
      severity: Severity.Warn,
      silent: live.route.silent,
      thumbnail: snapshot,
      ...this.callLink(live),
      data: {
        kind: 'intercom.call',
        callId: live.call.id,
        visitId: live.visit.id,
        panelId: live.panel.id,
        panelName: live.panel.name,
        cameraId: live.panel.cameraId,
        recipients: recipients.includes(ALL_USERS) ? '' : recipients.join(','),
        ...(who ? { who } : {}),
        ...(live.route.silent ? { silent: '1' } : {}),
        deepLink: `/intercom/call/${live.call.id}`,
      },
    });
  }

  private async publishUpdate(live: Live): Promise<void> {
    const t = (key: string, values?: Record<string, string | undefined>) => ownerText(this.language(), key, values);
    const call = live.call;
    const answeredBy = this.userName(call.answeredBy);
    const title =
      call.state === 'answered'
        ? answeredBy
          ? t('answeredBy', { user: answeredBy })
          : t('answeredBySomeone')
        : call.state === 'agent'
          ? t('agentTitle', { panel: live.panel.name })
          : call.outcome === 'missed'
            ? t('missedTitle', { panel: live.panel.name })
            : t('ringTitle', { panel: live.panel.name });
    await this.notify({
      title,
      silent: true,
      ...this.callLink(live),
      data: {
        kind: 'intercom.call.update',
        callId: call.id,
        panelId: live.panel.id,
        state: call.state,
        recipients: call.recipients.includes(ALL_USERS) ? '' : call.recipients.join(','),
        ...(call.answeredBy ? { by: call.answeredBy } : {}),
        ...(call.outcome ? { outcome: call.outcome } : {}),
      },
    });
  }

  private async notify(notification: Notification): Promise<void> {
    try {
      await this.host.publish(notification);
    } catch (error) {
      this.host.warn(`notification "${notification.title}": ${(error as Error).message}`);
    }
  }

  private timer(live: Live, ms: number, run: () => void): void {
    live.timers.push(this.host.clock.setTimeout(run, ms));
  }

  private clearTimers(live: Live): void {
    for (const timer of live.timers) this.host.clock.clearTimeout(timer);
    live.timers = [];
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const timer = this.host.clock.setTimeout(() => resolve(undefined), ms);
      promise.then(
        (value) => {
          this.host.clock.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.host.clock.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  // ---- the call's events ----

  private event(live: Live, event: CallEvent): StepResult {
    // "rang and ran": nobody in the picture any more when the agent would answer a call that rang a while
    if (event.type === 'ring_timeout' && live.call.state === 'ringing' && this.now() - live.call.startedAt >= NOBODY_SEEN_MS) {
      if (this.host.port(live.panel)?.personSeen(NOBODY_SEEN_MS) === false) event = { type: 'hang_up', outcome: 'nobody' };
    }
    const result = step(live.call, event, this.stepContext(live));
    if (result.refused) return result;
    live.call = result.call;
    for (const effect of result.effects) {
      if (effect === 'ring_stop') this.clearTimers(live);
      else if (effect === 'agent_start') void this.runAgent(live);
      else if (effect === 'agent_stop') live.conversation?.stop('taken_over');
      else if (!live.quiet) void this.publishUpdate(live);
    }
    if (live.call.state === 'answered') {
      void this.host
        .port(live.panel)
        ?.answered?.()
        .catch(() => undefined);
      this.timer(live, ANSWERED_MAX_MS, () => this.event(live, { type: 'hang_up' }));
    }
    if (live.call.state === 'ended') live.finishing ??= this.finish(live);
    return result;
  }

  /**
   * The household's texts name the user who answered or opened, not their id: the server gives the name with the actor
   * (the assistant does not), and the store keeps it so a restart or an opening through the assistant still has it.
   */
  private remember(actor: Actor): void {
    if (actor.name && this.store.getMeta<string>(`userName:${actor.userId}`) !== actor.name) this.store.setMeta(`userName:${actor.userId}`, actor.name);
  }

  private userName(userId: string | undefined): string | undefined {
    return userId ? this.store.getMeta<string>(`userName:${userId}`) : undefined;
  }

  /**
   * The panel ended its call: a SIP CANCEL or BYE (`final`), or a hook's "call ended". The visitor's side is gone, so
   * ringing stops and the agent stops; a call a person answered in ViON goes on after a hook's "ended" (the panel's
   * own call with its monitors ended, not ViON's).
   */
  panelHungUp(panelId: string, final: boolean): void {
    const live = this.live.get(panelId);
    if (!live || live.call.state === 'ended') return;
    if (live.call.state === 'answered' && !final) return;
    this.event(live, { type: 'hang_up', ...(live.call.state === 'ringing' ? { outcome: 'missed' as const } : {}) });
  }

  /** How a code typed at the panel shows in the visit's actions, in the household's language. */
  private codeAction(kind: 'guest' | 'pin' | 'wrong', label?: string): string {
    const texts = ownerTexts(this.language()).codeAction as Record<string, string>;
    return texts[kind].replace('{label}', label ?? '');
  }

  private liveCall(callId: string): Live {
    const live = this.byCall.get(callId);
    if (!live || live.call.state === 'ended') throw new IntercomError('not_found', 'the call is over');
    return live;
  }

  answerCall(actor: Actor, callId: string): { ok: true; cameraId: string } | { ok: false; taken: string } {
    const live = this.liveCall(callId);
    this.remember(actor); // before the step: it tells the household who answered
    const result = this.event(live, { type: live.call.state === 'agent' ? 'take_over' : 'answer', userId: actor.userId });
    if (result.refused === 'taken') return { ok: false, taken: result.takenBy ?? '' };
    if (result.refused) throw new IntercomError('conflict', `the call cannot be answered: ${result.refused}`);
    live.visit.answeredBy = actor.userId;
    return { ok: true, cameraId: live.panel.cameraId };
  }

  declineCall(actor: Actor, callId: string): CallView {
    const live = this.liveCall(callId);
    this.event(live, { type: 'decline', userId: actor.userId });
    return this.view(live);
  }

  handToAgent(actor: Actor, callId: string): CallView {
    const live = this.liveCall(callId);
    const result = this.event(live, { type: 'to_agent', userId: actor.userId });
    if (result.refused === 'agent_off') throw new IntercomError('unavailable', 'the agent cannot answer at this panel now');
    return this.view(live);
  }

  takeOver(actor: Actor, callId: string): ReturnType<Intercom['answerCall']> {
    return this.answerCall(actor, callId);
  }

  hangUpCall(actor: Actor, callId: string): CallView {
    const live = this.liveCall(callId);
    this.event(live, { type: 'hang_up', userId: actor.userId });
    return this.view(live);
  }

  /**
   * The owner's words for the visitor, said by the agent as typed (or, when `verbatim` is off, retold politely by the
   * model). A ringing call is handed to the agent first, so typed answers work without a voice connection.
   */
  async sayInCall(actor: Actor, callId: string, text: string, verbatim = true): Promise<CallView> {
    const live = this.liveCall(callId);
    const said = text?.trim().slice(0, 300);
    if (!said) throw new IntercomError('invalid', 'text');
    if (live.call.state === 'answered') throw new IntercomError('conflict', 'the call is answered: speak yourself');
    const phrase = verbatim ? said : await this.retell(said);
    if (live.call.state === 'ringing') {
      const result = this.event(live, { type: 'to_agent', userId: actor.userId });
      if (result.refused) throw new IntercomError('unavailable', 'the agent cannot speak at this panel');
    }
    live.question = undefined;
    if (live.conversation) live.conversation.ownerSays(phrase, actor.userId);
    else live.ownerQueue.push({ text: phrase, userId: actor.userId });
    return this.view(live);
  }

  /** A quick answer of the call card: open, leave at the door, call me, no thanks. */
  async quickAnswer(actor: Actor, callId: string, option: string): Promise<CallView> {
    const live = this.liveCall(callId);
    const texts = ownerTexts(this.language()).quickAnswers;
    if (option === 'open') {
      const door = live.panel.doors[0];
      if (!door) throw new IntercomError('invalid', 'the panel has no door');
      await this.openDoorAs(actor, live.panel.id, door.id);
      // the door is open: a call that is answered, over, or without an agent to say so is not an error of the opening
      return this.sayInCall(actor, callId, agentTexts(this.language()).open).catch(() => this.view(live));
    }
    if (!(option in texts)) throw new IntercomError('invalid', `option: one of ${Object.keys(texts).join(', ')}`);
    return this.sayInCall(actor, callId, texts[option as keyof typeof texts]);
  }

  private async retell(text: string): Promise<string> {
    const ask = this.host.ask();
    if (!ask) return text;
    const result = await ask({
      system:
        `Retell the owner's words to a visitor at the door as one short polite phrase in ${LANGUAGE_NAMES[this.language()]}, ` +
        'keeping every fact and adding none. Answer JSON {"say": "..."}.',
      prompt: text,
      outputSchema: { type: 'object', properties: { say: { type: 'string' } }, required: ['say'] },
      timeoutMs: 5_000,
    }).catch(() => undefined);
    const say = result?.ok ? (result.json as { say?: unknown } | undefined)?.say : undefined;
    return typeof say === 'string' && say.trim() && say.length <= 300 ? say.trim() : text;
  }

  // ---- the agent ----

  private async runAgent(live: Live): Promise<void> {
    const { panel } = live;
    const port = this.host.port(panel);
    const settings = this.settings();
    const language = this.language();
    if (!port) {
      live.mute = 'the panel camera is not available';
      this.event(live, { type: 'hang_up', outcome: 'missed' });
      return;
    }
    const ask = this.llmFor(live);
    if (settings.agent.describe && this.host.describe) {
      const jpeg = await port.snapshot().catch(() => undefined);
      if (jpeg) live.sees = await this.host.describe(jpeg, language, 5_000).catch(() => undefined);
    }
    if (live.call.state !== 'agent') return;
    const agent = new DoorAgent({
      language,
      timeZone: this.timeZone(),
      clock: this.host.clock,
      panel: { id: panel.id, name: panel.name, place: this.host.place?.(panel) },
      doors: panel.doors.map((door) => ({ id: door.id, name: door.name })),
      people: this.store.people(),
      instructions: () => activeInstructions(this.store.instructions(), panel.id, this.now(), this.timeZone()),
      codes: () => this.panelCodes(panel),
      identifications: () => [...faceIdentifications(live.faces, this.store.people()), ...plateIdentifications(live.plates, this.store.people())],
      sees: live.sees,
      houseRules: settings.agent.houseRules,
      agentName: settings.agent.name,
      greeting: settings.agent.greeting,
      recordNotice: settings.agent.recordNotice,
      ask,
      verifyDigits: (digits) => this.verifyDigits(live, digits),
      maxTurns: settings.agent.maxTurns,
      turnTimeoutMs: 6_000,
      log: (message) => this.host.log(`${panel.name}: ${message}`),
    });
    const conversation = new Conversation(
      agent,
      port.sound(),
      this.host.clock,
      {
        action: (action) => void this.agentAction(live, action),
        said: (_text, result) => {
          live.visit.transcript = [...agent.transcript];
          if (result.status === 'spoken') live.spoke = true;
          else if (!live.spoke) {
            live.mute = result.reason ?? result.status;
            conversation.stop('missed');
          } else this.host.warn(`${panel.name}: a phrase was not said (${result.reason ?? result.status})`);
        },
        voicemail: (samples) => void this.keepVoicemail(live, samples),
      },
      DEFAULT_TIMING,
      agentTexts(language).filler,
    );
    live.agent = agent;
    live.conversation = conversation;
    for (const queued of live.ownerQueue.splice(0)) conversation.ownerSays(queued.text, queued.userId);
    let outcome: Outcome | 'taken_over';
    try {
      outcome = await conversation.run();
    } catch (error) {
      this.host.warn(`${panel.name}: the agent stopped: ${(error as Error).message}`);
      outcome = agent.stop();
    }
    this.mergeAgent(live);
    if (outcome === 'taken_over' || live.call.state !== 'agent') return;
    if (live.mute) {
      live.visit.flags.push('agent_mute');
      void this.notify({ title: ownerText(language, 'agentMuteTitle', { panel: panel.name }), body: live.mute, ...this.callLink(live), adminOnly: true });
      this.event(live, { type: 'hang_up', outcome: 'missed' });
      return;
    }
    this.event(live, { type: 'hang_up', outcome });
  }

  /** The model for this visit, or undefined: the plugin may not ask it, or the visits of the day used it up. */
  private llmFor(live: Live): Ask | undefined {
    const ask = this.host.ask();
    if (!ask) return undefined;
    const limit = this.settings().agent.llmVisitsPerDay;
    const today = localTime(this.now(), this.timeZone()).date;
    const used = this.store.getMeta<{ date: string; count: number }>('llmDay');
    const count = used?.date === today ? used.count : 0;
    if (count >= limit) {
      if (count === limit) {
        this.store.setMeta('llmDay', { date: today, count: count + 1 });
        void this.notify({ title: ownerText(this.language(), 'llmLimitTitle'), adminOnly: true });
      }
      return undefined;
    }
    this.store.setMeta('llmDay', { date: today, count: count + 1 });
    live.usedLlm = true;
    return ask;
  }

  private panelCodes(panel: Panel): GuestCode[] {
    const doors = new Set(panel.doors.map((door) => door.id));
    const now = this.now();
    return this.store.codes().filter((code) => codeUsable(code, now) && code.doors.some((door) => doors.has(door)));
  }

  /** Digits said or typed as a code or a PIN: a guest code of the panel's doors, or a PIN of the family. */
  private async verifyDigits(live: Live, digits: string): Promise<Identification | 'locked' | undefined> {
    const now = this.now();
    if (this.guard.locked(live.panel.id, now)) return 'locked';
    const code = await findCode(this.panelCodes(live.panel), digits, now);
    let identification: Identification | undefined;
    if (code) identification = { kind: 'code', value: code.id, strength: 'strong', at: now };
    else {
      const withPin = this.store.people().filter((p) => p.role !== 'blocked' && p.pinHash);
      const matches = await Promise.all(withPin.map((p) => secretMatches(digits, p.pinHash!.split(':')[1] ?? '', p.pinHash!.split(':')[0] ?? '')));
      const person = withPin.find((_, index) => matches[index]);
      if (person) identification = { kind: 'pin', value: person.name, personId: person.id, strength: 'strong', at: now };
    }
    live.visit.actions.push({
      at: now,
      kind: 'code',
      detail: this.codeAction(identification?.kind === 'code' ? 'guest' : identification ? 'pin' : 'wrong', code?.label),
      by: 'visitor',
    });
    if (identification) {
      this.guard.succeed(live.panel.id);
      live.local.push(identification);
      return identification;
    }
    if (this.guard.fail(live.panel.id, now)) {
      void this.notify({ title: ownerText(this.language(), 'codesLockedTitle', { panel: live.panel.name }), severity: Severity.Warn, ...this.callLink(live) });
    }
    return undefined;
  }

  private async agentAction(live: Live, action: AgentAction): Promise<void> {
    const t = (key: string, values?: Record<string, string | undefined>) => ownerText(this.language(), key, values);
    const now = this.now();
    switch (action.kind) {
      case 'open': {
        const door = live.panel.doors.find((d) => d.id === action.doorId);
        if (door) await this.openDoor(live.panel, door, action.by, live, action.identification);
        return;
      }
      case 'ask_owner':
        live.question = { text: action.question, options: action.options, at: now };
        live.visit.actions.push({ at: now, kind: 'ask_owner', detail: action.question, by: 'agent' });
        await this.notify({
          title: t('askOwnerTitle', { panel: live.panel.name }),
          body: action.question,
          severity: Severity.Warn,
          ...this.callLink(live),
          tag: `intercom-ask:${live.call.id}`,
          data: {
            kind: 'intercom.call.ask',
            callId: live.call.id,
            panelId: live.panel.id,
            recipients: live.call.recipients.includes(ALL_USERS) || !live.call.recipients.length ? '' : live.call.recipients.join(','),
            options: action.options.join(','),
          },
        });
        return;
      case 'emergency':
      case 'threat':
        if (!live.visit.flags.includes(action.kind)) live.visit.flags.push(action.kind);
        await this.notify({
          title: t(action.kind === 'emergency' ? 'emergencyTitle' : 'threatTitle', { panel: live.panel.name }),
          body: `«${action.text}»`,
          severity: Severity.Critical,
          ...this.callLink(live),
          tag: `intercom-${action.kind}:${live.call.id}`,
          data: { panelId: live.panel.id, callId: live.call.id, visitId: live.visit.id },
        });
        return;
      case 'flag':
        if (!live.visit.flags.includes(action.flag)) live.visit.flags.push(action.flag);
        if (action.flag === 'probing' || action.flag === 'manipulation') {
          await this.notify({
            title: t('probingTitle', { panel: live.panel.name }),
            body: `«${action.text}»`,
            ...this.callLink(live),
            tag: `intercom-flag:${live.call.id}`,
          });
        }
        return;
      case 'instruction': {
        live.visit.instructionId = action.instructionId;
        const instruction = this.store.instruction(action.instructionId);
        if (instruction?.once && !instruction.doneAt) this.store.saveInstruction({ ...instruction, doneAt: now });
        return;
      }
      case 'identified': {
        const id = action.identification;
        if (!live.visit.who.identification.some((known) => known.kind === id.kind && known.value === id.value)) live.visit.who.identification.push(id);
        if (id.personId && id.strength === 'strong') {
          live.visit.who.personId = id.personId;
          live.visit.who.name = this.store.person(id.personId)?.name ?? live.visit.who.name;
        }
        return;
      }
      case 'voicemail':
        return;
    }
  }

  private mergeAgent(live: Live): void {
    const agent = live.agent;
    if (!agent) return;
    const v = live.visit;
    v.transcript = [...agent.transcript];
    v.who.name ??= agent.visitor.name;
    v.who.company ??= agent.visitor.company;
    v.who.category ??= agent.visitor.category;
    v.purpose ??= agent.visitor.purpose;
    v.callback ??= agent.visitor.callback;
    for (const flag of agent.flags) if (!v.flags.includes(flag)) v.flags.push(flag);
    if (agent.matched) v.instructionId ??= agent.matched.instruction.id;
  }

  /** One phrase through the panel, outside a conversation ("Masha, opening"). */
  private async sayOnce(panel: Panel, text: string): Promise<void> {
    const port = this.host.port(panel);
    if (!port || port.speakProblem()) return;
    try {
      const phrase = await port.sound().prepare(text);
      await phrase.play();
    } catch (error) {
      this.host.warn(`${panel.name}: "${text}" not said: ${(error as Error).message}`);
    }
  }

  // ---- doors ----

  /** "Open" pressed by a person (the call card, the panel card, the assistant). */
  async openDoorAs(actor: Actor, panelId: string, doorId: string): Promise<DoorResult> {
    const panel = this.store.panel(panelId);
    if (!panel) throw new IntercomError('not_found', 'no such panel');
    const door = panel.doors.find((d) => d.id === doorId || d.name.toLowerCase() === doorId.toLowerCase());
    if (!door) throw new IntercomError('not_found', 'no such door');
    if (!canOpen(actor, panel)) throw new IntercomError('forbidden', `you may not open the doors of ${panel.name}`);
    this.remember(actor);
    return this.openDoor(panel, door, actor.userId, this.live.get(panel.id));
  }

  /** The plugin's own lock of a panel door was set to "unlocked" (an automation, HomeKit, the floor plan). */
  async openFromSensor(panelId: string, doorId: string): Promise<DoorResult> {
    const panel = this.store.panel(panelId);
    const door = panel?.doors.find((d) => d.id === doorId);
    if (!panel || !door) return { result: 'failed', error: 'no such door' };
    return this.openDoor(panel, door, 'sensor', this.live.get(panel.id));
  }

  /**
   * Opens through the door's way, logs it with who and by what, and tells the household. A rule's or an instruction's
   * opening reaches here only after `mayOpen` said yes; a code that opened counts one use.
   */
  private async openDoor(panel: Panel, door: PanelDoor, by: string, live?: Live, identification?: Identification): Promise<DoorResult> {
    const port = this.host.port(panel);
    let outcome: DoorResult;
    try {
      outcome = port ? await port.open(door) : { result: 'failed', error: 'the panel is not available' };
    } catch (error) {
      outcome = { result: 'failed', error: (error as Error).message };
    }
    const now = this.now();
    this.store.logDoor({ at: now, panelId: panel.id, doorId: door.id, visitId: live?.visit.id, by, identification, result: outcome.result, error: outcome.error });
    if (by.startsWith('code:') && outcome.result !== 'failed') {
      const code = this.store.code(by.slice(5));
      if (code) this.store.saveCode({ ...code, uses: code.uses + 1 });
    }
    const t = ownerTexts(this.language());
    const kind = by.startsWith('rule:') ? 'rule' : by.startsWith('code:') ? 'code' : by.startsWith('instruction:') ? 'instruction' : 'user';
    if (live) {
      live.visit.actions.push({ at: now, kind: 'open', detail: door.name, result: outcome.result, by });
      if (outcome.result !== 'failed' && live.call.state !== 'ended') live.visit.outcome = 'opened';
      this.store.saveVisit(live.visit);
    }
    const who = (live && this.who(live)) ?? (identification?.personId ? this.store.person(identification.personId)?.name : undefined) ?? '';
    const name = kind === 'user' ? this.userName(by) : undefined;
    const how = by === 'sensor' ? '' : kind === 'user' ? (name ? t.how.user.replace('{user}', name) : t.how.someone) : t.how[kind];
    await this.notify({
      title: ownerText(this.language(), 'openedTitle', { panel: panel.name, door: door.name }),
      body: [who, how, t.how[outcome.result]].filter(Boolean).join(', '),
      severity: outcome.result === 'failed' ? Severity.Warn : Severity.Info,
      silent: kind !== 'instruction' && outcome.result !== 'failed',
      tag: `intercom-door:${panel.id}:${door.id}`,
      deepLink: live ? `/intercom/visits/${live.visit.id}` : '/intercom',
      data: { panelId: panel.id, doorId: door.id, result: outcome.result },
    });
    this.host.log(`${panel.name}: ${door.name} ${outcome.result} (${by})${outcome.error ? `: ${outcome.error}` : ''}`);
    return outcome;
  }

  /** A gate whose camera read a plate of the directory, with access now: it opens without a ring (ТЗ 8.3). */
  private async openByPlate(panel: Panel, plates: PlateSighting[]): Promise<void> {
    const now = this.now();
    const people = this.store.people();
    const ids = plateIdentifications(plates, people).filter((id) => id.strength === 'strong' && id.personId);
    for (const id of ids) {
      if (now - (this.plateOpened.get(id.value) ?? 0) < PLATE_AGAIN_MS) continue;
      const active = activeInstructions(this.store.instructions(), panel.id, now, this.timeZone());
      const door = panel.doors.find((d) => mayOpen({ doorId: d.id, now, timeZone: this.timeZone(), identifications: [id], people, active, codes: [], heard: {} }).ok);
      if (!door) continue;
      this.plateOpened.set(id.value, now);
      const person = people.find((p) => p.id === id.personId);
      const visit: Visit = {
        id: randomUUID(),
        panelId: panel.id,
        startedAt: now,
        endedAt: now,
        trigger: 'plate',
        presses: 0,
        outcome: 'opened',
        who: { identification: [id], personId: person?.id, name: person?.name },
        title: ownerText(this.language(), 'plateTitle', { panel: panel.name, who: `${id.value}${person ? ` (${person.name})` : ''}` }),
        transcript: [],
        actions: [],
        flags: [],
        nvrEventIds: [],
        snapshots: [],
        seenBy: [],
      };
      this.store.saveVisit(visit);
      const result = await this.openDoor(panel, door, `rule:${id.personId}`, undefined, id);
      visit.actions.push({ at: now, kind: 'open', detail: door.name, result: result.result, by: `rule:${id.personId}` });
      this.store.saveVisit(visit);
      return;
    }
  }

  // ---- the end of a visit ----

  private async finish(live: Live): Promise<void> {
    const { panel, call, visit } = live;
    this.clearTimers(live);
    this.host.clock.clearTimeout(live.recordTimer);
    live.conversation?.stop(call.outcome ?? 'agent');
    this.live.delete(panel.id);
    this.mergeAgent(live);
    const now = this.now();
    visit.endedAt = now;
    visit.outcome = visit.outcome === 'opened' && call.outcome !== 'answered' ? 'opened' : call.outcome;
    visit.answeredBy = call.answeredBy;
    visit.presses = live.quiet ? 0 : call.presses;
    // the panel was not in a call for a code typed at its keypad
    if (!live.quiet)
      void this.host
        .port(panel)
        ?.hangUp?.()
        .catch(() => undefined);

    if (call.outcome === 'nobody') {
      const recent = [...(this.nobodyAt.get(panel.id) ?? []).filter((at) => now - at < NOBODY_WINDOW_MS), now];
      this.nobodyAt.set(panel.id, recent);
      if (recent.length >= NOBODY_STREAK && (this.silencedUntil.get(panel.id) ?? 0) <= now) {
        this.silencedUntil.set(panel.id, now + SILENCE_MS);
        this.nobodyAt.set(panel.id, []);
        void this.notify({ title: ownerText(this.language(), 'nobodyStreakTitle', { panel: panel.name }), tag: `intercom-nobody:${panel.id}` });
      }
    }

    const summary = await summarizeVisit(live.usedLlm ? this.host.ask() : undefined, {
      language: this.language(),
      panel: panel.name,
      transcript: visit.transcript,
      visitor: { name: visit.who.name, company: visit.who.company, category: visit.who.category, purpose: visit.purpose, callback: visit.callback },
      messages: live.agent?.messages ?? [],
      outcome: visit.outcome ?? 'missed',
      answeredBy: visit.answeredBy ? (this.userName(visit.answeredBy) ?? '') : undefined,
      voicemail: Boolean(visit.voiceMessage),
    });
    visit.title = live.quiet ? this.codeVisitTitle(live) : summary.title;
    visit.summary = summary.summary;
    visit.who.category ??= summary.category;
    visit.who.company ??= summary.company;
    visit.purpose ??= summary.purpose;
    visit.messageForOwner = summary.messageForOwner;
    this.store.saveVisit(visit);
    this.byCall.delete(call.id);
    await this.tellOwners(live, summary.needsAction);
    await this.linkRecording(live);
    this.timerFree(2 * 60_000, () => void this.linkRecording(live));
  }

  private timerFree(ms: number, run: () => void): void {
    this.host.clock.setTimeout(run, ms);
  }

  /** The owners learn how the visit went (ТЗ 6.8): what was done, what to pass on, or a missed call. */
  private async tellOwners(live: Live, needsAction: boolean): Promise<void> {
    const { visit, panel } = live;
    const t = (key: string, values?: Record<string, string | undefined>) => ownerText(this.language(), key, values);
    const instruction = visit.instructionId ? this.store.instruction(visit.instructionId) : undefined;
    const minor = visit.outcome === 'nobody' || visit.flags.includes('sales');
    if (visit.outcome === 'answered' && !needsAction) return;
    if (minor && !this.settings().notifyMinor) return;
    // "do not notify": the result goes only into the assistant's thread, and as a notification when it cannot
    const posted = instruction ? await this.postResult(instruction, visit, panel) : false;
    if (instruction?.notify === 'none' && !needsAction && (posted || !instruction.threadId)) return;
    // a code that opened at the keypad: the door's own notice ("opened — by a code") says it all
    if (live.quiet && visit.outcome === 'opened') return;
    const thumbnail = await this.firstSnapshot(visit);
    const title = visit.outcome === 'missed' ? t('missedTitle', { panel: panel.name }) : t('visitTitle', { panel: panel.name, title: visit.title });
    const body = [visit.summary, visit.messageForOwner && !visit.summary?.includes(visit.messageForOwner) ? visit.messageForOwner : undefined].filter(Boolean).join(' ');
    await this.notify({
      title,
      body,
      severity: instruction ? (NOTIFY_SEVERITY[instruction.notify] ?? Severity.Info) : Severity.Info,
      silent: instruction?.notify === 'quiet' || instruction?.notify === 'none',
      thumbnail,
      tag: `intercom-visit:${visit.id}`,
      deepLink: `/intercom/visits/${visit.id}`,
      data: { visitId: visit.id, panelId: panel.id, cameraId: panel.cameraId },
    });
  }

  /** The result of an instruction in the assistant's thread it was made in (ТЗ 5.5). */
  private async postResult(instruction: Instruction, visit: Visit, panel: Panel): Promise<boolean> {
    if (!instruction.threadId || !this.host.postToThread) return false;
    const time = formatClock(visit.startedAt, this.timeZone());
    const text = `${panel.name}, ${time}: ${visit.title ?? ''}. ${visit.summary ?? ''}`.trim();
    return this.host.postToThread(instruction.threadId, instruction.createdBy, text, visit.id).catch(() => false);
  }

  private async linkRecording(live: Live): Promise<void> {
    const nvr = await this.host.nvr().catch(() => undefined);
    if (!nvr) return;
    const visit = live.visit;
    try {
      const events = await nvr.events(live.panel.cameraId, visit.startedAt - 10_000, (visit.endedAt ?? this.now()) + 10_000);
      events.sort((a, b) => Number(b.triggers.includes('doorbell')) - Number(a.triggers.includes('doorbell')));
      const ids = events.map((e) => e.id).slice(0, 10);
      const fresh = ids.filter((id) => !visit.nvrEventIds.includes(id));
      if (!fresh.length) return;
      visit.nvrEventIds = [...visit.nvrEventIds, ...fresh];
      if (visit.flags.includes('threat') || visit.flags.includes('emergency')) for (const id of fresh) await nvr.favorite(id).catch(() => undefined);
      if (this.store.visit(visit.id)) this.store.saveVisit(visit);
    } catch (error) {
      this.host.warn(`${live.panel.name}: recordings of the visit: ${(error as Error).message}`);
    }
  }

  /** The recorder writes the panel camera through the visit (a camera that records continuously is left as it is). */
  private record(live: Live): void {
    const ended = () => live.call.state === 'ended';
    const ask = async () => {
      const nvr = await this.host.nvr().catch(() => undefined);
      if (!nvr || ended()) return;
      await nvr.startRecording(live.panel.cameraId, RECORD_MINUTES).catch((error: Error) => {
        if (!live.visit.flags.includes('no_video')) {
          live.visit.flags.push('no_video');
          live.visit.actions.push({ at: this.now(), kind: 'record', detail: error.message, by: 'intercom' });
        }
      });
      // its own timer: the end of ringing clears the ringing's timers, the recording goes on for the whole visit
      if (!ended()) live.recordTimer = this.host.clock.setTimeout(() => void ask(), RECORD_EVERY_MS);
    };
    void ask();
  }

  // ---- files of visits ----

  private visitDir(visitId: string): string {
    return join(this.host.dataDir, 'visits', visitId.replace(/[^\w-]/g, '_'));
  }

  private async keepSnapshot(live: Live, jpeg: Uint8Array): Promise<void> {
    if (live.visit.snapshots.length >= MAX_SNAPSHOTS) return;
    const name = `${live.visit.snapshots.length + 1}.jpg`;
    live.visit.snapshots.push(name);
    try {
      await mkdir(this.visitDir(live.visit.id), { recursive: true });
      await writeFile(join(this.visitDir(live.visit.id), name), jpeg);
      if (this.store.visit(live.visit.id)) this.store.saveVisit(live.visit);
    } catch (error) {
      live.visit.snapshots = live.visit.snapshots.filter((s) => s !== name);
      this.host.warn(`snapshot of the visit: ${(error as Error).message}`);
    }
  }

  private async keepVoicemail(live: Live, samples: Float32Array): Promise<void> {
    if (!samples.length) return;
    try {
      await mkdir(this.visitDir(live.visit.id), { recursive: true });
      await this.host.saveVoicemail(samples, join(this.visitDir(live.visit.id), 'voicemail.ogg'));
      live.visit.voiceMessage = 'voicemail.ogg';
      if (this.store.visit(live.visit.id)) this.store.saveVisit(live.visit);
    } catch (error) {
      this.host.warn(`voice message: ${(error as Error).message}`);
    }
  }

  private async firstSnapshot(visit: Visit): Promise<Uint8Array | undefined> {
    const name = visit.snapshots[0];
    if (!name) return undefined;
    const { readFile } = await import('node:fs/promises');
    return readFile(join(this.visitDir(visit.id), name)).catch(() => undefined);
  }

  /** A file of a visit (a snapshot or the voice message), for the server to serve. */
  async visitFile(_actor: Actor, visitId: string, name: string): Promise<{ data: Uint8Array; mimeType: string }> {
    const visit = this.store.visit(visitId);
    if (!visit) throw new IntercomError('not_found', 'no such visit');
    const known = [...visit.snapshots, ...(visit.voiceMessage ? [visit.voiceMessage] : [])];
    if (!known.includes(name)) throw new IntercomError('not_found', 'no such file');
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(join(this.visitDir(visitId), name)).catch(() => undefined);
    if (!data) throw new IntercomError('not_found', 'the file is gone');
    return { data: new Uint8Array(data), mimeType: name.endsWith('.ogg') ? 'audio/ogg' : 'image/jpeg' };
  }

  // ---- the archive ----

  visits(_actor: Actor, query: VisitQuery): VisitPage {
    return this.store.queryVisits({ ...query, limit: Math.min(Math.max(query.limit ?? 50, 1), 200) });
  }

  visit(_actor: Actor, id: string): Visit {
    const visit = this.store.visit(id);
    if (!visit) throw new IntercomError('not_found', 'no such visit');
    return visit;
  }

  markVisitSeen(actor: Actor, id: string): void {
    const visit = this.store.visit(id);
    if (!visit) throw new IntercomError('not_found', 'no such visit');
    if (!visit.seenBy.includes(actor.userId)) this.store.saveVisit({ ...visit, seenBy: [...visit.seenBy, actor.userId] });
  }

  async deleteVisit(actor: Actor, id: string): Promise<void> {
    needAdmin(actor);
    if (!this.store.deleteVisit(id)) throw new IntercomError('not_found', 'no such visit');
    await rm(this.visitDir(id), { recursive: true, force: true });
  }

  /** "This is Masha": the person of a visit, by the owner. */
  setVisitPerson(actor: Actor, visitId: string, personId: string): Visit {
    needAdmin(actor);
    const visit = this.visit(actor, visitId);
    const person = this.store.person(personId);
    if (!person) throw new IntercomError('not_found', 'no such person');
    const next = { ...visit, who: { ...visit.who, personId: person.id, name: person.name } };
    this.store.saveVisit(next);
    return next;
  }

  doorLog(actor: Actor, q: { panelId?: string; from?: number; to?: number; limit?: number }): ReturnType<Store['doorLog']> {
    needAdmin(actor);
    return this.store.doorLog(q);
  }

  companies(): string[] {
    return this.store.companies();
  }

  // ---- instructions ----

  instructions(actor: Actor, all = false): Instruction[] {
    const mine = (i: Instruction) => i.createdBy === actor.userId || isAdmin(actor);
    const now = this.now();
    return this.store
      .instructions()
      .filter(mine)
      .filter((i) => all || (!i.cancelledAt && !(i.once && i.doneAt) && !instructionOver(i.when, now)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private instructionWorld(actor: Actor) {
    const now = this.now();
    return {
      now,
      timeZone: this.timeZone(),
      panels: this.store.panels(),
      people: this.store.people(),
      activeCount: this.store.instructions().filter((i) => !i.cancelledAt && !(i.once && i.doneAt) && !instructionOver(i.when, now)).length,
      mayOpen: (panel: Panel) => canOpen(actor, panel),
    };
  }

  /**
   * A new instruction. With `guestCode` a code is made for its window and doors, and its digits are given back once,
   * here, to pass on to the guest; they are never stored or shown again.
   */
  async addInstruction(
    actor: Actor,
    input: Record<string, unknown>,
    threadId?: string,
  ): Promise<{ instruction: Instruction; warnings: string[]; code?: { digits: string; text: string } }> {
    const checked = checkInstruction(input ?? {}, actor.userId, this.instructionWorld(actor));
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    const instruction = { ...checked.value, ...(threadId ? { threadId } : {}) };
    let code: { digits: string; text: string } | undefined;
    if (input.guestCode === true) {
      // a code opens only what its author may open (checkInstruction checked `open`; the main doors are checked here)
      const doors = instruction.open?.length
        ? instruction.open
        : this.store
            .panels()
            .filter((p) => (instruction.panels === 'all' || instruction.panels.includes(p.id)) && canOpen(actor, p))
            .flatMap((p) => p.doors.slice(0, 1).map((d) => d.id));
      if (!doors.length) throw new IntercomError('forbidden', 'a guest code needs a door you may open');
      const window = instruction.when.kind === 'window' ? instruction.when : { from: this.now(), to: instruction.when.until ?? this.now() + 7 * 24 * 60 * 60_000 };
      const made = await this.makeCode(
        actor,
        { label: instruction.expect.label, doors, from: window.from, to: window.to, maxUses: instruction.once ? 1 : 20 },
        instruction.id,
      );
      instruction.expect.guestCodeId = made.code.id;
      code = { digits: made.digits, text: made.text };
    }
    this.store.saveInstruction(instruction);
    return { instruction, warnings: checked.warnings, ...(code ? { code } : {}) };
  }

  updateInstruction(actor: Actor, id: string, input: Record<string, unknown>): { instruction: Instruction; warnings: string[] } {
    const previous = this.store.instruction(id);
    if (!previous || (previous.createdBy !== actor.userId && !isAdmin(actor))) throw new IntercomError('not_found', 'no such instruction');
    const checked = checkInstruction(input ?? {}, actor.userId, { ...this.instructionWorld(actor), activeCount: 0 }, previous);
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    this.store.saveInstruction(checked.value);
    return { instruction: checked.value, warnings: checked.warnings };
  }

  cancelInstruction(actor: Actor, id: string): Instruction {
    const instruction = this.store.instruction(id);
    if (!instruction || (instruction.createdBy !== actor.userId && !isAdmin(actor))) throw new IntercomError('not_found', 'no such instruction');
    const cancelled = { ...instruction, cancelledAt: this.now() };
    this.store.saveInstruction(cancelled);
    if (instruction.expect.guestCodeId) {
      const code = this.store.code(instruction.expect.guestCodeId);
      if (code && !code.revokedAt) this.store.saveCode({ ...code, revokedAt: this.now() });
    }
    return cancelled;
  }

  // ---- people ----

  /** Names of the people, for filters of the archive: any user may filter by them. */
  peopleNames(): { id: string; name: string }[] {
    return this.store.people().map((person) => ({ id: person.id, name: person.name }));
  }

  people(actor: Actor): Person[] {
    needAdmin(actor);
    return this.store.people().map((person) => ({ ...person, ...(person.pinHash ? { pinHash: 'set' } : {}) }));
  }

  setPerson(actor: Actor, input: Record<string, unknown>): { person: Person; warnings: string[] } {
    needAdmin(actor);
    const previous = typeof input.id === 'string' ? this.store.person(input.id) : undefined;
    if (typeof input.id === 'string' && !previous) throw new IntercomError('not_found', 'no such person');
    const checked = checkPerson(input ?? {}, this.store.panels(), previous);
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    this.store.savePerson(checked.value);
    return { person: { ...checked.value, ...(checked.value.pinHash ? { pinHash: 'set' } : {}) }, warnings: checked.warnings };
  }

  deletePerson(actor: Actor, id: string): void {
    needAdmin(actor);
    if (!this.store.deletePerson(id)) throw new IntercomError('not_found', 'no such person');
  }

  // ---- guest codes ----

  guestCodes(actor: Actor): Omit<GuestCode, 'hash' | 'salt'>[] {
    const panels = this.store.panels();
    const mayOpenDoor = (doorId: string) => panels.some((p) => p.doors.some((d) => d.id === doorId) && canOpen(actor, p));
    return this.store
      .codes()
      .filter((code) => isAdmin(actor) || code.createdBy === actor.userId || code.doors.some(mayOpenDoor))
      .map(({ hash: _hash, salt: _salt, ...rest }) => rest);
  }

  async createGuestCode(actor: Actor, input: Record<string, unknown>): Promise<{ code: Omit<GuestCode, 'hash' | 'salt'>; digits: string; text: string }> {
    const checked = checkCodeRequest(input ?? {}, this.store.panels(), this.now(), this.timeZone(), (panel) => canOpen(actor, panel));
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    const made = await this.makeCode(actor, checked.value);
    const { hash: _hash, salt: _salt, ...code } = made.code;
    return { code, digits: made.digits, text: made.text };
  }

  private async makeCode(
    actor: Actor,
    request: { label: string; doors: string[]; from: number; to: number; maxUses: number },
    instructionId?: string,
  ): Promise<{ code: GuestCode; digits: string; text: string }> {
    const usable = this.store.codes().filter((c) => codeUsable(c, this.now()));
    let digits = newCode();
    // a new code is never one that already opens something
    for (let i = 0; i < 20 && (await findCode(usable, digits, this.now())); i++) digits = newCode();
    const { hash, salt } = hashSecret(digits);
    const code: GuestCode = {
      id: randomUUID(),
      label: request.label,
      hash,
      salt,
      doors: request.doors,
      from: request.from,
      to: request.to,
      maxUses: request.maxUses,
      uses: 0,
      createdBy: actor.userId,
      createdAt: this.now(),
      ...(instructionId ? { instructionId } : {}),
    };
    this.store.saveCode(code);
    const names = this.store
      .panels()
      .flatMap((p) => p.doors)
      .filter((d) => request.doors.includes(d.id))
      .map((d) => d.name);
    const moment = (ms: number) => `${localTime(ms, this.timeZone()).date.slice(5).split('-').reverse().join('.')} ${formatClock(ms, this.timeZone())}`;
    const spaced = `${digits.slice(0, 3)} ${digits.slice(3)}`;
    const text = ownerText(this.language(), 'codeText', { doors: names.join(', '), code: spaced, from: moment(request.from), to: moment(request.to) });
    return { code, digits, text };
  }

  revokeGuestCode(actor: Actor, id: string): void {
    const code = this.store.code(id);
    if (!code || !this.guestCodes(actor).some((c) => c.id === id)) throw new IntercomError('not_found', 'no such code');
    this.store.saveCode({ ...code, revokedAt: this.now() });
  }

  // ---- panels ----

  panels(actor: Actor): Panel[] {
    needAdmin(actor);
    return this.store.panels();
  }

  /**
   * A panel saved. A driver's password is kept apart (meta `secret:<panel>`), never in the panel, answers or logs. A
   * panel whose model takes events by calling ViON gets a hook token: its address is given back once.
   */
  savePanel(actor: Actor, input: Record<string, unknown>): { panel: Panel; warnings: string[]; hookPath?: string } {
    needAdmin(actor);
    const previous = typeof input.id === 'string' ? this.store.panel(input.id) : undefined;
    if (typeof input.id === 'string' && !previous) throw new IntercomError('not_found', 'no such panel');
    const world = this.host.panelWorld();
    const checked = checkPanel(input ?? {}, world, previous);
    if (checked.errors) throw new IntercomError('invalid', checked.errors.join('; '));
    const panel = checked.value;
    const password = (input.driver as Record<string, unknown> | undefined)?.password;
    if (typeof password === 'string' && password) this.store.setMeta(`secret:${panel.id}`, password);
    let hookPath: string | undefined;
    const profile = panel.driver ? world.profile(panel.driver.profileId) : undefined;
    if (panel.driver && profile?.events.via === 'hook' && (!panel.driver.hookTokenHash || input.newHookToken === true)) {
      const token = randomUUID().replace(/-/g, '');
      panel.driver.hookTokenHash = tokenHash(token, panel.id);
      hookPath = `/api/intercom/hook/${panel.id}/${token}`;
    }
    this.store.savePanel(panel);
    this.host.panelsChanged();
    return { panel, warnings: checked.warnings, ...(hookPath ? { hookPath } : {}) };
  }

  deletePanel(actor: Actor, id: string): void {
    needAdmin(actor);
    const live = this.live.get(id);
    if (live) this.event(live, { type: 'hang_up', userId: actor.userId });
    if (!this.store.deletePanel(id)) throw new IntercomError('not_found', 'no such panel');
    this.store.setMeta(`secret:${id}`, null);
    this.host.panelsChanged();
  }

  panelPassword(panelId: string): string {
    return this.store.getMeta<string | null>(`secret:${panelId}`) ?? '';
  }

  /** The hook's token is right for the panel (compared by its hash, the token itself is not kept). */
  async hookTokenMatches(panel: Panel, token: string): Promise<boolean> {
    const stored = panel.driver?.hookTokenHash;
    if (!stored || !panel.driver || !/^[a-f0-9]{32}$/.test(token)) return false;
    if (stored.startsWith('sha256:')) return tokenMatches(token, panel.id, stored);
    // a token hashed by scrypt (before 0.1.0 was out): checked in the thread pool, then kept as the fast hash
    if (!(await secretMatches(token, stored, panel.id))) return false;
    const current = this.store.panel(panel.id);
    if (current?.driver) this.store.savePanel({ ...current, driver: { ...current.driver, hookTokenHash: tokenHash(token, panel.id) } });
    return true;
  }

  /**
   * Digits typed on a panel's keypad: a code or a PIN, which opens what it may. Typed during a call, they belong to
   * it; typed with no call, they make a quiet visit that rings nobody (a guest with a code needs no one).
   */
  async panelInput(cameraId: string, digits: string): Promise<boolean> {
    const panel = this.store.panels().find((p) => p.cameraId === cameraId && p.enabled);
    if (!panel || !/^\d{4,8}$/.test(digits)) return false;
    const current = this.live.get(panel.id);
    const live = current && current.call.state !== 'ended' ? current : this.quietVisit(panel, this.now());
    if (live.codeTries >= 3) return false;
    live.codeTries++;
    const id = await this.verifyDigits(live, digits);
    if (!id || id === 'locked') return false;
    const now = this.now();
    const people = this.store.people();
    const active = activeInstructions(this.store.instructions(), panel.id, now, this.timeZone());
    const codes = this.panelCodes(panel);
    for (const door of panel.doors) {
      const decision = mayOpen({ doorId: door.id, now, timeZone: this.timeZone(), identifications: [...this.identifications(live)], people, active, codes, heard: {} });
      if (decision.ok) {
        await this.openDoor(panel, door, decision.by, live, decision.identification);
        this.event(live, { type: live.call.state === 'ringing' ? 'auto_open' : 'hang_up', outcome: 'opened' });
        return true;
      }
    }
    return false;
  }

  /** The visit of a code typed with no call: recorded and kept for the archive, ringing nobody, no agent. */
  private quietVisit(panel: Panel, now: number): Live {
    const visit: Visit = {
      id: randomUUID(),
      panelId: panel.id,
      startedAt: now,
      trigger: 'code',
      presses: 0,
      who: { identification: [] },
      transcript: [],
      actions: [],
      flags: [],
      nvrEventIds: [],
      snapshots: [],
      seenBy: [],
    };
    const call = newCall(randomUUID(), visit.id, panel.id, [], now);
    const route: Route = { ring: [], silent: true, agentAfterMs: null, chime: false, reason: 'a code typed at the keypad' };
    const live: Live = {
      call,
      visit,
      panel,
      route,
      timers: [],
      ownerQueue: [],
      faces: [],
      plates: [],
      local: [],
      codeTries: 0,
      spoke: false,
      usedLlm: false,
      quiet: true,
    };
    this.live.set(panel.id, live);
    this.byCall.set(call.id, live);
    this.store.saveVisit(visit);
    this.record(live);
    void this.host
      .port(panel)
      ?.snapshot()
      .then((jpeg) => (jpeg ? this.keepSnapshot(live, jpeg) : undefined))
      .catch(() => undefined);
    // more tries may follow; with no right code the visit ends as declined
    this.timer(live, QUIET_CODE_MS, () => this.event(live, { type: 'hang_up', outcome: 'declined' }));
    this.host.log(`${panel.name}: a code typed at the keypad`);
    return live;
  }

  private codeVisitTitle(live: Live): string {
    const t = (key: string, values?: Record<string, string | undefined>) => ownerText(this.language(), key, values);
    const id = live.local.find((i) => i.kind === 'code' || i.kind === 'pin');
    if (live.visit.outcome !== 'opened' || !id) return t('codeWrongTitle', { panel: live.panel.name });
    const who = id.kind === 'code' ? this.store.code(id.value)?.label : id.value;
    return t('codeOpenTitle', { panel: live.panel.name, who: who ?? '' });
  }

  // ---- the agent tried in text ----

  /**
   * "Talk to the agent": the owner writes as a visitor and reads the answers. The same agent as at the door, without
   * sound and without acting: nothing opens and nobody is told; the answer says what would have been done.
   */
  async simulate(actor: Actor, sessionId: string, text: string, options: { panelId?: string; personId?: string } = {}): Promise<Record<string, unknown>> {
    needAdmin(actor);
    const now = this.now();
    for (const [key, s] of this.simulations) if (now - s.at > SIMULATION_TTL_MS) this.simulations.delete(key);
    let session = this.simulations.get(sessionId);
    let say: string | undefined;
    let end: Outcome | undefined;
    if (!session || text === '') {
      const panel = (options.panelId ? this.store.panel(options.panelId) : undefined) ?? this.store.panels()[0];
      if (!panel) throw new IntercomError('invalid', 'there is no panel yet');
      const person = options.personId ? this.store.person(options.personId) : undefined;
      const ids: Identification[] = person
        ? [{ kind: 'face', value: person.faceNames[0] ?? person.name, personId: person.id, strength: 'strong', score: 0.9, at: now }]
        : [];
      const settings = this.settings();
      const actions: AgentAction[] = [];
      const agent = new DoorAgent({
        language: this.language(),
        timeZone: this.timeZone(),
        clock: this.host.clock,
        panel: { id: panel.id, name: panel.name, place: this.host.place?.(panel) },
        doors: panel.doors.map((d) => ({ id: d.id, name: d.name })),
        people: this.store.people(),
        instructions: () => activeInstructions(this.store.instructions(), panel.id, this.now(), this.timeZone()),
        codes: () => this.panelCodes(panel),
        identifications: () => ids,
        houseRules: settings.agent.houseRules,
        agentName: settings.agent.name,
        greeting: settings.agent.greeting,
        recordNotice: settings.agent.recordNotice,
        ask: this.host.ask(),
        // a code said in the test is checked, but not counted against the panel
        verifyDigits: async (digits) => {
          const code = await findCode(this.panelCodes(panel), digits, this.now());
          return code ? { kind: 'code', value: code.id, strength: 'strong', at: this.now() } : undefined;
        },
        maxTurns: settings.agent.maxTurns,
        turnTimeoutMs: 15_000,
      });
      session = { agent, at: now, actions };
      this.simulations.set(sessionId, session);
      const reply = await agent.start();
      actions.push(...reply.actions);
      say = reply.say;
      end = reply.end;
      if (text === '') return this.simulationResult(session, say, end, reply.actions);
    }
    session.at = now;
    const reply = await session.agent.heardText(text.slice(0, 500));
    session.actions.push(...reply.actions);
    return this.simulationResult(session, [say, reply.say].filter(Boolean).join(' '), reply.end ?? end, reply.actions);
  }

  private simulationResult(session: Simulation, say: string | undefined, end: Outcome | undefined, actions: AgentAction[]): Record<string, unknown> {
    const agent = session.agent;
    const matched = agent.matched?.instruction;
    return {
      say,
      ended: end ?? (agent.ended ? 'agent' : undefined),
      wouldDo: actions.map((action) => {
        switch (action.kind) {
          case 'open':
            return `open ${action.doorId} (${action.by})`;
          case 'ask_owner':
            return `ask the owners: ${action.question}`;
          case 'instruction':
            return `instruction ${action.instructionId}`;
          case 'identified':
            return `identified by ${action.identification.kind}`;
          case 'voicemail':
            return 'record a voice message';
          default:
            return `${action.kind}: ${'text' in action ? action.text : ''}`;
        }
      }),
      matched: matched ? { id: matched.id, text: matched.text, label: matched.expect.label } : undefined,
      visitor: { ...agent.visitor },
      flags: [...agent.flags],
      transcript: [...agent.transcript],
    };
  }

  // ---- every half a minute ----

  /** The mode's end, presence at the doors, the archive's age. */
  tick(): void {
    const now = this.now();
    const state = this.modeState();
    if (expiredMode(state, now)) {
      this.store.setMeta('mode', { mode: 'home', setAt: now } satisfies ModeState);
      void this.notify({ title: ownerText(this.language(), 'modeBackTitle'), tag: 'intercom-mode' });
    }
    const presenceMs = this.settings().presenceSeconds * 1000;
    for (const [panelId, since] of this.presentSince) {
      if (now - since < presenceMs || this.live.has(panelId) || now - (this.presenceVisitAt.get(panelId) ?? 0) < PRESENCE_AGAIN_MS) continue;
      const panel = this.store.panel(panelId);
      if (!panel?.enabled) continue;
      this.presenceVisitAt.set(panelId, now);
      this.presentSince.delete(panelId);
      void this.presenceVisit(panel, since);
    }
    if (now - this.lastPurge >= 60 * 60_000) {
      this.lastPurge = now;
      void this.purge(now);
    }
  }

  private async presenceVisit(panel: Panel, since: number): Promise<void> {
    const title = ownerText(this.language(), 'presenceTitle', { panel: panel.name });
    const visit: Visit = {
      id: randomUUID(),
      panelId: panel.id,
      startedAt: since,
      endedAt: this.now(),
      trigger: 'presence',
      presses: 0,
      who: { identification: [] },
      title,
      transcript: [],
      actions: [],
      flags: [],
      nvrEventIds: [],
      snapshots: [],
      seenBy: [],
    };
    this.store.saveVisit(visit);
    const jpeg = await this.host
      .port(panel)
      ?.snapshot()
      .catch(() => undefined);
    const live = { visit } as Live;
    if (jpeg) await this.keepSnapshot(live, jpeg);
    const mode = this.currentMode().mode;
    if (mode === 'night' || mode === 'away') {
      await this.notify({
        title,
        thumbnail: jpeg,
        tag: `intercom-visit:${visit.id}`,
        deepLink: `/intercom/visits/${visit.id}`,
        data: { visitId: visit.id, panelId: panel.id },
      });
    }
  }

  private async purge(now: number): Promise<void> {
    const days = this.settings().retentionDays;
    const old = this.store.purgeVisits(now - days * 24 * 60 * 60_000);
    for (const visit of old) await rm(this.visitDir(visit.id), { recursive: true, force: true }).catch(() => undefined);
    const ended = (i: Instruction) =>
      i.cancelledAt ?? (i.once ? i.doneAt : undefined) ?? (instructionOver(i.when, now) ? (i.when.kind === 'window' ? i.when.to : i.when.until) : undefined);
    const removed = this.store.purgeInstructions(ended, now - INSTRUCTIONS_KEPT_MS);
    if (old.length || removed) this.host.log(`archive: ${old.length} visits and ${removed} instructions removed by age`);
  }

  /** The plugin stops: calls in progress end as interrupted, the household's phones stop ringing. */
  async stop(): Promise<void> {
    for (const live of [...this.live.values()]) {
      this.event(live, { type: 'interrupted' });
      await live.finishing?.catch(() => undefined);
    }
  }
}
