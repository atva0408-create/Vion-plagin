/**
 * The agent's own phrases (i18n/agent/<language>.json): what it says without the LLM, or when the LLM's phrase did not
 * pass the checks, and the words that make a visit urgent even when the LLM missed it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shippedDir } from '../runtime.js';

import type { Language } from '@vionvision/speech';

export interface AgentTexts {
  greet: string;
  greetNoRecord: string;
  greetName: string;
  askWho: string;
  askService: string;
  askCode: string;
  askPin: string;
  wrongCode: string;
  codesLocked: string;
  deliver: string;
  ask: string;
  open: string;
  openName: string;
  openFailed: string;
  cannotOpen: string;
  askingOwner: string;
  stillWaiting: string;
  ownerNoAnswer: string;
  ownersCannotCome: string;
  willPass: string;
  goodbye: string;
  notHeard: string;
  areYouThere: string;
  voicemail: string;
  voicemailDone: string;
  filler: string;
  emergency: string;
  threat: string;
  probing: string;
  manipulation: string;
  sales: string;
  blocked: string;
  tooLong: string;
  connecting: string;
  emergencyWords: string[];
}

export type TextKey = Exclude<keyof AgentTexts, 'emergencyWords'>;

const cache = new Map<Language, AgentTexts>();

export function agentTexts(language: Language): AgentTexts {
  let found = cache.get(language);
  if (!found) {
    const dir = join(shippedDir('i18n', join('agent', 'en.json')), 'agent');
    found = JSON.parse(readFileSync(join(dir, `${language}.json`), 'utf8')) as AgentTexts;
    cache.set(language, found);
  }
  return found;
}

export function fill(template: string, values: Record<string, string | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const fold = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** Whether the visitor's words name a danger (fire, someone unwell): whole words or phrases of the list. */
export function soundsUrgent(text: string, language: Language): boolean {
  const heard = fold(text);
  return agentTexts(language).emergencyWords.some((word) => heard.includes(fold(word)));
}
