/**
 * A call of a panel, as a state machine: ringing → the agent or a person answers → ended. One function takes the call
 * and an event and gives the next call with what to do (stop the ringing, start or stop the agent, tell the
 * interfaces); the plugin does it and runs the timers. So every path is tested without timers or sound.
 *
 * Rules that hold here:
 * - the first who answers gets the call; the next is told who did;
 * - a press during a call is counted, it never starts a second call of the same panel;
 * - an ended call takes no events.
 */
import type { CallState, Outcome } from './types.js';

export interface Call {
  id: string;
  visitId: string;
  panelId: string;
  state: CallState;
  startedAt: number;
  /** users the panel rings */
  recipients: string[];
  declinedBy: string[];
  answeredBy?: string;
  answeredAt?: number;
  agentAt?: number;
  endedAt?: number;
  outcome?: Outcome;
  presses: number;
  /** presses of the last few seconds, for "insistent" */
  recentPresses: number[];
}

export type CallEvent =
  | { type: 'answer'; userId: string }
  | { type: 'decline'; userId: string }
  | { type: 'to_agent'; userId?: string }
  | { type: 'ring_timeout' }
  | { type: 'take_over'; userId: string }
  /** a rule opened the door while it rang: nobody needs to answer */
  | { type: 'auto_open' }
  | { type: 'hang_up'; outcome?: Outcome; userId?: string }
  | { type: 'press' }
  | { type: 'interrupted' };

export type Effect = 'ring_stop' | 'agent_start' | 'agent_stop' | 'update';

export interface StepResult {
  call: Call;
  effects: Effect[];
  /** why the event changed nothing */
  refused?: 'ended' | 'agent_off' | 'already_agent' | 'taken' | 'not_ringing';
  /** who has the call, when it was taken already */
  takenBy?: string;
  /** three presses within ten seconds: the visitor insists */
  insistent?: boolean;
}

/** In a call's recipients: every user (the panel calls 'all'); the notification then names nobody and reaches all. */
export const ALL_USERS = '*';

export const INSISTENT_PRESSES = 3;
export const INSISTENT_WINDOW_MS = 10_000;

export function newCall(id: string, visitId: string, panelId: string, recipients: string[], now: number): Call {
  return { id, visitId, panelId, state: 'ringing', startedAt: now, recipients, declinedBy: [], presses: 1, recentPresses: [now] };
}

export interface StepContext {
  now: number;
  /** whether the agent may answer this call (the mode, the agent's settings, a talk channel) */
  agentEnabled: boolean;
  /** the users of ViON, whom a call to "all" rings; unknown on a server that does not tell them */
  everyone?: readonly string[];
}

function end(call: Call, outcome: Outcome, now: number, effects: Effect[]): StepResult {
  return { call: { ...call, state: 'ended', outcome, endedAt: now }, effects: [...effects, 'update'] };
}

function toAgent(call: Call, now: number): StepResult {
  return { call: { ...call, state: 'agent', agentAt: now }, effects: ['ring_stop', 'agent_start', 'update'] };
}

function answered(call: Call, userId: string, now: number, effects: Effect[]): StepResult {
  return { call: { ...call, state: 'answered', answeredBy: userId, answeredAt: now }, effects: [...effects, 'update'] };
}

export function step(call: Call, event: CallEvent, ctx: StepContext): StepResult {
  const { now } = ctx;
  if (event.type === 'press') {
    if (call.state === 'ended') return { call, effects: [], refused: 'ended' };
    const recentPresses = [...call.recentPresses.filter((at) => now - at < INSISTENT_WINDOW_MS), now];
    const next = { ...call, presses: call.presses + 1, recentPresses };
    return { call: next, effects: [], insistent: recentPresses.length === INSISTENT_PRESSES };
  }
  if (call.state === 'ended') return { call, effects: [], refused: 'ended' };
  if (event.type === 'interrupted') return end(call, 'interrupted', now, call.state === 'agent' ? ['agent_stop'] : ['ring_stop']);

  switch (call.state) {
    case 'ringing':
      switch (event.type) {
        case 'answer':
        case 'take_over':
          return answered(call, event.userId, now, ['ring_stop']);
        case 'decline': {
          const declinedBy = call.declinedBy.includes(event.userId) ? call.declinedBy : [...call.declinedBy, event.userId];
          const declined = { ...call, declinedBy };
          // a call to "all" rings every user; with them unknown, the first decline speaks for all (one user is the common home)
          const ringing = call.recipients.includes(ALL_USERS) ? (ctx.everyone ?? declinedBy) : call.recipients;
          if (ringing.some((user) => !declinedBy.includes(user))) return { call: declined, effects: ['update'] };
          return ctx.agentEnabled ? toAgent(declined, now) : end(declined, 'declined', now, ['ring_stop']);
        }
        case 'to_agent':
          return ctx.agentEnabled ? toAgent(call, now) : { call, effects: [], refused: 'agent_off' };
        case 'ring_timeout':
          return ctx.agentEnabled ? toAgent(call, now) : end(call, 'missed', now, ['ring_stop']);
        case 'auto_open':
          return end(call, 'opened', now, ['ring_stop']);
        case 'hang_up':
          return end(call, event.outcome ?? 'nobody', now, ['ring_stop']);
      }
      break;
    case 'agent':
      switch (event.type) {
        case 'answer':
        case 'take_over':
          return answered(call, event.userId, now, ['agent_stop']);
        case 'hang_up':
          return end(call, event.outcome ?? 'agent', now, ['agent_stop']);
        case 'to_agent':
          return { call, effects: [], refused: 'already_agent' };
        default:
          // a decline or the end of ringing come late once the agent talks; a door opened by a rule does not end it
          return { call, effects: [], refused: 'not_ringing' };
      }
    case 'answered':
      switch (event.type) {
        case 'answer':
        case 'take_over':
          return event.userId === call.answeredBy ? { call, effects: [] } : { call, effects: [], refused: 'taken', takenBy: call.answeredBy };
        case 'hang_up':
          return end(call, event.outcome ?? 'answered', now, []);
        default:
          return { call, effects: [], refused: 'not_ringing' };
      }
  }
  return { call, effects: [], refused: 'not_ringing' };
}
