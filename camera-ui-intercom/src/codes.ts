/**
 * Guest codes and PINs: six digits given to a guest for a window, four to eight digits of a family member.
 *
 * Only a scrypt hash with its salt is kept; the code itself is shown to the owner once, to pass on. Guessing is bounded:
 * three tries in a visit, and five wrong ones on a panel within ten minutes close the panel to codes for ten minutes.
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

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

export function secretMatches(secret: string, hash: string, salt: string): boolean {
  const got = scryptSync(secret, salt, 32);
  const wanted = Buffer.from(hash, 'hex');
  return got.length === wanted.length && timingSafeEqual(got, wanted);
}

export function codeUsable(code: GuestCode, now: number): boolean {
  return !code.revokedAt && now >= code.from && now < code.to && code.uses < code.maxUses;
}

/** The guest code the digits are, among those usable now; a code that is right but used up or out of its window is not. */
export function findCode(codes: GuestCode[], digits: string, now: number): GuestCode | undefined {
  if (!/^\d+$/.test(digits)) return undefined;
  // every code is checked, so the time does not tell which one was close
  let found: GuestCode | undefined;
  for (const code of codes) if (secretMatches(digits, code.hash, code.salt) && codeUsable(code, now)) found ??= code;
  return found;
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
