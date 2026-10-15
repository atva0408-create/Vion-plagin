import { escapeHtml } from './bot.js';

import type { Notification } from '@camera.ui/sdk';

/** Telegram's limits: the caption of a picture, the text of a message. */
export const CAPTION_MAX = 1024;
export const TEXT_MAX = 4096;

/**
 * A notification as Telegram shows it: the title bold, the subtitle and the text under it. Cut to `max` before the
 * text is escaped, so a cut never falls inside an escaped character, and the escaping cannot push it over: each of
 * <, > and & counts as its longest escape.
 */
export function messageOf(notification: Pick<Notification, 'title' | 'subtitle' | 'body'>, max: number): string {
  const title = notification.title.trim();
  const rest = [notification.subtitle, notification.body]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n');
  const room = (text: string) => text.length + (text.match(/[<>&]/g)?.length ?? 0) * 4;
  // the bold tags and the line between
  let budget = max - 8;
  const head = cut(title, budget, room);
  budget -= room(head) + 1;
  const tail = rest && budget > 1 ? cut(rest, budget, room) : '';
  return tail ? `<b>${escapeHtml(head)}</b>\n${escapeHtml(tail)}` : `<b>${escapeHtml(head)}</b>`;
}

function cut(text: string, budget: number, room: (text: string) => number): string {
  if (room(text) <= budget) return text;
  let end = Math.max(0, budget - 1);
  while (end > 0 && room(text.slice(0, end)) > budget - 1) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}
