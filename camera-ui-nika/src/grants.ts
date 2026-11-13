/**
 * What NIKA was asked to give (more time at the computer) goes through the parents. NIKA hears a voice, and a voice is
 * no proof of who speaks: a child who says «папа разрешил ещё час» in a deep voice must not get the hour. So by default
 * a parent confirms on the phone (a notification) or in VION, and NIKA tells the room what came of it. «direct» gives at
 * once and tells the parents what was given, for a home that wants it so.
 */
import { randomUUID } from 'node:crypto';

import { Severity } from '@camera.ui/sdk';

import { summaryOf } from './commands.js';
import { texts } from './texts.js';

import type { Notification } from '@camera.ui/sdk';
import type { CallResult } from './link.js';
import type { Message } from './protocol.js';
import type { Lang } from './texts.js';

export type GrantMode = 'confirm' | 'direct';
export const GRANT_MODES: GrantMode[] = ['confirm', 'direct'];

/** A request waits this long for a parent; then NIKA says nothing was given. */
export const GRANT_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 20;
export const JOURNAL_MAX = 100;
export const PLUGIN_PAGE = '/plugins/@vionvision/camera-ui-nika';

export interface PendingGrant {
  id: string;
  nikaId: string;
  nikaName: string;
  command: string;
  args: Record<string, unknown>;
  summary: string;
  speaker?: string;
  lang: Lang;
  at: number;
  expiresAt: number;
}

export type Outcome = 'done' | 'failed' | 'asked' | 'approved' | 'declined' | 'expired' | 'refused';

export interface JournalEntry {
  at: number;
  nika: string;
  summary: string;
  outcome: Outcome;
  detail?: string;
  speaker?: string;
  /** who answered a request: the page or the chat of the assistant */
  by?: string;
}

export interface GrantsHost {
  mode(): GrantMode;
  run(command: string, args: Record<string, unknown>, lang: Lang): Promise<CallResult>;
  publish(notification: Notification): Promise<void>;
  /** a message to a NIKA, when she is connected; false when she is not */
  tell(nikaId: string, message: Message): boolean;
  save(pending: PendingGrant[], journal: JournalEntry[]): Promise<void>;
  log(message: string): void;
  now(): number;
}

export interface Asker {
  id: string;
  name: string;
  lang: Lang;
}

export class Grants {
  pending: PendingGrant[];
  journal: JournalEntry[];

  constructor(
    private readonly host: GrantsHost,
    pending: PendingGrant[] = [],
    journal: JournalEntry[] = [],
  ) {
    this.pending = [...pending];
    this.journal = [...journal];
  }

  /** A granting command NIKA asked for. */
  async request(nika: Asker, command: string, args: Record<string, unknown>, speaker?: string): Promise<CallResult> {
    const t = texts(nika.lang);
    const summary = summaryOf(command, args, nika.lang);
    const base = { nika: nika.name, summary, ...(speaker ? { speaker } : {}) };
    if (this.host.mode() === 'direct') {
      const result = await this.host.run(command, args, nika.lang);
      await this.note({ ...base, outcome: result.ok ? 'done' : 'failed', ...(result.ok ? {} : { detail: result.error }) });
      if (result.ok) {
        await this.host
          .publish({
            title: t.doneTitle,
            body: t.doneBody(nika.name, summary, speaker),
            severity: Severity.Info,
            adminOnly: true,
            tag: `nika:done:${randomUUID()}`,
            deepLink: PLUGIN_PAGE,
          })
          .catch((error: Error) => this.host.log(`NIKA: the parents were not told what was given: ${error.message}`));
      }
      return result;
    }
    const now = this.host.now();
    const grant: PendingGrant = {
      id: randomUUID().slice(0, 8),
      nikaId: nika.id,
      nikaName: nika.name,
      command,
      args,
      summary,
      ...(speaker ? { speaker } : {}),
      lang: nika.lang,
      at: now,
      expiresAt: now + GRANT_TTL_MS,
    };
    // the same thing asked again replaces the request before it: one notification to answer, not two
    const same = (other: PendingGrant) => other.nikaId === grant.nikaId && other.command === command && JSON.stringify(other.args) === JSON.stringify(args);
    this.pending = [...this.pending.filter((other) => !same(other)), grant].slice(-MAX_PENDING);
    try {
      await this.host.publish({
        title: t.askTitle,
        body: t.askBody(nika.name, summary, speaker),
        severity: Severity.Warn,
        // for the parents only: a child's own account must not be the one that confirms
        adminOnly: true,
        tag: `nika:grant:${grant.id}`,
        deepLink: PLUGIN_PAGE,
        data: { nikaId: nika.id, request: grant.id },
      });
    } catch (error) {
      // nobody would know there is something to answer: the request is not kept
      this.pending = this.pending.filter((other) => other.id !== grant.id);
      await this.note({ ...base, outcome: 'failed', detail: (error as Error).message });
      return { ok: false, error: (error as Error).message };
    }
    await this.note({ ...base, outcome: 'asked' });
    return { ok: true, pending: true, text: t.asked(summary), data: { request: grant.id } };
  }

  /** A parent's answer. NIKA says it, when she is connected. */
  async decide(id: string, approved: boolean, by: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const grant = this.pending.find((other) => other.id === id);
    if (!grant) return { ok: false, error: 'There is no such request: it was answered or it expired.' };
    this.pending = this.pending.filter((other) => other !== grant);
    const t = texts(grant.lang);
    const base = { nika: grant.nikaName, summary: grant.summary, by, ...(grant.speaker ? { speaker: grant.speaker } : {}) };
    let text: string;
    if (approved) {
      const result = await this.host.run(grant.command, grant.args, grant.lang).catch((error: Error): CallResult => ({ ok: false, error: error.message }));
      // what VOICE says of the time now, after «allowed: …» (its «done: …» would say the same thing twice)
      const now = (result.data as { now?: unknown } | undefined)?.now;
      text = result.ok ? `${t.approved(grant.summary)}${typeof now === 'string' && now ? ` ${now}` : ''}` : t.failed(grant.summary, result.error ?? '');
      await this.note({ ...base, outcome: result.ok ? 'approved' : 'failed', ...(result.ok ? {} : { detail: result.error }) });
    } else {
      text = t.declined(grant.summary);
      await this.note({ ...base, outcome: 'declined' });
    }
    if (!this.host.tell(grant.nikaId, { t: 'decided', request: grant.id, approved, text })) {
      this.host.log(`NIKA ${grant.nikaName} is not connected: she was not told «${text}»`);
    }
    return { ok: true, text };
  }

  /** Requests nobody answered in time: NIKA says nothing was given. */
  async expire(): Promise<void> {
    const now = this.host.now();
    const gone = this.pending.filter((grant) => grant.expiresAt <= now);
    if (!gone.length) return;
    this.pending = this.pending.filter((grant) => grant.expiresAt > now);
    for (const grant of gone) {
      const text = texts(grant.lang).expired(grant.summary, Math.round(GRANT_TTL_MS / 60_000));
      await this.note({ nika: grant.nikaName, summary: grant.summary, outcome: 'expired', ...(grant.speaker ? { speaker: grant.speaker } : {}) });
      this.host.tell(grant.nikaId, { t: 'decided', request: grant.id, approved: false, text });
    }
  }

  async note(entry: Omit<JournalEntry, 'at'>): Promise<void> {
    this.journal = [{ at: this.host.now(), ...entry }, ...this.journal].slice(0, JOURNAL_MAX);
    await this.host.save(this.pending, this.journal);
  }

  /** A NIKA that is no longer paired asks for nothing any more. */
  async forget(nikaId: string): Promise<void> {
    const before = this.pending.length;
    this.pending = this.pending.filter((grant) => grant.nikaId !== nikaId);
    if (this.pending.length !== before) await this.host.save(this.pending, this.journal);
  }
}
