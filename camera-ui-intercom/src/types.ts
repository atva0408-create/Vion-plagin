/**
 * What the intercom keeps and decides about: panels and their doors, the people it knows, the instructions the owner
 * gave the door agent, guest codes, visits with their calls, and the mode of the house.
 *
 * Times are milliseconds since the epoch; wall-clock times of a schedule are "HH:MM" in the household's time zone.
 */
import type { Day } from '@vionvision/speech';

// ---- panels ----

export type DoorVia =
  /** a lock sensor: targetState Unsecured, then Secured again after `relockSeconds` (0: the lock does it itself) */
  | { kind: 'lock'; sensorId: string }
  /** a relay: on, and off after `pulseSeconds` */
  | { kind: 'switch'; sensorId: string; pulseSeconds: number }
  /** a command of the panel through its engine (an HTTP request, a DTMF code) */
  | { kind: 'panel'; doorKey: string };

export interface PanelDoor {
  id: string;
  name: string;
  via: DoorVia;
  relockSeconds: number;
  /** the passage of the floor plan this door is */
  floorplanConnectionId?: string;
}

export interface PanelDriver {
  /** model profile of the catalog */
  profileId: string;
  host: string;
  httpPort?: number;
  rtspPort?: number;
  username: string;
  /** sha256 of the token in the hook address (the address itself is shown once) */
  hookTokenHash?: string;
}

export interface Panel {
  id: string;
  name: string;
  cameraId: string;
  driver?: PanelDriver;
  /** where the presses come from: the plugin's own doorbell of a driver panel, or doorbells of other plugins */
  doorbellSensorIds: string[];
  doors: PanelDoor[];
  contactSensorId?: string;
  /** who the panel calls; 'all': everyone who may see the panel's camera */
  callUserIds: string[] | 'all';
  ringMode: 'together' | 'order';
  /** seconds the first of the list rings alone in the 'order' mode */
  orderFirstSeconds: number;
  /** object zone "at the door": a person standing there long enough without ringing is a visit too */
  presenceZone?: string;
  /** users who may open the doors of this panel besides the admins */
  openUserIds: string[];
  /** a gate: a plate of the directory with access opens without a ring (ТЗ 8.3) */
  openByPlate?: boolean;
  enabled: boolean;
}

// ---- who is at the door ----

export type Strength = 'weak' | 'strong';
export type IdentificationKind = 'face' | 'plate' | 'code' | 'pin' | 'said' | 'look';

export interface Identification {
  kind: IdentificationKind;
  /** face name, plate, guest code id, the name the visitor said, what the picture shows */
  value: string;
  personId?: string;
  score?: number;
  strength: Strength;
  at: number;
}

export type Role = 'family' | 'friend' | 'staff' | 'service' | 'blocked' | 'other';

export interface WeekWindow {
  days: Day[];
  from: string;
  to: string;
}

export interface PersonAccess extends WeekWindow {
  doors: string[];
}

export interface Person {
  id: string;
  name: string;
  role: Role;
  child?: boolean;
  /** names of faces in the recorder */
  faceNames: string[];
  /** normalized: upper case, no spaces or dashes */
  plates: string[];
  pinHash?: string;
  access: PersonAccess[];
  openWithoutRing: boolean;
  /** users told "<name> came" */
  notifyOnArrival: string[];
  blockedSeverity?: 'quiet' | 'normal' | 'critical';
  gender?: 'm' | 'f';
  note?: string;
}

// ---- instructions to the door agent ----

export const CATEGORIES = ['delivery', 'food', 'taxi', 'guest', 'family', 'service', 'official', 'sales', 'emergency', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export type InstructionWhen = { kind: 'window'; from: number; to: number } | ({ kind: 'weekly'; until?: number } & WeekWindow);

export interface Instruction {
  id: string;
  createdBy: string;
  createdAt: number;
  /** the assistant's thread it was made in: the result goes there */
  threadId?: string;
  /** as the owner said it */
  text: string;
  panels: string[] | 'all';
  when: InstructionWhen;
  once: boolean;
  expect: {
    /** "курьер Озона", "Маша", "сантехник из УК"; '*' for anyone */
    label: string;
    category?: Category;
    companies?: string[];
    names?: string[];
    personIds?: string[];
    plates?: string[];
    guestCodeId?: string;
  };
  minIdentification: Strength;
  /** what to say once matched */
  say?: string;
  /** said as written, past the LLM (a code, an address, a key) */
  sayVerbatim: boolean;
  /** what to ask the visitor */
  ask?: string[];
  /** doors to open once matched; strong identification unless `openOnWeak` */
  open?: string[];
  /** the owner agreed in the confirmation card that a weak identification opens */
  openOnWeak?: boolean;
  neverOpen?: boolean;
  /** "never open" leaves out the family known by face, plate or PIN */
  exceptFamily?: boolean;
  callOwner: 'no' | 'yes' | 'if_needed';
  notify: 'none' | 'quiet' | 'normal' | 'urgent';
  record: boolean;
  doneAt?: number;
  cancelledAt?: number;
}

export interface GuestCode {
  id: string;
  label: string;
  /** scrypt of the six digits with the salt */
  hash: string;
  salt: string;
  doors: string[];
  from: number;
  to: number;
  maxUses: number;
  uses: number;
  createdBy: string;
  createdAt: number;
  instructionId?: string;
  revokedAt?: number;
}

// ---- the mode of the house ----

export const MODES = ['home', 'away', 'night', 'dnd', 'child'] as const;
export type ModeId = (typeof MODES)[number];

export interface ModeSettings {
  /** seconds of ringing before the agent answers; null: the agent does not answer in this mode */
  agentAfterSeconds: number | null;
  /** who is called in this mode */
  ring: 'all' | 'family_and_expected' | 'silent' | 'none' | 'listed';
  /** users rung in the 'listed' way (the parents when a child is home alone) */
  userIds: string[];
  /** say "a ring at the gate" on the house's speakers */
  chime: boolean;
}

export interface ModeState {
  /** the mode set by hand (or the assistant); 'home' when none */
  mode: ModeId;
  until?: number;
  setBy?: string;
  setAt?: number;
}

// ---- visits and calls ----

export type CallState = 'ringing' | 'agent' | 'answered' | 'ended';
export type Outcome = 'answered' | 'agent' | 'message' | 'opened' | 'missed' | 'declined' | 'nobody' | 'interrupted';

export interface TranscriptLine {
  at: number;
  from: 'visitor' | 'agent' | 'owner';
  text: string;
  userId?: string;
}

export interface VisitAction {
  at: number;
  kind: 'open' | 'notify' | 'ask_owner' | 'say' | 'record' | 'code';
  detail: string;
  /** of an opening: the door confirmed it, the command went without a confirmation, or it failed */
  result?: 'confirmed' | 'sent' | 'failed';
  /** a user id, 'rule:<person>', 'instruction:<id>', 'agent' */
  by: string;
}

export interface Visit {
  id: string;
  panelId: string;
  startedAt: number;
  endedAt?: number;
  trigger: 'ring' | 'presence' | 'plate';
  presses: number;
  outcome?: Outcome;
  answeredBy?: string;
  who: {
    personId?: string;
    name?: string;
    category?: Category;
    company?: string;
    identification: Identification[];
    unknownFaceId?: string;
  };
  purpose?: string;
  title?: string;
  summary?: string;
  messageForOwner?: string;
  callback?: string;
  transcript: TranscriptLine[];
  instructionId?: string;
  actions: VisitAction[];
  flags: string[];
  nvrEventIds: string[];
  snapshots: string[];
  voiceMessage?: string;
  seenBy: string[];
}

export interface DoorLogEntry {
  at: number;
  panelId: string;
  doorId: string;
  visitId?: string;
  by: string;
  identification?: Identification;
  result: 'confirmed' | 'sent' | 'failed';
  error?: string;
}
