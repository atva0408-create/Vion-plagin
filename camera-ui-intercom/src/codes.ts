/**
 * Guest codes and PINs: six digits given to a guest for a window, four to eight digits of a family member.
 *
 * Only a scrypt hash with its salt is kept; the code itself is shown to the owner once, to pass on. Guessing is bounded:
 * three tries in a visit, and five wrong ones on a panel within ten minutes close the panel to codes for ten minutes.
 */
import { createHash, randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { GuestCode } from './types.js';

export const CODE_LENGTH = 6;
export const TRIES_PER_VISIT = 3;
export const WRONG_PER_PANEL = 5;
export const PANEL_WINDOW_MS = 10 * 60_000;
export const PANEL_LOCK_MS = 10 * 60_000;

export function newCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export function hashSecret(secret: string, salt = randomBytes(16).toString('hex')): { hash: string; salt: string } {
  return { hash: scryptSync(secret, salt, 32).toString('hex'), salt };
}

const scryptAsync = promisify(scrypt) as (secret: string, salt: string, length: number) => Promise<Buffer>;

/**
 * Whether the secret is the one hashed. scrypt runs in the thread pool, not on the plugin's event loop: a check takes
 * tens of milliseconds, and the event loop also paces the sound of SIP calls.
 */
export async function secretMatches(secret: string, hash: string, salt: string): Promise<boolean> {
  const got = await scryptAsync(secret, salt, 32);
  const wanted = Buffer.from(hash, 'hex');
  return got.length === wanted.length && timingSafeEqual(got, wanted);
}

/**
 * The hash of a token of 128 random bits (a panel's hook address): a fast hash is enough for it, and the address can be
 * called by anyone, so a slow one would let them load the plugin.
 */
export function tokenHash(token: string, panelId: string): string {
  return `sha256:${createHash('sha256').update(`${panelId}:${token}`).digest('hex')}`;
}

export function tokenMatches(token: string, panelId: string, stored: string): boolean {
  const got = Buffer.from(tokenHash(token, panelId));
  const wanted = Buffer.from(stored);
  return got.length === wanted.length && timingSafeEqual(got, wanted);
}

export function codeUsable(code: GuestCode, now: number): boolean {
  return !code.revokedAt && now >= code.from && now < code.to && code.uses < code.maxUses;
}

/** The guest code the digits are, among those usable now; a code that is right but used up or out of its window is not. */
export async function findCode(codes: GuestCode[], digits: string, now: number): Promise<GuestCode | undefined> {
  if (!/^\d+$/.test(digits)) return undefined;
  // every code is checked, so the time does not tell which one was close; together, in the thread pool
  const matches = await Promise.all(codes.map((code) => secretMatches(digits, code.hash, code.salt)));
  return codes.find((code, index) => matches[index] && codeUsable(code, now));
}

/** Wrong codes said at the panels: a panel that had too many lately does not take codes for a while. */
export class CodeGuard {
  private wrong = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();

  locked(panelId: string, now: number): boolean {
    return (this.lockedUntil.get(panelId) ?? 0) > now;
  }

  /** Records a wrong code; true when this one closed the panel to codes. */
  fail(panelId: string, now: number): boolean {
    const recent = (this.wrong.get(panelId) ?? []).filter((at) => now - at < PANEL_WINDOW_MS);
    recent.push(now);
    this.wrong.set(panelId, recent);
    if (recent.length >= WRONG_PER_PANEL) {
      this.lockedUntil.set(panelId, now + PANEL_LOCK_MS);
      this.wrong.set(panelId, []);
      return true;
    }
    return false;
  }

  succeed(panelId: string): void {
    this.wrong.delete(panelId);
  }
}
