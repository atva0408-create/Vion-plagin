// i18n-skip-file: the descriptions below are read by NIKA's model, not shown in the interface.
/**
 * Care (VION's docs/NIKA_CARE.md): NIKA sets the questions a camera asks its vision model about a child and the room,
 * reads the answers and is told when they change. The commands are VION's own care, asked over the core manager — the
 * same the routes /api/care and the assistant's tools answer — so what NIKA hears is what the page shows.
 *
 * Reading and «look now» go at once. Making, changing and deleting a task set what a camera watches in a child's room:
 * a voice proves nothing about who speaks, so they wait for a parent (`grant`), as more screen time does.
 */
import { str } from './protocol.js';
import { texts } from './texts.js';

import type { CommandSpec } from './commands.js';
import type { CallResult } from './link.js';
import type { Lang } from './texts.js';

/** What the plugin asks the core for (the server's care/link.ts). */
export interface CareRequest {
  action: 'health' | 'overview' | 'status' | 'look' | 'report' | 'set' | 'remove';
  args?: Record<string, unknown>;
  language?: string;
}

export type CareAnswer = { ok: true; data: unknown; text?: string } | { ok: false; code: string; message: string };

/** The core's care; undefined on a VION server from before care. */
export type CarePort = (request: CareRequest) => Promise<CareAnswer | undefined>;

const TASK = { type: 'string', description: 'The id or the name of a care task, as care_status lists them.' };
const CHILD = { type: 'string', description: 'The name of the child as the task calls them (care_status and care_overview list the children).' };
const CAMERA = { type: 'string', description: 'The name of a camera, as care_overview lists them.' };
const QUESTIONS = {
  type: 'array',
  maxItems: 6,
  description:
    'What to ask. A built-in question by its id: present, in_bed, asleep, activity (sleeping, lying_in_bed, at_desk_homework, at_computer, ' +
    'phone_tablet, watching_tv, playing, tidying, eating, absent, other), toys_on_floor, room_tidy. Or a question of your own: ' +
    '{"id": "light", "text": "Is the ceiling light on?", "kind": "yesno"} or {"text": "...", "kind": "choice", "options": ["...", "..."]}.',
  items: {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['yesno', 'choice'] },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    ],
  },
};

export const CARE_COMMANDS: CommandSpec[] = [
  {
    name: 'care_overview',
    description:
      'What VION can look after: the cameras, the vision models (in the home or in the cloud, seconds per look), the built-in questions with their ' +
      'answers and the limits. ' +
      'Call it before care_set to learn the names of the cameras.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    grant: false,
  },
  {
    name: 'care_status',
    description:
      'What the care tasks know right now: for each child what they do and since when, minutes of today by answer, the alarms that are on, one ' +
      'sentence of what the camera sees, ' +
      'and why a task is not looking (idle). Use it for "what are the children doing", "is he at his homework", "how long has he been at the computer". ' +
      'The answers are confirmed by two looks; a value null means "not seen, not known" — say so, never guess.',
    parameters: { type: 'object', properties: { child: CHILD, camera: CAMERA, task: TASK }, additionalProperties: false },
    grant: false,
  },
  {
    name: 'care_look',
    description:
      'Look now: a new picture of the camera is shown to the vision model and its answers come back — of this one look, not confirmed. It takes 20 ' +
      'to 30 seconds on the model in the home. ' +
      'Use it when the answer must be fresh ("did he get up", "is he asleep right now"). To be sure, look again in half a minute and compare. ' +
      'A value null means the model does not know; an error code no_view means the room is dark or the camera is turned away — neither means "nobody there".',
    parameters: {
      type: 'object',
      properties: {
        child: CHILD,
        task: TASK,
        camera: CAMERA,
        questions: QUESTIONS,
        maxAgeSeconds: { type: 'number', minimum: 0, maximum: 600, description: 'A look not older than this is good enough; 0 (default): always a new picture.' },
        timeoutSeconds: { type: 'number', minimum: 5, maximum: 120, description: 'How long to wait for the model, default 60.' },
      },
      additionalProperties: false,
    },
    grant: false,
  },
  {
    name: 'care_report',
    description:
      'How a day went: minutes by answer for each question (at the computer, homework, asleep...) and the alarms told, for one day or several. Use ' +
      'it for "what did he do today", "how long did he play yesterday".',
    parameters: {
      type: 'object',
      properties: {
        child: CHILD,
        task: TASK,
        date: { type: 'string', description: 'Last day, YYYY-MM-DD; default today.' },
        days: { type: 'integer', minimum: 1, maximum: 31, description: 'Days ending with date, default 1.' },
      },
      additionalProperties: false,
    },
    grant: false,
  },
  {
    name: 'care_set',
    description:
      'Make a care task or change one: which camera looks after which child, what it asks, when it looks by itself and what it raises an alarm on. ' +
      'Use it when an adult asks to look after a child ("nanny mode for Artyom", "check that he does his homework after school", "tell me if he is ' +
      'at the computer for more than an hour"). ' +
      'To change or switch a task off name it in `task` and give only what changes (`enabled: false` stops it). VION may first ask a parent to ' +
      'confirm; say what it answers.',
    parameters: {
      type: 'object',
      properties: {
        task: { ...TASK, description: 'The task to change; omit to make a new one.' },
        child: CHILD,
        camera: CAMERA,
        name: { type: 'string', description: 'The name of the task; default "<child> — <camera>".' },
        tag: { type: 'string', description: 'A word of yours to find your tasks later, e.g. "nanny".' },
        questions: { ...QUESTIONS, description: `${QUESTIONS.description} Default for a new task: present and activity.` },
        windows: {
          type: 'array',
          description:
            'When VION looks by itself. No windows: only when asked (care_look). Example: weekday mornings every 30 seconds, every day in the afternoon every 2 minutes.',
          items: {
            type: 'object',
            properties: {
              days: {
                description: 'daily, weekdays, weekends, or a list of mon, tue, wed, thu, fri, sat, sun.',
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              from: { type: 'string', description: 'HH:MM' },
              to: { type: 'string', description: 'HH:MM; 24:00 for midnight' },
              everySeconds: { type: 'integer', minimum: 20, maximum: 3600 },
            },
            required: ['from', 'to', 'everySeconds'],
          },
        },
        alarms: {
          type: 'array',
          description:
            'Raised when the answer of a question is one of `values` for longer than `forMinutes` (0: at once). A break shorter than 5 minutes does not ' +
            'restart the count.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              values: { type: 'array', items: { type: 'string' }, description: 'Answers of the question: option ids, or yes / no.' },
              forMinutes: { type: 'integer', minimum: 0, maximum: 720 },
              text: { type: 'string', description: "What is told, in the family's language." },
              level: { type: 'string', enum: ['info', 'warn', 'urgent'] },
              repeatMinutes: { type: 'integer', minimum: 1, maximum: 720 },
              notify: { type: 'boolean', description: 'false: VION sends no notification of its own, you tell of it yourself.' },
            },
            required: ['question', 'values', 'text'],
          },
        },
        model: {
          type: 'string',
          description:
            'local (a model in the home, default when there is one), auto, or a model id of care_overview. A cloud model is allowed by the owner on the VION page only.',
        },
        enabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    grant: true,
  },
  {
    name: 'care_remove',
    description: 'Delete a care task with its journal. Use it only when an adult says so. VION may first ask a parent to confirm; say what it answers.',
    parameters: { type: 'object', properties: { task: TASK }, required: ['task'], additionalProperties: false },
    grant: true,
  },
];

const ACTION: Record<string, CareRequest['action']> = {
  care_overview: 'overview',
  care_status: 'status',
  care_look: 'look',
  care_report: 'report',
  care_set: 'set',
  care_remove: 'remove',
};

export function isCareCommand(name: string): boolean {
  return name in ACTION;
}

/** The arguments as they go to VION, which checks them whole; here only what must be there to ask a parent about it. */
export function careArgs(name: string, args: Record<string, unknown>, lang: Lang): { args: Record<string, unknown> } | { error: string } {
  const t = texts(lang);
  if (name === 'care_remove' && !str(args.task).trim()) return { error: t.careTaskRequired };
  if (name === 'care_set' && !str(args.task).trim() && (!str(args.child).trim() || !str(args.camera).trim())) return { error: t.careNeeds };
  return { args };
}

/** What a changing command does, in a few words, for NIKA to say and a parent to read before they allow it. */
export function careSummary(name: string, args: Record<string, unknown>, lang: Lang): string {
  const t = texts(lang);
  if (name === 'care_remove') return t.careRemove(str(args.task));
  if (str(args.task).trim()) return args.enabled === false ? t.careOff(str(args.task)) : t.careChange(str(args.task));
  return t.careWatch(str(args.child), str(args.camera));
}

export async function runCare(care: CarePort | undefined, name: string, args: Record<string, unknown>, lang: Lang): Promise<CallResult> {
  const t = texts(lang);
  const answer = await care?.({ action: ACTION[name], args, language: lang });
  if (!answer) return { ok: false, code: 'model_unavailable', error: t.careOld };
  if (!answer.ok) return { ok: false, code: answer.code, error: answer.message };
  return { ok: true, ...(answer.text ? { text: answer.text } : {}), data: answer.data };
}
