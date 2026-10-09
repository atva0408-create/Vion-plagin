// i18n-skip-file: the descriptions below are read by the model, not shown in the interface.
/**
 * The assistant's tools: the owner gives the door agent instructions in words ("we are away, a courier from Ozon will
 * come, tell him to leave it at the gate"), asks who came, opens a door, gives a guest a code. Each tool calls the same
 * method of the intercom as the interface does, with the same checks and rights (ТЗ 2.4, 13); everything that changes
 * something needs the user's confirmation in the chat.
 */
import { formatClock, localTime } from '@vionvision/speech';

import { IntercomError } from './access.js';
import { parseMoment } from './inputs.js';
import { CATEGORIES, MODES } from './types.js';

import type { AssistantToolContext, AssistantToolReference, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';
import type { Actor } from './access.js';
import type { Intercom } from './intercom.js';
import type { VisitQuery } from './store.js';
import type { Category, Instruction, Outcome, Visit } from './types.js';

const MOMENT =
  'A local date and time of the household as "YYYY-MM-DDTHH:MM" (intercom_status gives the household\'s time zone and time now), ' + 'or an ISO time with its offset.';
const PANEL = { type: 'string', description: 'Panel name or id, as intercom_status lists them.' } as const;
const OUTCOMES: Outcome[] = ['answered', 'agent', 'message', 'opened', 'missed', 'declined', 'nobody', 'interrupted'];

export const TOOLS: AssistantToolSpec[] = [
  {
    name: 'intercom_status',
    description:
      'The intercom now: its panels and their doors (with whether the user may open them), the mode of the house and its end, calls in progress, ' +
      "the active instructions of the door agent, the household's time zone and local time. Call it first to learn panel and door names.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'intercom_visits',
    description:
      'Who came to the door: visits of the archive with who it was, why, what the agent did and what they asked to pass on. ' +
      'Use it for "who came today?", "did the courier come?", "who rang at night?", "what did the plumber say?". Default: today.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Start of the period. ${MOMENT} Default: today 00:00.` },
        to: { type: 'string', description: `End of the period. ${MOMENT} Default: now.` },
        panel: PANEL,
        person: { type: 'string', description: 'A person of the directory (intercom_people), name or id.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'Kind of visit.' },
        company: { type: 'string', description: 'A service named by visitors: "Ozon", "СДЭК".' },
        outcome: { type: 'string', enum: OUTCOMES, description: 'How the visit ended.' },
        opened: { type: 'boolean', description: 'Only visits where a door was opened.' },
        hasMessage: { type: 'boolean', description: 'Only visits with a message for the owners.' },
        text: { type: 'string', description: 'Words of the conversation, the purpose or the summary.' },
        unseen: { type: 'boolean', description: 'Only visits the user has not looked at.' },
      },
    },
  },
  {
    name: 'intercom_add_instruction',
    description:
      'Give the door agent an instruction for an expected visitor: who is expected, when, what to say, what to ask, whether to open, whether to call the owner. ' +
      'Examples: "we are away, a courier from Ozon will come, tell him to leave it at the gate" → expect {label "курьер Озона", companies ["Ozon"]}, ' +
      'say "Оставьте, пожалуйста, у калитки"; "Masha comes at 3, tell her the key is at the neighbour\'s" → a secret: needs Masha\'s face or a guest code; ' +
      '"the plumber tomorrow 10-12, open the gate" → open ["Калитка"], needs a guest code, a plate or a face; ' +
      '"if someone from the gas service comes, do not open and write me" → neverOpen, notify "urgent"; ' +
      '"cleaner Olya every Tuesday 10-14, open" → days ["tue"], from "10:00", to "14:00", her face. ' +
      'BEFORE calling, ask the user when: (1) a door should open but the visitor is known only by what they say - opening then works for anyone who ' +
      'names themselves, suggest a guest code (guestCode true) or a face/plate, and set openOnWeak only if the user explicitly agrees; ' +
      '(2) the message is a secret (a key, a code, an address, that nobody is home, when the owners return) - suggest a face or a guest code; ' +
      '(3) "open to nobody" - ask whether the family is included (exceptFamily). ' +
      'Without a time the window is today until 23:00; "tomorrow" is all of tomorrow; "at 3 o\'clock" is 14:30-17:00. ' +
      'Tell the user the window, how the visitor is recognized, what will be said, whether a door opens. A guest code is shown once: give it to the user to pass on.',
    approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The instruction as the user said it.' },
        panels: { type: 'array', items: { type: 'string' }, description: 'Panel names or ids; omit for all panels.' },
        from: { type: 'string', description: `Start of the window. ${MOMENT} Default: now.` },
        to: { type: 'string', description: `End of the window. ${MOMENT}` },
        days: {
          type: 'array',
          items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          description: 'For a weekly instruction: the days; from/to are then HH:MM.',
        },
        until: { type: 'string', description: `For a weekly instruction: when it stops. ${MOMENT}` },
        label: { type: 'string', description: 'Who is expected, in a few words: "курьер Озона", "Маша", "сантехник из УК"; "*" for anyone.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'Kind of visitor.' },
        companies: { type: 'array', items: { type: 'string' }, description: 'Services the visitor may name: ["Ozon"], ["СДЭК"].' },
        names: { type: 'array', items: { type: 'string' }, description: 'Names the visitor may give.' },
        people: { type: 'array', items: { type: 'string' }, description: 'People of the directory known by face or plate (intercom_people).' },
        plates: { type: 'array', items: { type: 'string' }, description: 'Car plates: "А001АА77".' },
        guestCode: { type: 'boolean', description: 'Make a one-time guest code for this visitor; the code is returned once.' },
        say: { type: 'string', description: 'What the agent says once it recognized the visitor, in the words for the visitor.' },
        sayVerbatim: { type: 'boolean', description: 'Say it exactly as written (default when it has numbers, an address or a key).' },
        ask: { type: 'array', items: { type: 'string' }, description: 'Questions for the visitor: "во сколько придёт мастер?".' },
        open: { type: 'array', items: { type: 'string' }, description: 'Doors to open for this visitor (names or ids).' },
        openOnWeak: { type: 'boolean', description: 'The user agreed that the door opens for anyone who names themselves as expected.' },
        neverOpen: { type: 'boolean', description: 'Never open for this visitor.' },
        exceptFamily: { type: 'boolean', description: 'With neverOpen for anyone: the family known by face still gets in.' },
        callOwner: {
          type: 'string',
          enum: ['no', 'yes', 'if_needed'],
          description: 'Call the owner when this visitor comes: no, yes (even at night), if needed (default).',
        },
        notify: { type: 'string', enum: ['none', 'quiet', 'normal', 'urgent'], description: 'How to tell the owner afterwards (default normal).' },
        once: { type: 'boolean', description: 'Done after the first visit (default true for a window, false weekly).' },
      },
      required: ['text', 'label'],
    },
  },
  {
    name: 'intercom_instructions',
    description: "The door agent's instructions: active ones by default, with all: also done, cancelled and past ones (kept 30 days).",
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include done, cancelled and past instructions.' } } },
  },
  {
    name: 'intercom_cancel_instruction',
    description: 'Cancel an instruction of the door agent (its guest code stops working too).',
    approval: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Instruction id from intercom_instructions.' } }, required: ['id'] },
  },
  {
    name: 'intercom_set_mode',
    description:
      'Set the mode of the house: home (everyone is called, the agent after 25 s), away (nobody is called, the agent answers at once), ' +
      'night, dnd (phones without sound), child (a child home alone: the parents are called). ' +
      '"We left until Sunday" → away until Sunday 20:00 unless the user named a time; ask when it is unclear. The mode returns to home at its end.',
    approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...MODES] },
        until: { type: 'string', description: `When the mode ends. ${MOMENT} Omit for no end.` },
      },
      required: ['mode'],
    },
  },
  {
    name: 'intercom_guest_code',
    description:
      'Make a six-digit guest code that opens the given doors in a window: "give the plumber a code for tomorrow 10 to 12". ' +
      'The code is shown once in the answer with a text to send to the guest; it is a key, tell the user to pass it only to that person.',
    approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Who the code is for.' },
        doors: { type: 'array', items: { type: 'string' }, description: 'Door names or ids.' },
        from: { type: 'string', description: `Start. ${MOMENT} Default: now.` },
        to: { type: 'string', description: `End. ${MOMENT} Default: today 23:00.` },
        maxUses: { type: 'integer', minimum: 1, maximum: 20, description: 'How many times it opens (default 1).' },
      },
      required: ['label', 'doors'],
    },
  },
  {
    name: 'intercom_open',
    description: 'Open a door of a panel now ("open the gate"). Only when the user asked for it in this message.',
    approval: true,
    inputSchema: {
      type: 'object',
      properties: { panel: PANEL, door: { type: 'string', description: 'Door name or id; default the first door of the panel.' } },
      required: ['panel'],
    },
  },
  {
    name: 'intercom_say',
    description:
      'During a call in progress, have the door agent say the user\'s words to the visitor: "tell him I\'ll come down in 5 minutes". ' +
      'Not an instruction: only for a call ringing or talking now.',
    approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "The user's words for the visitor." },
        panel: { type: 'string', description: 'The panel of the call, when several ring.' },
        verbatim: { type: 'boolean', description: 'Say exactly as written (default) or retell politely.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'intercom_people',
    description: 'The people the intercom knows: family, friends, staff, service, the blocked; with their faces, plates and door access.',
    adminOnly: true,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'intercom_set_person',
    description:
      'Add or change a person of the directory: name, role, the face names of the recorder, plates, door access by days and hours, ' +
      'opening without a ring. Give id to change an existing person; values not given stay.',
    approval: true,
    adminOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the person to change; omit for a new one.' },
        name: { type: 'string' },
        role: { type: 'string', enum: ['family', 'friend', 'staff', 'service', 'blocked', 'other'] },
        child: { type: 'boolean' },
        faceNames: { type: 'array', items: { type: 'string' }, description: 'Names of the faces in the recorder.' },
        plates: { type: 'array', items: { type: 'string' } },
        access: {
          type: 'array',
          description: 'When the person may come in: [{doors: ["Калитка"], days: ["mon"], from: "10:00", to: "14:00"}].',
          items: {
            type: 'object',
            properties: {
              doors: { type: 'array', items: { type: 'string' } },
              days: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
              from: { type: 'string', description: 'HH:MM' },
              to: { type: 'string', description: 'HH:MM' },
            },
          },
        },
        openWithoutRing: { type: 'boolean', description: 'Open when recognized, without a ring.' },
        note: { type: 'string' },
      },
    },
  },
];

const actorOf = (ctx: AssistantToolContext): Actor => ({ userId: ctx.userId, role: ctx.role });

function moment(intercom: Intercom, ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const zone = intercom.timeZone();
  return `${localTime(ms, zone).date} ${formatClock(ms, zone)}`;
}

function visitLine(intercom: Intercom, visit: Visit, panels: Map<string, string>): Record<string, unknown> {
  return {
    id: visit.id,
    at: moment(intercom, visit.startedAt),
    panel: panels.get(visit.panelId) ?? visit.panelId,
    title: visit.title,
    summary: visit.summary,
    who: visit.who.name,
    company: visit.who.company,
    category: visit.who.category,
    purpose: visit.purpose,
    outcome: visit.outcome,
    message: visit.messageForOwner,
    callback: visit.callback,
    opened: visit.actions.filter((a) => a.kind === 'open').map((a) => `${a.detail}: ${a.result ?? ''}`),
    flags: visit.flags.length ? visit.flags : undefined,
  };
}

function instructionLine(intercom: Intercom, instruction: Instruction): Record<string, unknown> {
  const w = instruction.when;
  const until = w.kind === 'weekly' && w.until ? ` until ${moment(intercom, w.until)}` : '';
  const when = w.kind === 'window' ? `${moment(intercom, w.from)} - ${moment(intercom, w.to)}` : `${w.days.join(', ')} ${w.from}-${w.to}${until}`;
  return {
    id: instruction.id,
    text: instruction.text,
    expect: instruction.expect.label,
    when,
    recognizedBy: instruction.minIdentification === 'strong' ? 'face, plate or code' : 'what the visitor says',
    say: instruction.say,
    open: instruction.open,
    openForAnyoneWhoNamesThemselves: instruction.openOnWeak ? true : undefined,
    neverOpen: instruction.neverOpen ? true : undefined,
    callOwner: instruction.callOwner,
    done: moment(intercom, instruction.doneAt),
    cancelled: moment(intercom, instruction.cancelledAt),
  };
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export async function callTool(intercom: Intercom, name: string, input: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  const actor = actorOf(ctx);
  try {
    switch (name) {
      case 'intercom_status': {
        const state = intercom.intercomState(actor);
        const now = intercom.now();
        return {
          content: {
            ...state,
            timeZone: intercom.timeZone(),
            localTime: moment(intercom, now),
            instructions: intercom.instructions(actor).map((i) => instructionLine(intercom, i)),
          },
        };
      }
      case 'intercom_visits': {
        const zone = intercom.timeZone();
        const q: VisitQuery = { limit: 20 };
        const today = localTime(intercom.now(), zone).date;
        q.from = parseMoment(input.from, zone) ?? parseMoment(`${today}T00:00`, zone);
        const to = parseMoment(input.to, zone);
        if (to !== undefined) q.to = to;
        const panels = intercom.intercomState(actor).panels as { id: string; name: string }[];
        const panelRef = text(input.panel);
        if (panelRef) {
          const panel = panels.find((p) => p.id === panelRef || p.name.toLowerCase() === panelRef.toLowerCase());
          if (!panel) return { error: `no panel "${panelRef}"; intercom_status lists them` };
          q.panelIds = [panel.id];
        }
        const personRef = text(input.person);
        if (personRef) {
          const person = intercom.peopleNames().find((p) => p.id === personRef || p.name.toLowerCase() === personRef.toLowerCase());
          if (!person) return { error: `no person "${personRef}"` };
          q.personIds = [person.id];
        }
        if (typeof input.category === 'string') q.categories = [input.category as Category];
        if (text(input.company)) q.companies = [text(input.company)!];
        if (typeof input.outcome === 'string') q.outcomes = [input.outcome as Outcome];
        if (input.opened === true) q.opened = true;
        if (input.hasMessage === true) q.hasMessage = true;
        if (text(input.text)) q.text = text(input.text);
        if (input.unseen === true) q.unseenBy = actor.userId;
        const page = intercom.visits(actor, q);
        const names = new Map(panels.map((p) => [p.id, p.name]));
        const references = page.visits.slice(0, 5).map(
          (visit) =>
            ({
              kind: 'intercom-visit',
              id: visit.id,
              label: `${names.get(visit.panelId) ?? ''} ${moment(intercom, visit.startedAt) ?? ''}`.trim(),
              timestamp: visit.startedAt,
            }) as unknown as AssistantToolReference,
        );
        return { content: { visits: page.visits.map((v) => visitLine(intercom, v, names)), more: page.hasMore }, references };
      }
      case 'intercom_add_instruction': {
        const { label, category, companies, names, people, plates, from, to, days, until, ...rest } = input;
        const when = days ? { days, from, to, until } : from !== undefined || to !== undefined ? { from, to } : undefined;
        const result = intercom.addInstruction(
          actor,
          { ...rest, expect: { label, category, companies, names, people, plates }, ...(when ? { when } : {}) },
          ctx.threadId,
        );
        return {
          content: {
            created: instructionLine(intercom, result.instruction),
            warnings: result.warnings.length ? result.warnings : undefined,
            guestCode: result.code ? { text: result.code.text, note: 'Shown once. It is a key: give it only to that guest.' } : undefined,
          },
        };
      }
      case 'intercom_instructions':
        return { content: intercom.instructions(actor, input.all === true).map((i) => instructionLine(intercom, i)) };
      case 'intercom_cancel_instruction':
        return { content: { cancelled: instructionLine(intercom, intercom.cancelInstruction(actor, String(input.id))) } };
      case 'intercom_set_mode': {
        const until = input.until === undefined ? undefined : parseMoment(input.until, intercom.timeZone());
        if (input.until !== undefined && until === undefined) return { error: 'until: a date and time' };
        const set = intercom.setMode(actor, String(input.mode), until);
        return { content: { mode: set.mode, until: moment(intercom, set.until) } };
      }
      case 'intercom_guest_code': {
        const made = intercom.createGuestCode(actor, input);
        return {
          content: {
            text: made.text,
            from: moment(intercom, made.code.from),
            to: moment(intercom, made.code.to),
            uses: made.code.maxUses,
            note: 'Shown once. It is a key: give it only to that guest.',
          },
        };
      }
      case 'intercom_open': {
        const panels = intercom.intercomState(actor).panels as { id: string; name: string; doors: { id: string; name: string }[] }[];
        const ref = text(input.panel) ?? '';
        const panel = panels.find((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase());
        if (!panel) return { error: `no panel "${ref}"; intercom_status lists them` };
        const doorRef = text(input.door);
        const door = doorRef ? panel.doors.find((d) => d.id === doorRef || d.name.toLowerCase() === doorRef.toLowerCase()) : panel.doors[0];
        if (!door) return { error: doorRef ? `no door "${doorRef}" at ${panel.name}` : `${panel.name} has no door` };
        const result = await intercom.openDoorAs(actor, panel.id, door.id);
        return { content: { door: door.name, result: result.result, error: result.error } };
      }
      case 'intercom_say': {
        const calls = (intercom.intercomState(actor).calls as { callId: string; panelId: string; panelName: string }[]) ?? [];
        const ref = text(input.panel);
        const matching = ref ? calls.filter((c) => c.panelId === ref || c.panelName.toLowerCase() === ref.toLowerCase()) : calls;
        if (!matching.length) return { error: 'no call is in progress' };
        if (matching.length > 1) return { error: `several calls: ${matching.map((c) => c.panelName).join(', ')}; name the panel` };
        await intercom.sayInCall(actor, matching[0].callId, text(input.text) ?? '', input.verbatim !== false);
        return { content: { said: true, panel: matching[0].panelName } };
      }
      case 'intercom_people':
        return { content: intercom.people(actor) };
      case 'intercom_set_person': {
        const result = intercom.setPerson(actor, input);
        return { content: { person: result.person, warnings: result.warnings.length ? result.warnings : undefined } };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (error) {
    if (error instanceof IntercomError) return { error: error.message };
    throw error;
  }
}
