/**
 * Settings of VOICE: what the owner sets on the camera (screen time of the children) and on the plugin page (voice,
 * door, notifications). The assistant's tools write the very same values, so the camera drawer and the chat always
 * show one truth; both go through the checks below.
 */
import { DAYS, isClock } from './time.js';

import type { PresenceSource } from './presence.js';
import type { ScreenTimeConfig } from './screenTime.js';
import type { Day, WeeklyInterval } from './time.js';

/** One child at one camera, as stored in the camera settings. */
export interface ScreenTimeValues {
  id?: string;
  enabled?: boolean;
  childName?: string;
  zone?: string;
  /** VOICE's own area of the computer: "x, y, width, height" in percent. */
  area?: string;
  sessionMinutes?: number;
  breakMinutes?: number;
  dailyMinutes?: number;
  schoolFrom?: string;
  schoolTo?: string;
  freeFrom?: string;
  freeTo?: string;
  schoolEvenings?: Day[];
  answerQuestions?: boolean;
  answerOnCall?: boolean;
  breakReminder?: boolean;
  labels?: string[];
  face?: string;
  attribute?: string;
  repeatMinutes?: number;
  maxRepeats?: number;
  minPresenceSeconds?: number;
  gapSeconds?: number;
}

export const SCREEN_TIME_DEFAULTS = {
  enabled: true,
  sessionMinutes: 45,
  breakMinutes: 10,
  dailyMinutes: 0,
  schoolFrom: '21:30',
  schoolTo: '07:30',
  freeFrom: '22:30',
  freeTo: '08:30',
  // the evenings before a school day: Sunday to Thursday; Friday and Saturday nights are free nights
  schoolEvenings: ['sun', 'mon', 'tue', 'wed', 'thu'] as Day[],
  answerQuestions: true,
  // off until a parent turns it on: the microphone of the room stays open the whole time
  answerOnCall: false,
  breakReminder: true,
  labels: ['person'],
  repeatMinutes: 3,
  maxRepeats: 5,
  minPresenceSeconds: 20,
  gapSeconds: 120,
} satisfies ScreenTimeValues;

const LIMITS: Partial<Record<keyof ScreenTimeValues, [number, number]>> = {
  sessionMinutes: [5, 240],
  // longer than the short absence (2 min by default), or no break could ever count
  breakMinutes: [3, 120],
  dailyMinutes: [0, 1440],
  repeatMinutes: [1, 60],
  maxRepeats: [0, 20],
  minPresenceSeconds: [5, 300],
  gapSeconds: [10, 1800],
};

export interface Checked<T> {
  value?: T;
  errors: string[];
}

/** Turns stored or tool-given values into a scenario, with every problem said so that it can be fixed. */
export function checkScreenTime(values: ScreenTimeValues, zones: string[]): Checked<ScreenTimeConfig> {
  const errors: string[] = [];
  const v = { ...SCREEN_TIME_DEFAULTS, ...dropEmpty(values) };
  const name = (v.childName ?? '').trim();
  if (!name) errors.push('childName: the name the child is called by is required');
  // no zone and no area: the whole picture. A zone drawn only for VOICE would limit where the camera detects at all.
  if (v.zone && !zones.includes(v.zone)) errors.push(`zone: "${v.zone}" is not a zone of this camera${zones.length ? ` (${zones.join(', ')})` : ''}`);
  const area = parseArea(v.area);
  if (v.area?.trim() && !area) errors.push('area: four numbers in percent of the picture, "x, y, width, height", e.g. "0, 30, 50, 60", inside the picture');
  if (v.zone && v.area?.trim()) errors.push('zone/area: give the zone of the camera or an area of VOICE, not both');
  for (const [key, [min, max]] of Object.entries(LIMITS) as [keyof ScreenTimeValues, [number, number]][]) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) errors.push(`${key}: a number from ${min} to ${max}`);
  }
  if (!errors.some((e) => e.startsWith('breakMinutes')) && v.gapSeconds >= v.breakMinutes * 60)
    errors.push('gapSeconds: must be shorter than the break, or a break would never count');
  for (const key of ['schoolFrom', 'schoolTo', 'freeFrom', 'freeTo'] as const) {
    if (v[key] !== '' && v[key] !== undefined && !isClock(v[key])) errors.push(`${key}: a time HH:MM, e.g. 21:30, or empty for no bedtime`);
  }
  if (Boolean(v.schoolFrom) !== Boolean(v.schoolTo)) errors.push('schoolFrom/schoolTo: give both times of the school-night bedtime, or neither');
  if (Boolean(v.freeFrom) !== Boolean(v.freeTo)) errors.push('freeFrom/freeTo: give both times of the free-night bedtime, or neither');
  if (!Array.isArray(v.schoolEvenings) || v.schoolEvenings.some((d) => !DAYS.includes(d))) errors.push(`schoolEvenings: days among ${DAYS.join(', ')}`);
  if (!Array.isArray(v.labels) || !v.labels.length) errors.push('labels: at least one label, usually person');
  if (errors.length) return { errors };

  const bedtime: WeeklyInterval[] = [];
  const school = v.schoolEvenings;
  if (v.schoolFrom && v.schoolTo) bedtime.push({ days: school, from: v.schoolFrom, to: v.schoolTo });
  const free = DAYS.filter((d) => !school.includes(d));
  if (v.freeFrom && v.freeTo && free.length) bedtime.push({ days: free, from: v.freeFrom, to: v.freeTo });
  const source: PresenceSource = {
    ...(v.zone ? { zone: v.zone } : {}),
    ...(area ? { area } : {}),
    labels: v.labels,
    ...(v.face?.trim() ? { face: v.face.trim() } : {}),
    ...(v.attribute?.trim() ? { attribute: v.attribute.trim() } : {}),
  };
  return {
    errors,
    value: {
      id: v.id?.trim() ? v.id : slug(name),
      enabled: v.enabled,
      childName: name,
      source,
      sessionMinutes: v.sessionMinutes,
      breakMinutes: v.breakMinutes,
      ...(v.dailyMinutes ? { dailyMinutes: v.dailyMinutes } : {}),
      bedtime,
      repeatMinutes: v.repeatMinutes,
      maxRepeats: v.maxRepeats,
      breakReminder: v.breakReminder,
      answerQuestions: v.answerQuestions,
      answerOnCall: v.answerOnCall,
      minPresenceSeconds: v.minPresenceSeconds,
      gapSeconds: v.gapSeconds,
    },
  };
}

/** "x, y, width, height" in percent of the picture, inside it; undefined when empty or not that. */
export function parseArea(text: string | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!text?.trim()) return undefined;
  const parts = text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return undefined;
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0 || x + width > 100 || y + height > 100) return undefined;
  return { x, y, width, height };
}

function dropEmpty(values: ScreenTimeValues): ScreenTimeValues {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined && value !== null));
}

export function slug(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'child';
}

// ---- plugin settings ----

export interface DoorRuleValues {
  enabled?: boolean;
  doorCameras?: string[];
  speakers?: string[];
  labels?: string[];
  describe?: boolean;
  cooldownSeconds?: number;
  quietFrom?: string;
  quietTo?: string;
}

export interface PersonValues {
  name?: string;
  gender?: 'male' | 'female' | 'neutral';
}

export interface PluginValues {
  timeZone?: string;
  language?: string;
  speed?: number;
  listenSeconds?: number;
  maxPerMinute?: number;
  quietFrom?: string;
  quietTo?: string;
  doorRules?: DoorRuleValues[];
  people?: PersonValues[];
  channelSpeakers?: string[];
  channelRewrite?: string[];
}

export const PLUGIN_DEFAULTS = {
  language: 'ru',
  speed: 1,
  listenSeconds: 10,
  maxPerMinute: 6,
};

export interface DoorRule {
  doorCameras: string[];
  speakers: string[];
  labels: string[];
  describe: boolean;
  cooldownSeconds: number;
  quiet: WeeklyInterval[];
}

export function checkDoorRule(values: DoorRuleValues, cameras: string[], speakers: string[]): Checked<DoorRule> {
  const errors: string[] = [];
  const doors = values.doorCameras ?? [];
  const says = values.speakers ?? [];
  if (!doors.length) errors.push('doorCameras: at least one camera that sees the door');
  for (const id of doors) if (!cameras.includes(id)) errors.push(`doorCameras: unknown camera ${id}`);
  if (!says.length) errors.push('speakers: at least one camera with a speaker');
  for (const id of says) if (!speakers.includes(id)) errors.push(`speakers: camera ${id} cannot speak (no talk channel)`);
  const cooldown = values.cooldownSeconds ?? 120;
  if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 3600) errors.push('cooldownSeconds: a number from 0 to 3600');
  const quiet = quietHours(values.quietFrom, values.quietTo, errors);
  if (errors.length) return { errors };
  return {
    errors,
    value: {
      doorCameras: doors,
      speakers: says,
      labels: values.labels?.length ? values.labels : ['person'],
      describe: values.describe ?? false,
      cooldownSeconds: cooldown,
      quiet,
    },
  };
}

/** Quiet hours as two times every day; empty means none. */
export function quietHours(from: string | undefined, to: string | undefined, errors: string[] = []): WeeklyInterval[] {
  if (!from && !to) return [];
  if (!isClock(from) || !isClock(to)) {
    errors.push('quietFrom/quietTo: two times HH:MM, or both empty');
    return [];
  }
  return [{ days: [...DAYS], from, to }];
}

export const DAY_LABELS: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
