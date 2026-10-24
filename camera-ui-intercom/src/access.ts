/**
 * Who may do what with the intercom. The server passes the user of the session as `actor` to every method that acts
 * (it guarantees the actor is real); the plugin decides by it, with the rights VION gives per camera (`cameraIds`,
 * `talk`) and its own (ТЗ 5.3):
 * - a user limited to some cameras has the panels of those cameras only: their calls, visits, doors, codes;
 * - every user may see the panels, answer (with the right to talk) and read the archive;
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
  /** the cameras of a user limited to some (VION's cameraAccess); absent: every camera */
  cameraIds?: string[];
  /** false: the user may not talk to a camera, so not answer a call or speak through a panel */
  talk?: boolean;
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
  const cameraIds = Array.isArray(a.cameraIds) ? a.cameraIds.filter((id): id is string => typeof id === 'string').slice(0, 1000) : undefined;
  return {
    userId: a.userId,
    role: a.role as Actor['role'],
    ...(name ? { name } : {}),
    // an admin is never limited, whatever was sent
    ...(cameraIds && !['admin', 'master'].includes(a.role as string) ? { cameraIds } : {}),
    ...(a.talk === false ? { talk: false } : {}),
  };
}

/** The panel is of a camera the user sees (a user not limited sees them all). */
export function seesPanel(actor: Actor, panel: Pick<Panel, 'cameraId'>): boolean {
  return !actor.cameraIds || actor.cameraIds.includes(panel.cameraId);
}

export function canOpen(actor: Actor, panel: Panel): boolean {
  return seesPanel(actor, panel) && (isAdmin(actor) || panel.openUserIds.includes(actor.userId));
}

export function needTalk(actor: Actor): void {
  if (actor.talk === false) throw new IntercomError('forbidden', 'you may not talk to the cameras');
}

export function canSetMode(actor: Actor, settings: IntercomSettings): boolean {
  return isAdmin(actor) || settings.modeUserIds.includes(actor.userId);
}

export function needAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new IntercomError('forbidden', 'only an administrator may do this');
}
