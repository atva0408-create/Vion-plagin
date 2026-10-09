/**
 * Who may do what with the intercom. The server passes the user of the session as `actor` to every method that acts
 * (it guarantees the actor is real); the plugin decides by it. Until ViON has rights per camera, the intercom keeps its
 * own (ТЗ 5.3):
 * - every user may see the panels, answer and read the archive;
 * - opening a panel's doors: the admins and the users the panel lists;
 * - the mode: the admins and the users the settings list;
 * - panels, people, settings, deleting visits: the admins.
 */
import type { Panel } from './types.js';
import type { IntercomSettings } from './settings.js';

export interface Actor {
  userId: string;
  role: 'user' | 'admin' | 'master';
  /** the user's name, for the household's notifications and the visits ("Anna answered"); the assistant has none */
  name?: string;
}

export type ErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'unavailable';

/**
 * An error the server turns into an HTTP status: its message starts with the code ("forbidden: ..."), because only
 * the message crosses the plugin's RPC.
 */
export class IntercomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export const isAdmin = (actor: Actor) => actor.role === 'admin' || actor.role === 'master';

export function asActor(value: unknown): Actor {
  const a = (value ?? {}) as Record<string, unknown>;
  if (typeof a.userId !== 'string' || !a.userId || !['user', 'admin', 'master'].includes(a.role as string)) {
    throw new IntercomError('forbidden', 'no user');
  }
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, 64) : '';
  return { userId: a.userId, role: a.role as Actor['role'], ...(name ? { name } : {}) };
}

export function canOpen(actor: Actor, panel: Panel): boolean {
  return isAdmin(actor) || panel.openUserIds.includes(actor.userId);
}

export function canSetMode(actor: Actor, settings: IntercomSettings): boolean {
  return isAdmin(actor) || settings.modeUserIds.includes(actor.userId);
}

export function needAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new IntercomError('forbidden', 'only an administrator may do this');
}
