import { createHash, randomBytes, randomInt } from 'node:crypto';

import { rc4 } from './rc4.js';
import { nonEmpty } from './text.js';

/**
 * The Mi Home cloud, as far as the cameras need it: signing in to a Mi account (with the captcha and the code sent to
 * the phone or the mailbox when Xiaomi asks for them), signing in again later with the token that sign-in gave, and
 * the encrypted requests of the Mi Home app. The cloud hands out the keys of a camera; the video itself goes from the
 * camera to the server over the local network.
 */

const ACCOUNT_URL = 'https://account.xiaomi.com';
/** The service the token is for: the one of the Mi Home app. */
const SERVICE_ID = 'xiaomiio';
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;

/** Regions of the Mi Home servers. An account keeps the devices of each region apart. */
export const REGIONS = ['cn', 'de', 'i2', 'ru', 'sg', 'us'] as const;
export type Region = (typeof REGIONS)[number];

export function apiBaseUrl(region: string): string {
  return region !== 'cn' && (REGIONS as readonly string[]).includes(region) ? `https://${region}.api.io.mi.com/app` : 'https://api.io.mi.com/app';
}

/** What Xiaomi wants before the sign-in goes on: the characters of a picture, or a code it sent. */
export type LoginChallenge = { kind: 'captcha'; image: string } | { kind: 'verify'; phone?: string; email?: string };

export class LoginChallengeError extends Error {
  constructor(public readonly challenge: LoginChallenge) {
    super(challenge.kind === 'captcha' ? 'Xiaomi asks for the characters from a picture' : 'Xiaomi asks for a confirmation code');
    this.name = 'LoginChallengeError';
  }
}

/** The account does not let this sign-in through: a wrong password, or a token Xiaomi no longer accepts. */
export class XiaomiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XiaomiAuthError';
  }
}

interface PendingLogin {
  username: string;
  password: string;
  ick?: string;
  captchaCode?: string;
  flag?: string;
  identitySession?: string;
}

const WRONG_PASSWORD = 70016;

function md5Upper(text: string): string {
  return createHash('md5').update(text).digest('hex').toUpperCase();
}

function randomAlnum(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

function cookiesOf(res: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return cookies;
}

/** The account server answers with JSON behind a marker; anything else is an error page. */
async function readLogin<T>(res: Response): Promise<T> {
  const text = await res.text();
  const marker = '&&&START&&&';
  if (!text.startsWith(marker)) throw new Error(`Xiaomi: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(marker.length)) as T;
}

function http(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function form(values: Record<string, string>): { body: string; headers: Record<string, string> } {
  return { body: new URLSearchParams(values).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}

/** Encryption of the Mi Home API: RC4 under a key made of the session secret and a nonce of the request. */
export function nonce(now = Date.now()): Buffer {
  const out = Buffer.alloc(12);
  randomBytes(8).copy(out);
  out.writeUInt32BE(Math.floor(now / 60_000), 8);
  return out;
}

export function signedNonce(ssecurity: Buffer, nonceBytes: Buffer): Buffer {
  return createHash('sha256').update(ssecurity).update(nonceBytes).digest();
}

export function signature(path: string, data: string, rc4Hash: string | undefined, key: Buffer): string {
  let s = `POST&${path}&data=${data}`;
  if (rc4Hash !== undefined) s += `&rc4_hash__=${rc4Hash}`;
  s += `&${key.toString('base64')}`;
  return createHash('sha1').update(s).digest('base64');
}

/** The form of an API request: the parameters encrypted and signed as the app does. */
export function encryptRequest(path: string, params: string, ssecurity: Buffer, nonceBytes = nonce()): { values: Record<string, string>; key: Buffer } {
  const key = signedNonce(ssecurity, nonceBytes);
  const hash = signature(path, params, undefined, key);
  const data = rc4(key, Buffer.from(params)).toString('base64');
  const rc4Hash = rc4(key, Buffer.from(hash)).toString('base64');
  return {
    key,
    values: { data, rc4_hash__: rc4Hash, signature: signature(path, data, rc4Hash, key), _nonce: nonceBytes.toString('base64') },
  };
}

/** Errors of the API that mean the session is gone: signing in again with the token helps. */
const AUTH_MESSAGE = /auth|token|login|session|signature/i;

function apiError(answer: { code?: unknown; message?: unknown }): Error {
  const message = typeof answer.message === 'string' ? answer.message : `code ${String(answer.code)}`;
  return AUTH_MESSAGE.test(message) ? new XiaomiAuthError(`Xiaomi ended the session: ${message}`) : new Error(`Xiaomi: ${message}`);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The result of an encrypted answer. An answer that does not decrypt was not made for this session (the API answers
 * an ended session in plain text, or with a key of its own): that is an authentication error, so the caller signs
 * in again instead of failing every request until someone signs in by hand.
 */
export function decryptResponse(body: string, key: Buffer): unknown {
  const answer = parseObject(rc4(key, Buffer.from(body.trim(), 'base64')).toString('utf8'));
  if (!answer || !('code' in answer)) {
    const plain = parseObject(body.trim());
    if (plain && 'code' in plain) throw apiError(plain);
    throw new XiaomiAuthError('Xiaomi sent an answer this session cannot read');
  }
  if (answer.code !== 0) throw apiError(answer);
  return answer.result;
}

export class XiaomiCloud {
  private ssecurity?: Buffer;
  private cookies = '';
  private userId = '';
  private passToken = '';
  private pending?: PendingLogin;

  /** The account and the token to store: with them the next start signs in without the password. */
  public credentials(): { userId: string; passToken: string } {
    return { userId: this.userId, passToken: this.passToken };
  }

  public get signedIn(): boolean {
    return !!this.ssecurity && !!this.cookies;
  }

  /** Signs in with the password. Throws LoginChallengeError when Xiaomi asks for a captcha or a code first. */
  public async login(username: string, password: string): Promise<void> {
    const start = await readLogin<{ qs: string; _sign: string; sid: string; callback: string }>(
      await http(`${ACCOUNT_URL}/pass/serviceLogin?_json=true&sid=${SERVICE_ID}`),
    );

    const values: Record<string, string> = {
      _json: 'true',
      hash: md5Upper(password),
      sid: start.sid,
      callback: start.callback,
      _sign: start._sign,
      qs: start.qs,
      user: username,
    };
    let cookies = `deviceId=${randomAlnum(16)}`;
    // the second try after a captcha
    if (this.pending?.captchaCode) {
      values.captCode = this.pending.captchaCode;
      cookies += `; ick=${this.pending.ick ?? ''}`;
    }

    const request = form(values);
    const res = await http(`${ACCOUNT_URL}/pass/serviceLoginAuth2`, {
      method: 'POST',
      body: request.body,
      headers: { ...request.headers, cookie: cookies },
      redirect: 'manual',
    });
    const answer = await readLogin<{
      ssecurity?: string;
      passToken?: string;
      location?: string;
      captchaURL?: string;
      notificationUrl?: string;
      code?: number;
      desc?: string;
    }>(res);

    this.pending = { username, password };

    if (answer.captchaURL) return this.captcha(answer.captchaURL);
    if (answer.notificationUrl) return this.startVerification(answer.notificationUrl);
    if (!answer.location) {
      if (answer.code === WRONG_PASSWORD) throw new XiaomiAuthError('Wrong account or password');
      throw new XiaomiAuthError(`Xiaomi refused the sign-in: ${answer.desc ?? answer.code ?? 'no reason given'}`);
    }

    this.pending = undefined;
    if (answer.ssecurity) this.ssecurity = Buffer.from(answer.ssecurity, 'base64');
    if (answer.passToken) this.passToken = answer.passToken;
    await this.finish(answer.location);
  }

  /** Goes on with the characters of the captcha picture. */
  public async loginWithCaptcha(code: string): Promise<void> {
    if (!this.pending?.ick) throw new Error('No sign-in is waiting for a captcha, start it again');
    this.pending.captchaCode = code;
    // a captcha on the way to the confirmation code
    if (this.pending.flag) return this.sendTicket();
    return this.login(this.pending.username, this.pending.password);
  }

  /** Goes on with the code Xiaomi sent to the phone or the mailbox of the account. */
  public async loginWithVerify(ticket: string): Promise<void> {
    if (!this.pending?.flag) throw new Error('No sign-in is waiting for a code, start it again');
    const params = new URLSearchParams({ _flag: this.pending.flag, ticket, trust: 'false', _json: 'true' });
    const res = await http(`${ACCOUNT_URL}/identity/auth/verify${this.verifyName()}?${params}`, {
      method: 'POST',
      headers: { cookie: `identity_session=${this.pending.identitySession ?? ''}` },
      redirect: 'manual',
    });
    const answer = await readLogin<{ location?: string; code?: number; desc?: string }>(res);
    if (!answer.location) throw new XiaomiAuthError(`The code was not accepted: ${answer.desc ?? answer.code ?? 'no reason given'}`);
    this.pending = undefined;
    await this.finish(answer.location);
  }

  /** Signs in with the stored token, no password and no confirmation needed. */
  public async loginWithToken(userId: string, passToken: string): Promise<void> {
    const res = await http(`${ACCOUNT_URL}/pass/serviceLogin?_json=true&sid=${SERVICE_ID}`, { headers: { cookie: `userId=${userId}; passToken=${passToken}` } });
    const answer = await readLogin<{ ssecurity?: string; passToken?: string; location?: string }>(res);
    if (!answer.location) throw new XiaomiAuthError('Xiaomi no longer accepts the stored sign-in, sign in again');
    this.userId = userId;
    this.passToken = nonEmpty(answer.passToken) ?? passToken;
    if (answer.ssecurity) this.ssecurity = Buffer.from(answer.ssecurity, 'base64');
    await this.finish(answer.location);
  }

  /** A request of the Mi Home API to the servers of `region`; the `result` of the answer. */
  public async request(region: string, path: string, params: string): Promise<unknown> {
    if (!this.ssecurity || !this.cookies) throw new XiaomiAuthError('Not signed in to Xiaomi');
    const { values, key } = encryptRequest(path, params, this.ssecurity);
    const request = form(values);
    const res = await http(apiBaseUrl(region) + path, { method: 'POST', body: request.body, headers: { ...request.headers, cookie: this.cookies } });
    if (res.status === 401 || res.status === 403) throw new XiaomiAuthError(`Xiaomi ended the session (${res.status})`);
    if (!res.ok) throw new Error(`Xiaomi: ${res.status} ${res.statusText}`);
    return decryptResponse(await res.text(), key);
  }

  private async captcha(captchaUrl: string): Promise<never> {
    const res = await http(ACCOUNT_URL + captchaUrl);
    const image = Buffer.from(await res.arrayBuffer());
    if (this.pending) this.pending.ick = cookiesOf(res).get('ick') ?? '';
    const type = nonEmpty(res.headers.get('content-type')?.split(';')[0]?.trim()) ?? 'image/jpeg';
    throw new LoginChallengeError({ kind: 'captcha', image: `data:${type};base64,${image.toString('base64')}` });
  }

  private async startVerification(notificationUrl: string): Promise<never> {
    const res = await http(notificationUrl.replace('/fe/service/identity/authStart', '/identity/list'));
    const answer = await readLogin<{ code?: number; flag?: number }>(res);
    if (this.pending) {
      this.pending.flag = String(answer.flag ?? '');
      this.pending.identitySession = cookiesOf(res).get('identity_session') ?? '';
    }
    return this.sendTicket();
  }

  /** Asks Xiaomi to send the code, then waits for it (LoginChallengeError). */
  private async sendTicket(): Promise<never> {
    const pending = this.pending;
    if (!pending?.flag) throw new Error('No sign-in is waiting for a code, start it again');
    const name = this.verifyName();
    let cookies = `identity_session=${pending.identitySession ?? ''}`;

    const target = await readLogin<{ code?: number; maskedPhone?: string; maskedEmail?: string }>(
      await http(`${ACCOUNT_URL}/identity/auth/verify${name}?_flag=${pending.flag}&_json=true`, { headers: { cookie: cookies } }),
    );

    // the code is asked for after a captcha
    if (pending.captchaCode) cookies += `; ick=${pending.ick ?? ''}`;
    const request = form({ _json: 'true', icode: pending.captchaCode ?? '', retry: '0' });
    const sent = await readLogin<{ code?: number; captchaURL?: string; desc?: string }>(
      await http(`${ACCOUNT_URL}/identity/auth/send${name}Ticket`, { method: 'POST', body: request.body, headers: { ...request.headers, cookie: cookies } }),
    );

    if (sent.captchaURL) return this.captcha(sent.captchaURL);
    if (sent.code !== 0) throw new Error(`Xiaomi could not send the code: ${sent.desc ?? sent.code ?? 'no reason given'}`);

    throw new LoginChallengeError({ kind: 'verify', phone: target.maskedPhone, email: target.maskedEmail });
  }

  private verifyName(): string {
    switch (this.pending?.flag) {
      case '4':
        return 'Phone';
      case '8':
        return 'Email';
      default:
        return '';
    }
  }

  /**
   * Follows the redirects that end a sign-in. Along them come the cookies of the session (userId, cUserId,
   * serviceToken), the token for the next sign-in (passToken) and, after a confirmation code, the secret of the
   * session in a header. The first answer that sets a value is the one that counts.
   */
  private async finish(location: string): Promise<void> {
    const hops: Response[] = [];
    let url = location;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await http(url, { redirect: 'manual' });
      hops.push(res);
      const next = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !next) break;
      await res.arrayBuffer().catch(() => undefined);
      url = new URL(next, url).toString();
    }

    let cUserId = '';
    let serviceToken = '';
    for (const res of [...hops].reverse()) {
      const cookies = cookiesOf(res);
      if (cookies.has('userId')) this.userId = cookies.get('userId')!;
      if (cookies.has('cUserId')) cUserId = cookies.get('cUserId')!;
      if (cookies.has('serviceToken')) serviceToken = cookies.get('serviceToken')!;
      if (cookies.has('passToken')) this.passToken = cookies.get('passToken')!;

      const pragma = res.headers.get('extension-pragma');
      if (pragma) {
        const { ssecurity } = JSON.parse(pragma) as { ssecurity?: string };
        if (ssecurity) this.ssecurity = Buffer.from(ssecurity, 'base64');
      }
    }

    if (!serviceToken || !this.userId || !this.ssecurity) throw new XiaomiAuthError('Xiaomi did not finish the sign-in, try again');
    this.cookies = `userId=${this.userId}; cUserId=${cUserId}; serviceToken=${serviceToken}`;
  }
}
