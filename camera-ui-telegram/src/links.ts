import { randomBytes } from 'node:crypto';

import type { TgChat } from './bot.js';

/** A Telegram chat that gets the notifications of one VION user. */
export interface LinkedChat {
  /** `tg:<chat id>:<VION user id>`: one chat may be linked by two people of the home, each gets their own */
  id: string;
  ownerUserId: string;
  chatId: number;
  name: string;
  active: boolean;
  linkedAt: number;
}

/** A link handed to a VION user: the chat that opens the bot with it is theirs. */
export interface PendingLink {
  code: string;
  ownerUserId: string;
  expiresAt: number;
}

/** A link is good this long: a link sent around and opened later by someone else links nobody. */
export const LINK_TTL_MS = 15 * 60_000;
/** Links waiting at once at most: each «Connect» makes one. */
export const MAX_PENDING = 50;

export function newCode(): string {
  // /start takes [A-Za-z0-9_-], up to 64 characters
  return randomBytes(12).toString('base64url');
}

/** The code of `/start <code>` (also `/start@bot <code>`), undefined for any other text. */
export function startCode(text: string | undefined): string | undefined {
  const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})\s*$/.exec(text?.trim() ?? '');
  return match?.[1];
}

export function isStop(text: string | undefined): boolean {
  return /^\/stop(?:@\w+)?\s*$/.test(text?.trim() ?? '');
}

/** How a chat is named in the list of devices: a group by its title, a person by @name or their names. */
export function chatName(chat: TgChat): string {
  if (chat.title) return chat.title;
  if (chat.username) return `@${chat.username}`;
  return [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `Telegram ${chat.id}`;
}

export function chatDeviceId(chatId: number, ownerUserId: string): string {
  return `tg:${chatId}:${ownerUserId}`;
}

/** The links still good. */
export function fresh(pending: PendingLink[], now: number): PendingLink[] {
  return pending.filter((link) => link.expiresAt > now);
}

/**
 * A chat opened the bot with a code: linked to the user the code was made for (again when it was linked already,
 * switched on), the code used up. `unknown`: no such code, or it ran out.
 */
export function linkChat(
  chats: LinkedChat[],
  pending: PendingLink[],
  code: string,
  chat: TgChat,
  now: number,
): { chats: LinkedChat[]; pending: PendingLink[]; linked?: LinkedChat; reason?: 'unknown' } {
  const live = fresh(pending, now);
  const link = live.find((candidate) => candidate.code === code);
  if (!link) return { chats, pending: live, reason: 'unknown' };
  const id = chatDeviceId(chat.id, link.ownerUserId);
  const linked: LinkedChat = { id, ownerUserId: link.ownerUserId, chatId: chat.id, name: chatName(chat), active: true, linkedAt: now };
  return { chats: [...chats.filter((known) => known.id !== id), linked], pending: live.filter((candidate) => candidate !== link), linked };
}
