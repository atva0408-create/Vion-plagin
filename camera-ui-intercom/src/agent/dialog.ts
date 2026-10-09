/**
 * The door agent's conversation, without sound: it is given what the visitor said and gives what to say back and what
 * to do. The plugin plays it through the panel's speaker and microphone (conversation.ts) and the "Talk to the agent"
 * page plays it in text.
 *
 * The LLM writes the phrases and reads who the visitor is out of their words; the code decides everything else:
 * - which instruction the visitor is (instructions.ts), and the message of an instruction is said as the owner wrote
 *   it, past the LLM, only once the visitor matched it well enough;
 * - whether a door opens (rules.ts): the LLM can only ask;
 * - emergencies and threats, also by words when the LLM misses them or is not there;
 * - how long it goes on.
 * Every LLM phrase is checked (check.ts); one that fails is replaced by the template of the step.
 */
import { localTime, spokenDigits } from '@vionvision/speech';

import { findCompany } from '../companies.js';
import { knownPerson } from '../identify.js';
import { enough, expectedKinds, matchInstruction } from '../instructions.js';
import { mayOpen } from '../rules.js';
import { allowedValues, sayProblem } from './check.js';
import { agentTexts, fill, soundsUrgent } from './texts.js';
import { TURN_SCHEMA, asTurn, systemPrompt, turnPrompt } from './turn.js';

import type { AssistantAskRequest, AssistantAskResult } from '@camera.ui/sdk';
import type { Clock, Language } from '@vionvision/speech';
import type { Candidate, Heard } from '../instructions.js';
import type { Category, GuestCode, Identification, Instruction, Outcome, Person, TranscriptLine } from '../types.js';
import type { AgentTexts, TextKey } from './texts.js';
import type { AgentTurn, TurnFacts } from './turn.js';

export type Ask = (request: AssistantAskRequest) => Promise<AssistantAskResult>;

export interface AgentWorld {
  language: Language;
  timeZone: string;
  clock: Clock;
  panel: { id: string; name: string; place?: string };
  /** the doors of the panel, the main one first */
  doors: { id: string; name: string }[];
  people: Person[];
  /** instructions of the panel that hold now */
  instructions: () => Instruction[];
  codes: () => GuestCode[];
  /** faces and plates of the visit, as they come */
  identifications: () => Identification[];
  /** what the camera shows, in words, when the snapshot was described */
  sees?: string;
  houseRules?: string;
  agentName?: string;
  greeting?: string;
  recordNotice: boolean;
  /** the LLM; undefined when the plugin may not ask it */
  ask?: Ask;
  /** digits said as a code or a PIN: an identification, 'locked' when the panel takes no codes now, else nothing */
  verifyDigits(digits: string): Identification | 'locked' | undefined;
  maxTurns: number;
  turnTimeoutMs: number;
  log?: (message: string) => void;
}

export type AgentAction =
  | { kind: 'open'; doorId: string; by: string; identification?: Identification }
  | { kind: 'ask_owner'; question: string; options: string[] }
  | { kind: 'emergency'; text: string }
  | { kind: 'threat'; text: string }
  | { kind: 'flag'; flag: 'probing' | 'manipulation' | 'blocked'; text: string }
  | { kind: 'instruction'; instructionId: string }
  | { kind: 'identified'; identification: Identification }
  | { kind: 'voicemail' };

export interface AgentReply {
  say?: string;
  actions: AgentAction[];
  /** listen for the visitor after the phrase */
  listen: boolean;
  /** the conversation is over, with this outcome */
  end?: Outcome;
}

type Phase = 'talk' | 'code' | 'owner' | 'message' | 'voicemail' | 'ended';

export interface VisitorInfo {
  name?: string;
  company?: string;
  category?: Category;
  purpose?: string;
  callback?: string;
}

const DAY_NAMES: Record<Language, Record<string, string>> = {
  ru: { mon: 'понедельник', tue: 'вторник', wed: 'среда', thu: 'четверг', fri: 'пятница', sat: 'суббота', sun: 'воскресенье' },
  en: { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' },
  de: { mon: 'Montag', tue: 'Dienstag', wed: 'Mittwoch', thu: 'Donnerstag', fri: 'Freitag', sat: 'Samstag', sun: 'Sonntag' },
};

export class DoorAgent {
  readonly transcript: TranscriptLine[] = [];
  readonly visitor: VisitorInfo = {};
  readonly messages: string[] = [];
  readonly flags = new Set<string>();
  /** the instruction the visitor turned out to be, once matched well enough */
  matched?: Candidate;
  private phase: Phase = 'talk';
  private turns = 0;
  private unclear = 0;
  private silences = 0;
  private codeTries = 0;
  private llmFailed = false;
  private waitedOnce = false;
  private opened = false;
  private voicemail = false;
  private delivered = new Set<string>();
  private questions: string[] = [];
  private localIds: Identification[] = [];
  private readonly texts: AgentTexts;

  constructor(private readonly world: AgentWorld) {
    this.texts = agentTexts(world.language);
  }

  get ended(): boolean {
    return this.phase === 'ended';
  }

  /** The waiting for the owner's answer (ask_owner), for the plugin's timer. */
  get waitingForOwner(): boolean {
    return this.phase === 'owner';
  }

  identifications(): Identification[] {
    return [...this.world.identifications(), ...this.localIds];
  }

  private t(key: TextKey, values: Record<string, string | undefined> = {}): string {
    return fill(this.texts[key], values);
  }

  private agentSays(text: string): void {
    if (text) this.transcript.push({ at: this.world.clock.now(), from: 'agent', text });
  }

  private reply(say: string | undefined, actions: AgentAction[] = [], end?: Outcome): AgentReply {
    if (say) this.agentSays(say);
    if (end) this.phase = 'ended';
    return { say, actions, listen: !end, end };
  }

  private outcome(): Outcome {
    if (this.opened) return 'opened';
    if (this.messages.length || this.voicemail) return 'message';
    return 'agent';
  }

  private known(): { person: Person; strength: 'weak' | 'strong' } | undefined {
    return knownPerson(this.identifications(), this.world.people);
  }

  private heard(): Heard {
    return { name: this.visitor.name, company: this.visitor.company, category: this.visitor.category };
  }

  // ---- the start ----

  async start(): Promise<AgentReply> {
    const known = this.known();
    if (known?.strength === 'strong' && known.person.role === 'blocked') {
      return this.reply(this.t('blocked'), [{ kind: 'flag', flag: 'blocked', text: known.person.name }], 'agent');
    }
    const own = this.world.greeting?.trim();
    const greeting = own !== undefined && own !== '' ? own : this.t(this.world.recordNotice ? 'greet' : 'greetNoRecord');
    const actions: AgentAction[] = [];
    // a face, plate or code known from the start may already be an instruction's visitor
    const delivered = this.deliver(actions);
    if (known?.strength === 'strong') {
      this.visitor.name = known.person.name;
      const hello = this.t('greetName', { name: known.person.name });
      return this.reply(`${hello} ${delivered ?? this.t('ownersCannotCome')}`, actions);
    }
    return this.reply(delivered ? `${greeting.split(/(?<=[.!?])\s/)[0]} ${delivered}` : greeting, actions);
  }

  // ---- what the visitor says ----

  async heardText(text: string): Promise<AgentReply> {
    if (this.phase === 'ended') return { actions: [], listen: false };
    const said = text.trim();
    if (said) this.transcript.push({ at: this.world.clock.now(), from: 'visitor', text: said });
    if (this.phase === 'voicemail') return this.voicemailDone(said);
    if (said.split(/\s+/).filter(Boolean).length < 1 || !/\p{L}|\d/u.test(said)) return this.notHeard();
    this.unclear = 0;
    this.silences = 0;
    this.turns++;
    const urgent = soundsUrgent(said, this.world.language);

    if (this.phase === 'owner') {
      if (urgent) return this.emergency(said, undefined);
      if (this.waitedOnce) return { actions: [], listen: true };
      this.waitedOnce = true;
      return this.reply(this.t('stillWaiting'));
    }
    if (this.phase === 'message') {
      this.messages.push(said);
      return this.reply(`${this.t('willPass')} ${this.t('goodbye')}`, [], 'message');
    }
    if (this.phase === 'code') {
      const digits = spokenDigits(said, this.world.language);
      if (digits) return this.code(digits);
      this.phase = 'talk';
    }
    if (this.turns > this.world.maxTurns) return this.reply(this.t('tooLong'), [], this.outcome());

    const turn = await this.llmTurn();
    if (!turn) return this.templateTurn(said, urgent);
    return this.withTurn(turn, said, urgent);
  }

  private notHeard(): AgentReply {
    this.unclear++;
    if (this.unclear >= 2) {
      this.phase = 'voicemail';
      return this.reply(this.t('voicemail'), [{ kind: 'voicemail' }]);
    }
    return this.reply(this.t('notHeard'));
  }

  /** Nobody spoke after a phrase. */
  silence(): AgentReply {
    if (this.phase === 'ended') return { actions: [], listen: false };
    if (this.phase === 'owner') return { actions: [], listen: true };
    if (this.phase === 'voicemail') return this.voicemailDone('');
    this.silences++;
    if (this.silences >= 2) {
      const anyone = this.transcript.some((line) => line.from === 'visitor');
      return this.reply(this.t('goodbye'), [], anyone ? this.outcome() : 'nobody');
    }
    return this.reply(this.t('areYouThere'));
  }

  /** The conversation went on too long: the closing phrase. */
  timeUp(): AgentReply {
    if (this.phase === 'ended') return { actions: [], listen: false };
    return this.reply(this.t('tooLong'), [], this.outcome());
  }

  /** The visitor left, or a person took the call over: the conversation ends without a phrase. */
  stop(outcome?: Outcome): Outcome {
    const result = outcome ?? (this.transcript.some((line) => line.from === 'visitor') ? this.outcome() : 'nobody');
    this.phase = 'ended';
    return result;
  }

  /** The voice message ended (its words as recognized; empty when nothing was understood). */
  voicemailDone(text: string): AgentReply {
    this.voicemail = true;
    if (text) this.messages.push(text);
    return this.reply(this.t('voicemailDone'), [], 'message');
  }

  // ---- the owner during the conversation ----

  /** The owner's words to the visitor (typed in the call card, or a quick answer): said as they are. */
  ownerSays(text: string, userId?: string): AgentReply {
    if (this.phase === 'ended') return { actions: [], listen: false };
    this.transcript.push({ at: this.world.clock.now(), from: 'owner', text, userId });
    if (this.phase === 'owner') this.phase = 'talk';
    // the owner's words, said as typed: they decide what the visitor hears; the transcript keeps them as the owner's
    return { say: text, actions: [], listen: true };
  }

  /** The owner did not answer the question in time. */
  ownerTimeout(): AgentReply {
    if (this.phase !== 'owner') return { actions: [], listen: !this.ended };
    this.phase = 'talk';
    return this.reply(this.t('ownerNoAnswer'));
  }

  // ---- the LLM ----

  private facts(goal: string): TurnFacts {
    const now = this.world.clock.now();
    const local = localTime(now, this.world.timeZone);
    const known = this.known();
    return {
      now: `${DAY_NAMES[this.world.language][local.day]} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
      panel: this.world.panel.name,
      place: this.world.panel.place,
      sees: this.world.sees,
      houseRules: this.world.houseRules?.trim() ? this.world.houseRules.trim() : undefined,
      expected: expectedKinds(this.world.instructions()),
      knownVisitor: known?.strength === 'strong' ? known.person.name : undefined,
      goal,
    };
  }

  private goal(): string {
    if (!this.visitor.name && !this.visitor.company && !this.visitor.purpose) return 'Find out who the visitor is and why they came.';
    if (!this.visitor.purpose) return 'Find out why the visitor came.';
    return 'The owners cannot come to the door now. Answer the visitor, take a message for the owners if they have one, say goodbye when done.';
  }

  private async llmTurn(): Promise<AgentTurn | undefined> {
    if (!this.world.ask || this.llmFailed) return undefined;
    try {
      const result = await this.world.ask({
        system: systemPrompt(this.world.language, this.world.agentName),
        prompt: turnPrompt(this.facts(this.goal()), this.transcript),
        outputSchema: TURN_SCHEMA,
        timeoutMs: this.world.turnTimeoutMs,
      });
      if (!result.ok) {
        this.world.log?.(`door agent: the LLM did not answer (${result.reason}), templates from now on`);
        this.llmFailed = true;
        return undefined;
      }
      let json = result.json;
      if (json === undefined) {
        try {
          json = JSON.parse(result.text);
        } catch {
          json = undefined;
        }
      }
      const turn = asTurn(json);
      if (!turn) this.world.log?.('door agent: the LLM answer is not a turn, the template is said');
      return turn;
    } catch (error) {
      this.world.log?.(`door agent: ${(error as Error).message}`);
      this.llmFailed = true;
      return undefined;
    }
  }

  /** The LLM's phrase if it passes the checks, else the template. */
  private checked(say: string, fallback: TextKey | string): string {
    const known = new Set(this.delivered);
    const forbidden = this.world
      .instructions()
      .filter((instruction) => !known.has(instruction.id) && instruction.say)
      .map((instruction) => instruction.say!);
    const allowed = allowedValues([
      this.facts('').now,
      this.world.panel.name,
      this.world.panel.place ?? '',
      this.world.houseRules ?? '',
      ...this.transcript.filter((line) => line.from !== 'agent').map((line) => line.text),
      ...this.world
        .instructions()
        .filter((instruction) => known.has(instruction.id))
        .map((instruction) => instruction.say ?? ''),
    ]);
    const problem = sayProblem(say, { language: this.world.language, allowed, forbidden });
    if (!problem) return say;
    this.world.log?.(`door agent: the LLM's phrase is not said (${problem}): ${say}`);
    return fallback in this.texts ? this.t(fallback as TextKey) : fallback;
  }

  // ---- the decisions ----

  private merge(visitor: Partial<AgentTurn['visitor']>): void {
    if (visitor.name) this.visitor.name = visitor.name;
    if (visitor.company) this.visitor.company = findCompany(visitor.company)?.name ?? visitor.company;
    const category = visitor.category === 'sales' ? 'other' : visitor.category;
    if (category) this.visitor.category = category;
    else if (this.visitor.company) this.visitor.category ??= findCompany(this.visitor.company)?.category;
    if (visitor.purpose) this.visitor.purpose = visitor.purpose;
    if (visitor.callback) this.visitor.callback = visitor.callback;
    if (visitor.message) this.messages.push(visitor.message);
  }

  /**
   * The message and doors of the instruction the visitor now matches well enough, said once; undefined when nothing to
   * say. A match that is not sure enough for what the instruction gives asks for the code.
   */
  private deliver(actions: AgentAction[]): string | undefined {
    const result = matchInstruction(this.world.instructions(), this.identifications(), this.heard());
    const best = result.best;
    if (!best || this.delivered.has(best.instruction.id)) return undefined;
    const instruction = best.instruction;
    if (!enough(best)) {
      // the visitor said who they are; what the instruction gives wants a face, a plate or a code
      if (this.world.codes().length || instruction.expect.guestCodeId) {
        this.phase = 'code';
        return this.t('askCode');
      }
      return undefined;
    }
    this.matched = best;
    this.delivered.add(instruction.id);
    if (best.identification) actions.push({ kind: 'identified', identification: best.identification });
    actions.push({ kind: 'instruction', instructionId: instruction.id });
    const parts: string[] = [];
    if (instruction.say) parts.push(this.t('deliver', { message: instruction.say }));
    for (const doorId of instruction.open ?? []) {
      const opened = this.tryOpen(doorId, actions);
      if (opened) parts.push(opened);
    }
    this.questions.push(...(instruction.ask ?? []));
    const question = this.questions.shift();
    if (question) parts.push(this.t('ask', { question }));
    return parts.join(' ') || undefined;
  }

  /** Opens the door if a rule allows it now: the phrase to say, or undefined when it may not. */
  private tryOpen(doorId: string, actions: AgentAction[]): string | undefined {
    const decision = mayOpen({
      doorId,
      now: this.world.clock.now(),
      timeZone: this.world.timeZone,
      identifications: this.identifications(),
      people: this.world.people,
      active: this.world.instructions(),
      candidate: this.matched,
      codes: this.world.codes(),
      heard: this.heard(),
    });
    if (!decision.ok) return undefined;
    actions.push({ kind: 'open', doorId, by: decision.by, identification: decision.identification });
    this.opened = true;
    const known = this.known();
    return known?.strength === 'strong' ? this.t('openName', { name: known.person.name }) : this.t('open');
  }

  /** The visitor asked to come in: a rule opens, or a code may, or the owners are asked. */
  private requestOpen(actions: AgentAction[]): string {
    const main = this.world.doors[0];
    if (main) {
      const opened = this.tryOpen(main.id, actions);
      if (opened) return opened;
    }
    if (this.world.codes().length && this.codeTries < 3) {
      this.phase = 'code';
      return this.t('askCode');
    }
    actions.push({ kind: 'ask_owner', question: this.ownerQuestion('asks to be let in'), options: ['open', 'leave_at_door', 'call_me', 'refuse'] });
    this.phase = 'owner';
    return `${this.t('cannotOpen').split(/(?<=[.!?])\s/)[0]} ${this.t('askingOwner')}`;
  }

  private ownerQuestion(fallback: string): string {
    const who = [this.visitor.name, this.visitor.company].filter(Boolean).join(', ');
    const what = this.visitor.purpose ?? fallback;
    return who ? `${who}: ${what}` : what;
  }

  private code(digits: string): AgentReply {
    this.codeTries++;
    const result = this.world.verifyDigits(digits);
    if (result === 'locked') {
      this.phase = 'talk';
      return this.reply(this.t('codesLocked'), [{ kind: 'ask_owner', question: this.ownerQuestion('came, codes are locked now'), options: ['open', 'refuse'] }]);
    }
    if (!result) {
      if (this.codeTries >= 3) {
        this.phase = 'talk';
        return this.reply(this.t('cannotOpen'), [{ kind: 'ask_owner', question: this.ownerQuestion('said a wrong code three times'), options: ['open', 'refuse'] }]);
      }
      return this.reply(this.t('wrongCode'));
    }
    this.phase = 'talk';
    this.localIds.push(result);
    const actions: AgentAction[] = [{ kind: 'identified', identification: result }];
    const delivered = this.deliver(actions);
    if (delivered) return this.reply(delivered, actions);
    // a code or PIN of its own, not of an instruction: it opens what it was given for
    for (const door of this.world.doors) {
      const opened = this.tryOpen(door.id, actions);
      if (opened) return this.reply(opened, actions);
    }
    return this.reply(this.t('cannotOpen'), actions);
  }

  private emergency(said: string, turn: AgentTurn | undefined): AgentReply {
    const actions: AgentAction[] = [];
    if (!this.flags.has('emergency')) {
      this.flags.add('emergency');
      actions.push({ kind: 'emergency', text: said });
    }
    const say = turn ? this.checked(turn.say, 'emergency') : this.t('emergency');
    return this.reply(say, actions);
  }

  /** Without the LLM: the template flow of the ТЗ (6.6), the service and urgency recognized by words. */
  private templateTurn(said: string, urgent: boolean): AgentReply {
    if (urgent) return this.emergency(said, undefined);
    const company = findCompany(said);
    if (company) this.merge({ company: company.name, category: company.category });
    this.visitor.purpose ??= said;
    const actions: AgentAction[] = [];
    const delivered = this.deliver(actions);
    if (delivered) return this.reply(delivered, actions);
    if (this.phase === 'code') return this.reply(this.t('askCode'), actions);
    this.messages.push(said);
    return this.reply(`${this.t('willPass')} ${this.t('goodbye')}`, actions, this.outcome());
  }

  private withTurn(turn: AgentTurn, said: string, urgent: boolean): AgentReply {
    this.merge(turn.visitor);
    if (turn.flags.emergency || urgent) return this.emergency(said, turn);
    if (turn.flags.threat) {
      this.flags.add('threat');
      return this.reply(this.t('threat'), [{ kind: 'threat', text: said }], this.outcome());
    }
    if (turn.visitor.category === 'sales') {
      this.flags.add('sales');
      return this.reply(this.t('sales'), [], 'agent');
    }

    const actions: AgentAction[] = [];
    for (const flag of ['probing', 'manipulation'] as const) {
      if (turn.flags[flag] && !this.flags.has(flag)) {
        this.flags.add(flag);
        actions.push({ kind: 'flag', flag, text: said });
      }
    }
    const delivered = this.deliver(actions);
    if (delivered) return this.reply(delivered, actions);
    if (this.phase === 'code') return this.reply(this.t('askCode'), actions);

    if (turn.intent === 'request_open') return this.reply(this.requestOpen(actions), actions);
    if (turn.flags.manipulation) return this.reply(this.checked(turn.say, 'manipulation'), actions);
    if (turn.flags.probing) return this.reply(this.checked(turn.say, 'probing'), actions);
    if (turn.intent === 'ask_owner') {
      actions.push({ kind: 'ask_owner', question: this.ownerQuestion(said), options: ['leave_at_door', 'call_me', 'refuse'] });
      this.phase = 'owner';
      return this.reply(this.t('askingOwner'), actions);
    }
    const question = this.questions.shift();
    if (question) return this.reply(this.t('ask', { question }), actions);
    if (turn.intent === 'goodbye') return this.reply(this.checked(turn.say, 'goodbye'), actions, this.outcome());
    if (turn.intent === 'message' && !turn.visitor.message) this.phase = 'message';
    return this.reply(this.checked(turn.say, this.visitor.purpose ? 'willPass' : 'askWho'), actions);
  }
}
