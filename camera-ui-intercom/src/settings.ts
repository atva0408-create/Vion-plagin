/**
 * The settings of the intercom as a whole: the door agent, the modes, the night, who may change the mode, how long
 * visits are kept. They live in the plugin's store and are changed through one check (`checkSettings`), whether the
 * interface, the plugin's settings page or the assistant changes them.
 */
import { LANGUAGES, isClock, validTimeZone } from '@vionvision/speech';

import { DEFAULT_MODE_SETTINGS, DEFAULT_NIGHT } from './modes.js';
import { EVERY_DAY } from './schedule.js';
import { MODES } from './types.js';

import type { Day, Language } from '@vionvision/speech';
import type { ModeId, ModeSettings, WeekWindow } from './types.js';

export interface AgentSettings {
  /** the agent answers when nobody did (the mode says when) */
  enabled: boolean;
  /** the name the agent gives itself; empty: it gives none */
  name?: string;
  /** own greeting; empty: "Hello! The conversation is recorded. How can I help?" */
  greeting?: string;
  /** what any visitor may hear: "parcels go into the box at the gate" */
  houseRules?: string;
  /** the assistant looks at the snapshot before the greeting ("a man in a uniform with a box") */
  describe: boolean;
  /** the greeting says that the conversation is recorded */
  recordNotice: boolean;
  speed: number;
  /** exchanges with the visitor at most */
  maxTurns: number;
  /** visits a day the LLM may talk in; after that the agent speaks from its templates */
  llmVisitsPerDay: number;
}

export interface IntercomSettings {
  /** language of the agent and of the owners' texts; empty: Russian */
  language?: Language;
  /** the household's time zone; empty: the server's */
  timeZone?: string;
  agent: AgentSettings;
  modes: Record<ModeId, ModeSettings>;
  /** when the night mode holds (unless a mode was set by hand) */
  night: WeekWindow[];
  /** users besides the admins who may change the mode */
  modeUserIds: string[];
  /** days a visit is kept with its snapshots and voice message */
  retentionDays: number;
  /** sellers and rings with nobody there: a push too (else the archive only) */
  notifyMinor: boolean;
  /** seconds a person stands in a panel's zone without ringing before it is a visit */
  presenceSeconds: number;
  /** the UDP port where panels that call over SIP reach ViON (only from the home network) */
  sipPort: number;
}

export const DEFAULT_AGENT: AgentSettings = {
  enabled: true,
  describe: false,
  recordNotice: true,
  speed: 1,
  maxTurns: 8,
  llmVisitsPerDay: 50,
};

export const DEFAULT_SETTINGS: IntercomSettings = {
  agent: DEFAULT_AGENT,
  modes: DEFAULT_MODE_SETTINGS,
  night: [DEFAULT_NIGHT],
  modeUserIds: [],
  retentionDays: 90,
  notifyMinor: false,
  presenceSeconds: 60,
  sipPort: 5060,
};

/** The stored settings over the defaults (a newer plugin may add keys the stored ones lack). */
export function withDefaults(stored: Partial<IntercomSettings> | undefined): IntercomSettings {
  const s = stored ?? {};
  const modes = { ...DEFAULT_MODE_SETTINGS };
  for (const mode of MODES) if (s.modes?.[mode]) modes[mode] = { ...DEFAULT_MODE_SETTINGS[mode], ...s.modes[mode] };
  return { ...DEFAULT_SETTINGS, ...s, agent: { ...DEFAULT_AGENT, ...s.agent }, modes };
}

type Checked<T> = { value: T; errors?: undefined } | { value?: undefined; errors: string[] };

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
const between = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function checkWindow(value: unknown, where: string, errors: string[]): WeekWindow | undefined {
  const w = (value ?? {}) as Record<string, unknown>;
  const days = Array.isArray(w.days) ? (w.days.filter((d) => (EVERY_DAY as string[]).includes(d as string)) as Day[]) : [];
  if (!days.length) errors.push(`${where}: days`);
  if (!isClock(w.from) || !isClock(w.to)) errors.push(`${where}: from and to as HH:MM`);
  else if (w.from === w.to) errors.push(`${where}: from and to are the same`);
  return days.length && isClock(w.from) && isClock(w.to) ? { days, from: w.from, to: w.to } : undefined;
}

/**
 * The settings with a change applied, or what is wrong with it. Keys not given keep their value; `agent` and `modes`
 * merge one level deep, so "agent after 10 s at home" changes nothing else.
 */
export function checkSettings(current: IntercomSettings, patch: Record<string, unknown>): Checked<IntercomSettings> {
  const errors: string[] = [];
  const next: IntercomSettings = structuredClone(current);
  if ('language' in patch) {
    if (patch.language === '' || patch.language === null) delete next.language;
    else if ((LANGUAGES as readonly unknown[]).includes(patch.language)) next.language = patch.language as Language;
    else errors.push('language: ru, en or de');
  }
  if ('timeZone' in patch) {
    const zone = text(patch.timeZone, 64);
    if (!zone) delete next.timeZone;
    else if (validTimeZone(zone)) next.timeZone = zone;
    else errors.push(`timeZone: "${zone}" is not a time zone`);
  }
  if (patch.agent && typeof patch.agent === 'object') {
    const a = patch.agent as Record<string, unknown>;
    for (const key of ['enabled', 'describe', 'recordNotice'] as const) {
      if (key in a) {
        if (typeof a[key] === 'boolean') next.agent[key] = a[key];
        else errors.push(`agent.${key}: true or false`);
      }
    }
    for (const [key, max] of [
      ['name', 40],
      ['greeting', 200],
      ['houseRules', 1000],
    ] as const) {
      if (key in a) {
        const value = text(a[key], max);
        if (value) next.agent[key] = value;
        else delete next.agent[key];
      }
    }
    if ('speed' in a) {
      if (between(a.speed, 0.7, 1.5)) next.agent.speed = a.speed as number;
      else errors.push('agent.speed: 0.7 to 1.5');
    }
    if ('maxTurns' in a) {
      if (Number.isInteger(a.maxTurns) && between(a.maxTurns, 2, 20)) next.agent.maxTurns = a.maxTurns as number;
      else errors.push('agent.maxTurns: 2 to 20');
    }
    if ('llmVisitsPerDay' in a) {
      if (Number.isInteger(a.llmVisitsPerDay) && between(a.llmVisitsPerDay, 0, 1000)) next.agent.llmVisitsPerDay = a.llmVisitsPerDay as number;
      else errors.push('agent.llmVisitsPerDay: 0 to 1000');
    }
  }
  if (patch.modes && typeof patch.modes === 'object') {
    for (const [mode, raw] of Object.entries(patch.modes as Record<string, unknown>)) {
      if (!(MODES as readonly string[]).includes(mode) || !raw || typeof raw !== 'object') {
        errors.push(`modes.${mode}: unknown mode`);
        continue;
      }
      const m = raw as Record<string, unknown>;
      const target = next.modes[mode as ModeId];
      if ('agentAfterSeconds' in m) {
        if (m.agentAfterSeconds === null || (Number.isInteger(m.agentAfterSeconds) && between(m.agentAfterSeconds, 0, 120))) {
          target.agentAfterSeconds = m.agentAfterSeconds as number | null;
        } else errors.push(`modes.${mode}.agentAfterSeconds: 0 to 120, or null for no agent`);
      }
      if ('ring' in m) {
        if (['all', 'family_and_expected', 'silent', 'none', 'listed'].includes(m.ring as string)) target.ring = m.ring as ModeSettings['ring'];
        else errors.push(`modes.${mode}.ring: all, family_and_expected, silent, none or listed`);
      }
      if ('userIds' in m) {
        if (Array.isArray(m.userIds) && m.userIds.every((id) => typeof id === 'string')) target.userIds = [...new Set(m.userIds)];
        else errors.push(`modes.${mode}.userIds: a list of user ids`);
      }
      if ('chime' in m) {
        if (typeof m.chime === 'boolean') target.chime = m.chime;
        else errors.push(`modes.${mode}.chime: true or false`);
      }
      if (target.ring === 'listed' && !target.userIds.length) errors.push(`modes.${mode}: the listed users are missing`);
    }
  }
  if ('night' in patch) {
    if (!Array.isArray(patch.night)) errors.push('night: a list of windows');
    else {
      const windows = patch.night.map((w, i) => checkWindow(w, `night[${i}]`, errors));
      next.night = windows.filter((w): w is WeekWindow => Boolean(w));
    }
  }
  if ('modeUserIds' in patch) {
    if (Array.isArray(patch.modeUserIds) && patch.modeUserIds.every((id) => typeof id === 'string')) next.modeUserIds = [...new Set(patch.modeUserIds)];
    else errors.push('modeUserIds: a list of user ids');
  }
  if ('retentionDays' in patch) {
    if (Number.isInteger(patch.retentionDays) && between(patch.retentionDays, 1, 3650)) next.retentionDays = patch.retentionDays as number;
    else errors.push('retentionDays: 1 to 3650');
  }
  if ('notifyMinor' in patch) {
    if (typeof patch.notifyMinor === 'boolean') next.notifyMinor = patch.notifyMinor;
    else errors.push('notifyMinor: true or false');
  }
  if ('presenceSeconds' in patch) {
    if (Number.isInteger(patch.presenceSeconds) && between(patch.presenceSeconds, 10, 600)) next.presenceSeconds = patch.presenceSeconds as number;
    else errors.push('presenceSeconds: 10 to 600');
  }
  if ('sipPort' in patch) {
    if (Number.isInteger(patch.sipPort) && between(patch.sipPort, 1024, 65535)) next.sipPort = patch.sipPort as number;
    else errors.push('sipPort: 1024 to 65535');
  }
  return errors.length ? { errors } : { value: next };
}
