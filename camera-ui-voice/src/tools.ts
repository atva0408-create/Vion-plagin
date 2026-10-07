// i18n-skip-file: the descriptions below are read by the model, not shown in the interface.
/**
 * Tools of the assistant: the owner sets VOICE up in words ("break every 45 minutes, bed at 21:30 on school days").
 * Every tool that changes something needs the owner's confirmation in the chat and an administrator; the values go
 * through the same checks and into the same settings as the camera drawer, so both always show the same.
 */
import { checkDoorRule, checkScreenTime, SCREEN_TIME_DEFAULTS } from './settings.js';
import { DAYS } from './time.js';

import type { AssistantToolProperty, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';
import type { DoorRuleValues, PluginValues, ScreenTimeValues } from './settings.js';
import type { Voice } from './voice.js';

export interface ToolCamera {
  id: string;
  name: string;
  zones: string[];
  /** Why VOICE cannot speak there; undefined when it can. */
  problem?: string;
}

export interface ToolHost {
  voice: Voice;
  cameras(): ToolCamera[];
  readScreenTime(cameraId: string): ScreenTimeValues[];
  writeScreenTime(cameraId: string, values: ScreenTimeValues[]): Promise<void>;
  pluginValues(): PluginValues;
  writePluginValue<K extends keyof PluginValues>(key: K, value: PluginValues[K]): Promise<void>;
}

const CAMERA = { type: 'string', description: 'Camera name or id, as voice_speakers lists them.' } as const;
const CLOCK = (what: string) => ({ type: 'string', description: `${what}, HH:MM (24 h). Empty string for none.` }) as const;
const DAY_LIST: AssistantToolProperty = {
  type: 'array',
  items: { type: 'string', enum: [...DAYS] as string[] },
  description:
    'The evenings that are followed by a school (work) day; their nights use the school-night bedtime, all other evenings the free-night bedtime. ' +
    'Default sun, mon, tue, wed, thu: "weekdays" in speech usually means these evenings, "weekend" means fri and sat evenings.',
};

export const TOOLS: AssistantToolSpec[] = [
  {
    name: 'voice_status',
    description:
      "What VOICE does now: per camera whether it can speak, the screen-time scenarios with today's time and the current state (break, bedtime), " +
      'the door rules, and the last phrases VOICE said and what children answered.',
    inputSchema: { type: 'object', properties: { camera: CAMERA } },
  },
  {
    name: 'voice_speakers',
    description: 'Cameras VOICE can speak through (they have a speaker and a talk channel) and, for the others, why not. Use it to find camera names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'voice_set_screen_time',
    description:
      'Create or change the screen-time scenario of one child at one camera, in one call with all values the owner gave: who, which zone of the ' +
      'camera is the computer, how long to play before a break, how long the break is, a daily limit, bedtime. Values not given keep their current ' +
      'value (defaults for a new scenario: break every 45 min for 10 min, no daily limit, school nights 21:30-07:30, free nights 22:30-08:30). ' +
      'If the owner gave a bedtime but no wake-up time, keep the current wake-up time and say so in your answer.',
    inputSchema: {
      type: 'object',
      properties: {
        camera: CAMERA,
        child: { type: 'string', description: 'The name the child is called by, e.g. "Артём".' },
        zone: { type: 'string', description: 'The object zone of the camera where the computer is; voice_status lists the zones.' },
        sessionMinutes: { type: 'integer', minimum: 5, maximum: 240, description: 'Minutes at the computer before a break.' },
        breakMinutes: { type: 'integer', minimum: 3, maximum: 120, description: 'Length of the break in minutes.' },
        dailyMinutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Minutes a day at most; 0 for no daily limit.' },
        schoolFrom: CLOCK('Bedtime on school nights'),
        schoolTo: CLOCK('Wake-up after school nights'),
        freeFrom: CLOCK('Bedtime on free nights (weekend)'),
        freeTo: CLOCK('Wake-up after free nights'),
        schoolEvenings: DAY_LIST,
        answerQuestions: { type: 'boolean', description: 'Listen 10 s after a phrase and answer what the child asks.' },
        repeatMinutes: { type: 'integer', minimum: 1, maximum: 60, description: 'Minutes between the soft phrase, the firm one and the notice to the parents.' },
        enabled: { type: 'boolean' },
      },
      required: ['camera', 'child'],
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'voice_extend',
    description: 'A parent gives the child more time: N more minutes from now (all limits wait), or skipping the next break.',
    inputSchema: {
      type: 'object',
      properties: {
        camera: CAMERA,
        child: { type: 'string' },
        minutes: { type: 'integer', minimum: 1, maximum: 240 },
        skipBreak: { type: 'boolean', description: 'Let the next break go: the time since the last break starts over.' },
      },
      required: ['child'],
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'voice_set_door',
    description:
      'Rule "who is at the door": when a door camera starts an event with a person, VOICE says in the rooms who came ("Папа пришёл", "a stranger ' +
      'is at the door", or with describe a short description from a snapshot). Creates a rule, or replaces rule number `rule` from voice_status.',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'integer', minimum: 1, description: 'Number of the rule to replace; omit to add a rule.' },
        doorCameras: { type: 'array', items: { type: 'string' }, description: 'Cameras that see the door (names or ids).' },
        speakers: { type: 'array', items: { type: 'string' }, description: 'Cameras that speak (names or ids, from voice_speakers).' },
        describe: { type: 'boolean', description: 'Describe a stranger from a snapshot (needs a vision model; 5 s at most).' },
        cooldownSeconds: { type: 'integer', minimum: 0, maximum: 3600, description: 'Do not repeat the same person sooner. Default 120.' },
        quietFrom: CLOCK('Quiet hours of the rule from'),
        quietTo: CLOCK('Quiet hours of the rule until'),
      },
      required: ['doorCameras', 'speakers'],
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'voice_say',
    description:
      'Say something aloud through a camera speaker: either the exact `text`, or an `instruction` VOICE turns into a phrase ("tell Artem dinner is ready"). ' +
      'Answers spoken, no_backchannel (the camera cannot speak), busy (too many phrases) or failed.',
    inputSchema: {
      type: 'object',
      properties: { camera: CAMERA, text: { type: 'string' }, instruction: { type: 'string' } },
      required: ['camera'],
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
    timeoutMs: 90_000,
  },
  {
    name: 'voice_disable',
    description: 'Turn off the screen-time scenario of a child at a camera, or a door rule by its number. It stays in the settings and can be turned on again.',
    inputSchema: {
      type: 'object',
      properties: { camera: CAMERA, child: { type: 'string' }, doorRule: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findCamera(host: ToolHost, value: unknown): ToolCamera | { error: string } {
  const wanted = text(value);
  const cameras = host.cameras();
  const list = cameras.map((c) => `"${c.name}"`).join(', ') || 'none (turn VOICE on in the Plugins tab of a camera)';
  if (!wanted) return { error: `camera is required. Cameras: ${list}` };
  const lower = wanted.toLowerCase();
  const found = cameras.find((c) => c.id === wanted || c.name.toLowerCase() === lower) ?? cameras.find((c) => c.name.toLowerCase().includes(lower));
  return found ?? { error: `Unknown camera "${wanted}". Cameras: ${list}` };
}

function cameraIds(host: ToolHost, values: unknown, field: string): string[] | { error: string } {
  if (!Array.isArray(values) || !values.length) return { error: `${field}: give at least one camera` };
  const ids: string[] = [];
  for (const value of values) {
    const camera = findCamera(host, value);
    if ('error' in camera) return { error: `${field}: ${camera.error}` };
    ids.push(camera.id);
  }
  return ids;
}

export async function callTool(host: ToolHost, name: string, input: Record<string, unknown>): Promise<AssistantToolResult> {
  try {
    switch (name) {
      case 'voice_status':
        return status(host, input);
      case 'voice_speakers':
        return {
          content: host.cameras().map((c) => ({ camera: c.name, id: c.id, canSpeak: !c.problem, ...(c.problem ? { why: c.problem } : {}) })),
        };
      case 'voice_set_screen_time':
        return await setScreenTime(host, input);
      case 'voice_extend':
        return extend(host, input);
      case 'voice_set_door':
        return await setDoor(host, input);
      case 'voice_say':
        return await say(host, input);
      case 'voice_disable':
        return await disable(host, input);
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function status(host: ToolHost, input: Record<string, unknown>): AssistantToolResult {
  let cameras = host.cameras();
  if (input.camera !== undefined) {
    const one = findCamera(host, input.camera);
    if ('error' in one) return one;
    cameras = [one];
  }
  const values = host.pluginValues();
  return {
    content: {
      cameras: cameras.map((c) => ({
        camera: c.name,
        canSpeak: !c.problem,
        ...(c.problem ? { why: c.problem } : {}),
        zones: c.zones,
        screenTime: host.readScreenTime(c.id).map((v) => ({
          ...v,
          now: host.voice.statusOf(`${c.id}/${checkScreenTime(v, c.zones).value?.id ?? v.id}`) || undefined,
        })),
      })),
      doorRules: (values.doorRules ?? []).map((rule, index) => ({ rule: index + 1, ...rule })),
      recent: host.voice.recent.slice(-20).map(({ at, cameraId, ...e }) => ({ ...e, at: new Date(at).toISOString(), camera: host.voice.camera(cameraId)?.name })),
    },
  };
}

async function setScreenTime(host: ToolHost, input: Record<string, unknown>): Promise<AssistantToolResult> {
  const camera = findCamera(host, input.camera);
  if ('error' in camera) return camera;
  const child = text(input.child);
  if (!child) return { error: 'child: the name of the child is required' };
  if (camera.problem) return { error: `VOICE cannot speak through "${camera.name}": ${camera.problem}. Choose a camera from voice_speakers.` };

  const list = host.readScreenTime(camera.id);
  const index = list.findIndex((v) => v.childName?.trim().toLowerCase() === child.toLowerCase());
  const current: ScreenTimeValues = index >= 0 ? list[index] : { ...SCREEN_TIME_DEFAULTS, childName: child };
  const changes: ScreenTimeValues = {};
  for (const key of [
    'zone',
    'sessionMinutes',
    'breakMinutes',
    'dailyMinutes',
    'schoolFrom',
    'schoolTo',
    'freeFrom',
    'freeTo',
    'schoolEvenings',
    'answerQuestions',
    'repeatMinutes',
    'enabled',
  ] as const) {
    if (input[key] !== undefined) (changes as Record<string, unknown>)[key] = input[key];
  }
  const next: ScreenTimeValues = { ...current, ...changes, childName: current.childName ?? child };
  const checked = checkScreenTime(next, camera.zones);
  if (!checked.value) return { error: `Not saved. Fix: ${checked.errors.join('; ')}` };
  next.id = checked.value.id;
  const updated = [...list];
  if (index >= 0) updated[index] = next;
  else updated.push(next);
  await host.writeScreenTime(camera.id, updated);
  return { content: { saved: true, camera: camera.name, scenario: next, note: 'The same values are now in the camera settings, Plugins tab, VOICE.' } };
}

function extend(host: ToolHost, input: Record<string, unknown>): AssistantToolResult {
  const child = text(input.child);
  if (!child) return { error: 'child is required' };
  const minutes = typeof input.minutes === 'number' ? Math.round(input.minutes) : undefined;
  const skipBreak = input.skipBreak === true;
  if (!minutes && !skipBreak) return { error: 'give minutes (1-240) or skipBreak: true' };
  if (minutes !== undefined && (minutes < 1 || minutes > 240)) return { error: 'minutes: from 1 to 240' };
  const cameras = input.camera === undefined ? host.cameras() : [findCamera(host, input.camera)];
  for (const camera of cameras) {
    if ('error' in camera) return camera;
    const scenario = host.voice.findScenario(camera.id, child);
    if (!scenario) continue;
    host.voice.extend(scenario.key, minutes, skipBreak);
    return { content: { done: true, camera: camera.name, now: host.voice.statusOf(scenario.key) } };
  }
  return { error: `No screen-time scenario for "${child}". voice_status lists them.` };
}

async function setDoor(host: ToolHost, input: Record<string, unknown>): Promise<AssistantToolResult> {
  const doors = cameraIds(host, input.doorCameras, 'doorCameras');
  if ('error' in doors) return doors;
  const speakers = cameraIds(host, input.speakers, 'speakers');
  if ('error' in speakers) return speakers;
  const rule: DoorRuleValues = {
    enabled: true,
    doorCameras: doors,
    speakers,
    labels: ['person'],
    describe: input.describe === true,
    cooldownSeconds: typeof input.cooldownSeconds === 'number' ? input.cooldownSeconds : 120,
    ...(text(input.quietFrom) ? { quietFrom: text(input.quietFrom) } : {}),
    ...(text(input.quietTo) ? { quietTo: text(input.quietTo) } : {}),
  };
  const all = host.cameras();
  const checked = checkDoorRule(
    rule,
    all.map((c) => c.id),
    all.filter((c) => !c.problem).map((c) => c.id),
  );
  if (!checked.value) return { error: `Not saved. Fix: ${checked.errors.join('; ')}` };
  const rules = [...(host.pluginValues().doorRules ?? [])];
  const number = typeof input.rule === 'number' ? Math.round(input.rule) : undefined;
  if (number !== undefined && (number < 1 || number > rules.length)) return { error: `rule: there are ${rules.length} rules` };
  if (number !== undefined) rules[number - 1] = rule;
  else rules.push(rule);
  await host.writePluginValue('doorRules', rules);
  return { content: { saved: true, rule: number ?? rules.length, ...rule } };
}

async function say(host: ToolHost, input: Record<string, unknown>): Promise<AssistantToolResult> {
  const camera = findCamera(host, input.camera);
  if ('error' in camera) return camera;
  const phrase = text(input.text);
  const instruction = text(input.instruction);
  if (!phrase && !instruction) return { error: 'give text (said as is) or instruction (VOICE writes the phrase)' };
  if (camera.problem) return { content: { status: 'no_backchannel', camera: camera.name, reason: camera.problem } };
  const result = phrase ? { ...(await host.voice.say(camera.id, phrase)), text: phrase } : await host.voice.sayInstructed(camera.id, instruction!);
  return { content: { camera: camera.name, ...result } };
}

async function disable(host: ToolHost, input: Record<string, unknown>): Promise<AssistantToolResult> {
  if (typeof input.doorRule === 'number') {
    const rules = [...(host.pluginValues().doorRules ?? [])];
    const index = Math.round(input.doorRule) - 1;
    if (!rules[index]) return { error: `doorRule: there are ${rules.length} rules` };
    rules[index] = { ...rules[index], enabled: false };
    await host.writePluginValue('doorRules', rules);
    return { content: { disabled: `door rule ${index + 1}` } };
  }
  const camera = findCamera(host, input.camera);
  if ('error' in camera) return camera;
  const child = text(input.child);
  const list = host.readScreenTime(camera.id);
  const matches = list.map((v, i) => [v, i] as const).filter(([v]) => !child || v.childName?.trim().toLowerCase() === child.toLowerCase());
  if (matches.length !== 1) return { error: child ? `No scenario for "${child}" at "${camera.name}"` : `Name the child: ${list.map((v) => v.childName).join(', ')}` };
  const updated = [...list];
  updated[matches[0][1]] = { ...matches[0][0], enabled: false };
  await host.writeScreenTime(camera.id, updated);
  return { content: { disabled: `screen time of ${matches[0][0].childName} at ${camera.name}` } };
}
