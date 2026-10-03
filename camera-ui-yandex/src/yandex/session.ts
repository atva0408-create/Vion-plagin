// The sign-in to a Yandex account as the Yandex apps do it: a QR code confirmed in the Yandex app, or an x_token.
// It is not an official API of Yandex; it follows what the YandexStation integration does (see LICENSE.md).
import { CookieJar, YandexApiError, YandexAuthError, http, json } from './http.js';

export const PASSPORT_URL = 'https://passport.yandex.ru';
export const MOBILE_PROXY_URL = 'https://mobileproxy.passport.yandex.net';
export const MOBILE_OAUTH_URL = 'https://oauth.mobile.yandex.net';
export const QUASAR_PAGE_URL = 'https://yandex.ru/quasar';

// the applications the Yandex apps sign in as: one turns the cookies of the QR sign-in into an x_token,
// the other turns the x_token into the token the stations accept
const SESSION_CLIENT = { id: 'c0ebe342af7d48fbbbfcf2d2eedb8f9e', secret: 'ad0a908f0aa341a182a37ecd75bc319e' };
const STATION_CLIENT = { id: '23cabbbdc6cd418abb4b39c32c41195d', secret: '53bc75238f0c4d08a118e51fe9203300' };

/** Yandex asks for a pause between requests: the apps keep at least this much. */
const MIN_GAP_MS = 200;
const MAX_REDIRECTS = 10;

export interface SessionState {
  xToken?: string;
  cookies?: string;
  musicToken?: string;
}

export interface Account {
  login: string;
  uid?: string;
}

interface QrTrack {
  csrf: string;
  body: Record<string, unknown>;
}

export class YandexSession {
  readonly jar: CookieJar;
  xToken?: string;
  musicToken?: string;
  private csrf?: string;
  private qr?: QrTrack;
  private lastAt = 0;

  constructor(state: SessionState = {}) {
    this.jar = new CookieJar(state.cookies);
    this.xToken = state.xToken === '' ? undefined : state.xToken;
    this.musicToken = state.musicToken === '' ? undefined : state.musicToken;
  }

  get signedIn(): boolean {
    return !!this.xToken;
  }

  state(): SessionState {
    return { xToken: this.xToken, cookies: this.jar.serialize(), musicToken: this.musicToken };
  }

  /** A request with the cookies of the jar; redirects are followed here, so their cookies are kept. */
  async fetch(url: string, init: RequestInit = {}, follow = true): Promise<Response> {
    let current = url;
    let request = init;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers = new Headers(request.headers);
      const cookie = this.jar.header(current);
      if (cookie) headers.set('cookie', cookie);
      const res = await http(current, { ...request, headers });
      this.jar.absorb(res, current);
      const location = res.headers.get('location');
      if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
      current = new URL(location, current).toString();
      request = { method: 'GET' };
    }
    throw new YandexApiError(`Too many redirects from ${url}`);
  }

  /**
   * Starts the sign-in with a QR code. The link it gives is what the code shows: it is opened by the Yandex app
   * (scanned, or tapped on the phone signed in to Yandex), and the app asks to confirm the sign-in.
   */
  async startQr(): Promise<string> {
    this.qr = undefined;
    const page = await (await this.fetch(`${PASSPORT_URL}/pwl-yandex`)).text();
    const csrf = /__CSRF__ = "([^"]+)/.exec(page)?.[1];
    if (!csrf) throw new YandexApiError('Yandex did not open the QR sign-in, try again later');

    const submit = await this.fetch(`${PASSPORT_URL}/pwl-yandex/api/passport/auth/password/submit`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ retpath: `${PASSPORT_URL}/` }),
    });
    const body = await json<Record<string, unknown>>(submit);
    if (typeof body.track_id !== 'string') throw new YandexApiError('Yandex did not start the QR sign-in');

    const code = await this.fetch(`${PASSPORT_URL}/pwl-yandex/api/passport/auth/magic/code`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: new URLSearchParams({ location_id: '0', magic_track_id: body.track_id, track_id: '' }),
    });
    const link = (await json<{ link?: string }>(code)).link;
    if (!link) throw new YandexApiError('Yandex gave no QR code');
    this.qr = { csrf, body };
    return link;
  }

  get qrPending(): boolean {
    return !!this.qr;
  }

  /** True once the sign-in by the QR code is confirmed in the app; the x_token is then known. */
  async checkQr(): Promise<boolean> {
    const qr = this.qr;
    if (!qr) throw new YandexAuthError('The QR sign-in has not started');
    const res = await this.fetch(`${PASSPORT_URL}/pwl-yandex/api/passport/auth/magic/code/status`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': qr.csrf, 'content-type': 'application/json' },
      body: JSON.stringify(qr.body),
    });
    const status = await json<{ state?: string; trackId?: string }>(res);
    if (status.state !== 'otp_auth_finished' || !status.trackId) return false;

    await this.fetch(`${PASSPORT_URL}/pwl-yandex/api/passport/sessions/get_session`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': qr.csrf },
      body: new URLSearchParams({ track_id: status.trackId }),
    });
    this.qr = undefined;
    await this.xTokenFromCookies();
    return true;
  }

  /** The cookies of the browser session turned into an x_token, the token the Yandex apps keep. */
  private async xTokenFromCookies(): Promise<void> {
    const cookie = this.jar.header(`${PASSPORT_URL}/`);
    const res = await http(`${MOBILE_PROXY_URL}/1/bundle/oauth/token_by_sessionid`, {
      method: 'POST',
      headers: { 'Ya-Client-Host': 'passport.yandex.ru', 'Ya-Client-Cookie': cookie },
      body: new URLSearchParams({ client_id: SESSION_CLIENT.id, client_secret: SESSION_CLIENT.secret }),
    });
    const body = await json<{ access_token?: string }>(res);
    if (!body.access_token) throw new YandexAuthError('Yandex did not give a token for the confirmed sign-in');
    this.xToken = body.access_token;
    this.musicToken = undefined;
  }

  /** The account of the x_token; throws when Yandex does not accept the token. */
  async account(xToken = this.xToken): Promise<Account> {
    if (!xToken) throw new YandexAuthError('Not signed in to Yandex');
    const res = await http(`${MOBILE_PROXY_URL}/1/bundle/account/short_info/?avatar_size=islands-300`, {
      headers: { Authorization: `OAuth ${xToken}` },
    });
    const body = await json<{ status?: string; display_login?: string; uid?: number | string; errors?: string[] }>(res);
    if (body.status !== 'ok') throw new YandexAuthError(`Yandex did not accept the token: ${body.errors?.length ? body.errors.join(', ') : res.status}`);
    return { login: body.display_login ?? '', uid: body.uid !== undefined ? String(body.uid) : undefined };
  }

  /** Signs in with an x_token given by hand: it is checked, then the cookies of the account are made from it. */
  async useXToken(xToken: string): Promise<Account> {
    const account = await this.account(xToken);
    this.xToken = xToken;
    this.musicToken = undefined;
    this.jar.clear();
    this.csrf = undefined;
    await this.cookiesFromXToken();
    return account;
  }

  /** New browser cookies from the x_token, for when Yandex ended the old ones. */
  async cookiesFromXToken(): Promise<void> {
    if (!this.xToken) throw new YandexAuthError('Not signed in to Yandex');
    const res = await http(`${MOBILE_PROXY_URL}/1/bundle/auth/x_token/`, {
      method: 'POST',
      headers: { 'Ya-Consumer-Authorization': `OAuth ${this.xToken}` },
      body: new URLSearchParams({ type: 'x-token', retpath: 'https://www.yandex.ru' }),
    });
    const body = await json<{ status?: string; passport_host?: string; track_id?: string; errors?: string[] }>(res);
    if (body.status !== 'ok' || !body.passport_host || !body.track_id) {
      throw new YandexAuthError(`Yandex did not accept the token: ${body.errors?.length ? body.errors.join(', ') : 'no session'}`);
    }
    const finish = await this.fetch(`${body.passport_host}/auth/session/?track_id=${encodeURIComponent(body.track_id)}`, {}, false);
    const location = finish.headers.get('location') ?? '';
    if (!location.includes('/auth/finish')) throw new YandexAuthError('Yandex did not open a session for the token');
    this.csrf = undefined;
  }

  /** The token a station accepts on its local connection, made from the x_token. */
  async stationToken(): Promise<string> {
    if (this.musicToken) return this.musicToken;
    if (!this.xToken) throw new YandexAuthError('Not signed in to Yandex');
    const res = await http(`${MOBILE_OAUTH_URL}/1/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_secret: STATION_CLIENT.secret, client_id: STATION_CLIENT.id, grant_type: 'x-token', access_token: this.xToken }),
    });
    const body = await json<{ access_token?: string }>(res);
    if (!body.access_token) throw new YandexAuthError('Yandex did not give a token for the stations');
    this.musicToken = body.access_token;
    return this.musicToken;
  }

  /** A request to the apps of the stations, with the station token; a refused token is made anew once. */
  async glagol<T = any>(url: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.stationToken();
      const res = await http(url, { headers: { Authorization: `OAuth ${token}` } });
      if (res.status === 401 || res.status === 403) {
        this.musicToken = undefined;
        continue;
      }
      if (!res.ok) throw new YandexApiError(`${new URL(url).pathname} answered ${res.status}`, res.status);
      return json<T>(res);
    }
    throw new YandexAuthError('Yandex did not accept the token for the stations');
  }

  /**
   * A request to the web API of the Smart Home app. Everything but GET carries the CSRF token of the page;
   * an ended session is made anew from the x_token once, a stale CSRF token is read again once.
   */
  async quasar<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
    let renewed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pace();
      const headers: Record<string, string> = {};
      if (method !== 'GET') headers['x-csrf-token'] = await this.csrfToken();
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, false);
      if (res.status === 401 && !renewed) {
        renewed = true;
        await this.cookiesFromXToken();
        continue;
      }
      if (res.status === 403) {
        this.csrf = undefined;
        continue;
      }
      if (res.status === 401) throw new YandexAuthError('Yandex ended the session, sign in again');
      const answer = await json<T & { status?: string; message?: string }>(res);
      if (!res.ok || (answer.status && answer.status !== 'ok')) {
        throw new YandexApiError(`${new URL(url).pathname} answered ${res.status}: ${answer.message ?? answer.status ?? ''}`.trim(), res.status);
      }
      return answer;
    }
    throw new YandexApiError(`${new URL(url).pathname} kept refusing the request`);
  }

  private async csrfToken(): Promise<string> {
    if (this.csrf) return this.csrf;
    const page = await (await this.fetch(QUASAR_PAGE_URL)).text();
    const token = /"csrfToken2":"(.+?)"/.exec(page)?.[1];
    if (!token) {
      // the page without the token is the page of a visitor: the session has ended
      await this.cookiesFromXToken();
      const again = await (await this.fetch(QUASAR_PAGE_URL)).text();
      const retry = /"csrfToken2":"(.+?)"/.exec(again)?.[1];
      if (!retry) throw new YandexAuthError('Yandex did not open the Smart Home for this account');
      this.csrf = retry;
      return retry;
    }
    this.csrf = token;
    return token;
  }

  private async pace(): Promise<void> {
    const wait = this.lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastAt = Date.now();
  }
}
