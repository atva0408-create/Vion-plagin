// i18n-skip-file: the descriptions below are read by NIKA's model, not shown in the interface.
/**
 * What NIKA may ask VION to do. Each command is offered to NIKA when the session opens (she gives them to her model as
 * tools), so a command added here reaches every NIKA without a new NIKA. A command that gives something (`grant`) goes
 * through the parents' permission (grants.ts); the others only read.
 *
 * Screen time is VOICE's: the commands call VOICE's own assistant tools, with the same checks as its page and chat.
 */
import { str } from './protocol.js';
import { texts } from './texts.js';

import type { AssistantToolContext, AssistantToolResult } from '@camera.ui/sdk';
import type { CallResult } from './link.js';
import type { Lang } from './texts.js';

export interface CommandSpec {
  name: string;
  /** for NIKA's model: what it does and when to use it */
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };
  /** gives something (time): a parent allows it first unless the setting says otherwise */
  grant: boolean;
}

const CHILD = { type: 'string', description: 'The name of the child as VION knows it (screen_time_status lists them).' };

export const COMMANDS: CommandSpec[] = [
  {
    name: 'screen_time_status',
    description:
      "VION's screen-time watch of the children at the computer, now: minutes played today, when the next break is, bedtime, " +
      'time given. Use it for "how long has he played", "when is his break".',
    parameters: { type: 'object', properties: { child: { ...CHILD, description: 'Name of the child; omit for every child.' } }, additionalProperties: false },
    grant: false,
  },
  {
    name: 'screen_time_report',
    description:
      "A child's past days at the computer, exact: minutes per day, sessions, breaks, reminders heard and rules broken (with times). Use it for " +
      '"how long did he play yesterday", "did he take his breaks", "when did he not obey".',
    parameters: {
      type: 'object',
      properties: {
        child: { ...CHILD, description: 'Name of the child; omit for every child.' },
        date: { type: 'string', description: 'Last day, YYYY-MM-DD; default today.' },
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'Days ending with date, default 1.' },
      },
      additionalProperties: false,
    },
    grant: false,
  },
  {
    name: 'screen_time_extend',
    description:
      'A parent gives a child more time at the computer: N more minutes from now (breaks, the daily limit and bedtime wait), or skipping the next break. ' +
      'Use it only when an adult says so ("разреши ему ещё час"), never on the child\'s own request. VION may first ask a parent to confirm on the phone; ' +
      'say what it answers.',
    parameters: {
      type: 'object',
      properties: {
        child: CHILD,
        minutes: { type: 'integer', minimum: 1, maximum: 240 },
        skipBreak: { type: 'boolean', description: 'Let the next break go: the time since the last break starts over.' },
      },
      required: ['child'],
      additionalProperties: false,
    },
    grant: true,
  },
  {
    name: 'screen_time_until',
    description:
      'A parent lets a child stay at the computer (or stay up) until a clock time today, e.g. "можно до 23:00". At most 4 hours from now. ' +
      "Use it only when an adult says so, never on the child's own request. VION may first ask a parent to confirm; say what it answers.",
    parameters: {
      type: 'object',
      properties: { child: CHILD, until: { type: 'string', description: 'Clock time HH:MM (24 h) in the home.' } },
      required: ['child', 'until'],
      additionalProperties: false,
    },
    grant: true,
  },
];

export const COMMAND_NAMES = COMMANDS.map((command) => command.name);

export function commandOf(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** VOICE as another plugin reaches it. */
export interface VoicePort {
  callAssistantTool(name: string, input: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult>;
}

export interface CommandHost {
  voice(): Promise<VoicePort | undefined>;
  now?: () => number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The arguments as the command takes them, or what is wrong with them. */
export function checkArgs(name: string, args: Record<string, unknown>, lang: Lang): { args: Record<string, unknown> } | { error: string } {
  const t = texts(lang);
  const child = text(args.child);
  switch (name) {
    case 'screen_time_status':
      return { args: child ? { child } : {} };
    case 'screen_time_report': {
      const out: Record<string, unknown> = {};
      if (child) out.child = child;
      if (text(args.date)) out.date = text(args.date);
      if (args.days !== undefined) out.days = Number(args.days);
      return { args: out };
    }
    case 'screen_time_extend': {
      if (!child) return { error: t.childRequired };
      const minutes = args.minutes === undefined || args.minutes === null ? undefined : Math.round(Number(args.minutes));
      const skipBreak = args.skipBreak === true;
      if (minutes !== undefined && !(minutes >= 1 && minutes <= 240)) return { error: t.minutesRange };
      if (!minutes && !skipBreak) return { error: t.minutesRange };
      return { args: { child, ...(minutes ? { minutes } : {}), ...(skipBreak ? { skipBreak } : {}) } };
    }
    case 'screen_time_until': {
      if (!child) return { error: t.childRequired };
      const until = text(args.until);
      const match = until ? /^(\d{1,2})[:.](\d{2})$/.exec(until) : null;
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { error: t.untilFormat };
      return { args: { child, until: `${match[1].padStart(2, '0')}:${match[2]}` } };
    }
    default:
      return { error: t.unknownCommand(name) };
  }
}

/** What a granting command gives, in a few words, for NIKA to say and a parent to read. */
export function summaryOf(name: string, args: Record<string, unknown>, lang: Lang): string {
  const t = texts(lang);
  const child = str(args.child);
  if (name === 'screen_time_extend') {
    const parts = [];
    if (typeof args.minutes === 'number') parts.push(t.extend(child, args.minutes));
    if (args.skipBreak === true) parts.push(t.skipBreak(child));
    return parts.join('; ');
  }
  if (name === 'screen_time_until') return t.until(child, str(args.until));
  return name;
}

/** Minutes from now until the clock time `until` in the time zone, the next such time (after midnight too). */
export function minutesUntil(until: string, timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const [wantHour, wantMinute] = until.split(':').map(Number);
  return (wantHour * 60 + wantMinute - (hour * 60 + minute) + 24 * 60) % (24 * 60);
}

const CONTEXT = (lang: Lang): AssistantToolContext => ({ userId: 'nika', role: 'admin', language: lang, timezone: '' });

async function voiceTool(host: CommandHost, tool: string, input: Record<string, unknown>, lang: Lang): Promise<AssistantToolResult | { missing: true }> {
  const voice = await host.voice();
  if (!voice) return { missing: true };
  return voice.callAssistantTool(tool, input, CONTEXT(lang));
}

/** Runs a command whose arguments checkArgs passed. */
export async function runCommand(host: CommandHost, name: string, args: Record<string, unknown>, lang: Lang): Promise<CallResult> {
  const t = texts(lang);
  const call = async (tool: string, input: Record<string, unknown>): Promise<AssistantToolResult | CallResult> => {
    const answer = await voiceTool(host, tool, input, lang);
    if ('missing' in answer) return { ok: false, error: t.noVoice };
    return answer;
  };
  switch (name) {
    case 'screen_time_status': {
      const answer = await call('voice_status', {});
      if ('ok' in answer) return answer;
      if (answer.error) return { ok: false, error: answer.error };
      const wanted = text(args.child)?.toLowerCase();
      const cameras = ((answer.content as { cameras?: unknown[] } | undefined)?.cameras ?? []) as {
        camera?: string;
        screenTime?: { childName?: string; enabled?: boolean; now?: string }[];
      }[];
      const children = cameras.flatMap((camera) =>
        (camera.screenTime ?? [])
          .filter((scenario) => !wanted || (scenario.childName ?? '').toLowerCase().includes(wanted))
          .map((scenario) => ({ child: scenario.childName ?? '', camera: camera.camera ?? '', enabled: scenario.enabled !== false, now: scenario.now ?? '' })),
      );
      if (!children.length) return { ok: false, error: t.noScenario };
      return { ok: true, text: children.map((c) => `${c.child}: ${c.enabled ? c.now : '—'}`).join('\n'), data: children };
    }
    case 'screen_time_report': {
      const answer = await call('voice_report', args);
      if ('ok' in answer) return answer;
      if (answer.error) return { ok: false, error: answer.error };
      return { ok: true, data: answer.content };
    }
    case 'screen_time_extend': {
      const answer = await call('voice_extend', args);
      if ('ok' in answer) return answer;
      if (answer.error) return { ok: false, error: answer.error };
      const now = (answer.content as { now?: string } | undefined)?.now;
      return { ok: true, text: `${t.done(summaryOf(name, args, lang))}${now ? ` ${now}` : ''}`, data: answer.content };
    }
    case 'screen_time_until': {
      // the clock of the home is VOICE's (its setting, else the server's): its report names it
      const report = await call('voice_report', { child: args.child, days: 1 });
      if ('ok' in report) return report;
      if (report.error) return { ok: false, error: report.error };
      const zone = String((report.content as { timezone?: string } | undefined)?.timezone ?? '') || 'UTC';
      const minutes = minutesUntil(String(args.until), zone, (host.now ?? Date.now)());
      if (minutes === 0) return { ok: false, error: t.untilNow };
      // «до 23:00» said at 23:10 is a time gone by, not 23 hours and 50 minutes more
      if (minutes > 240) return { ok: false, error: 24 * 60 - minutes <= 120 ? t.untilNow : t.untilTooFar };
      const answer = await call('voice_extend', { child: args.child, minutes });
      if ('ok' in answer) return answer;
      if (answer.error) return { ok: false, error: answer.error };
      const now = (answer.content as { now?: string } | undefined)?.now;
      return { ok: true, text: `${t.done(summaryOf(name, args, lang))}${now ? ` ${now}` : ''}`, data: { minutes, ...(answer.content as object) } };
    }
    default:
      return { ok: false, error: t.unknownCommand(name) };
  }
}
