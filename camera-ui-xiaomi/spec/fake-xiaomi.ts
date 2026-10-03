// A stand-in for the Mi account server and the Mi Home API, reached through a replaced `fetch`. It answers the way
// the real servers answer the sign-in of the Mi Home app (the JSON behind &&&START&&&, cookies along redirects, the
// secret of the session in a header after a confirmation code) and decrypts each API request with the session
// secret, as the real API does: a request the plugin encrypts or signs wrongly is refused here as well.
import { createHash } from 'node:crypto';

import { rc4 } from '../src/xiaomi/rc4.js';
import { signature, signedNonce } from '../src/xiaomi/cloud.js';

export const PASSWORD = 'Mi-Pass-1';
export const CAPTCHA = 'K7Q2';
export const TICKET = '481516';
export const SSECURITY = Buffer.from('fake-ssecurity-16');
export const CAPTCHA_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

export interface Scenario {
  captcha?: boolean;
  /** a captcha before the code is sent, after the password was accepted */
  ticketCaptcha?: boolean;
  /** how the account server names the captcha address: `captchaUrl` (default) or `captchaURL` */
  captchaField?: string;
  /** the captcha address whole, with the host, instead of relative to the account server */
  captchaAbsolute?: boolean;
  verify?: boolean;
  /** devices per region, as the device list gives them */
  devices: Record<string, Record<string, unknown>[]>;
  /** answers of miss_get_vendor per did; an Error is sent back as the API's error */
  vendors?: Record<string, Record<string, unknown> | Error>;
  devicepass?: Record<string, Record<string, unknown>>;
  /** passTokens the account accepts */
  tokens: Set<string>;
  /** how an ended session is answered: HTTP 401 (default), or 200 with an error in plain JSON */
  endedSession?: 'status' | 'plain';
  /** milliseconds the device list takes */
  deviceListDelayMs?: number;
  /** the error the API answers a wake-up of a door viewer with */
  wakeUpError?: string;
  /** MIoT values of the devices, by `did.siid.piid`; a set changes them */
  miot?: Record<string, unknown>;
  /** the specs miot-spec.org has, by their type, and its list of released ones */
  specs?: Record<string, unknown>;
  instances?: { model: string; type: string; version: number }[];
}

export interface Call {
  url: string;
  path?: string;
  params?: unknown;
}

const START = '&&&START&&&';

function login(body: unknown, init: ResponseInit & { cookies?: string[] } = {}): Response {
  const headers = new Headers(init.headers);
  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(START + JSON.stringify(body), { status: init.status ?? 200, headers });
}

function cookie(init: RequestInit | undefined, name: string): string | undefined {
  const raw = new Headers(init?.headers).get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export function fakeXiaomi(scenario: Scenario): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let captchaSolved = false;
  let ticketCaptchaSolved = false;
  let ticketSent = false;
  const captcha = (type: string) => {
    const path = `/pass/getCode?icodeType=${type}`;
    return { code: 87001, [scenario.captchaField ?? 'captchaUrl']: scenario.captchaAbsolute ? `https://account.xiaomi.com${path}` : path };
  };

  const api = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    if (cookie(init, 'serviceToken') !== 'ST' || cookie(init, 'userId') !== '42') {
      if (scenario.endedSession === 'plain') return new Response(JSON.stringify({ code: 2, message: 'auth err' }));
      return new Response('unauthorized', { status: 401 });
    }
    const form = new URLSearchParams(String(init?.body));
    const path = url.pathname.replace(/^\/app/, '');
    const key = signedNonce(SSECURITY, Buffer.from(form.get('_nonce') ?? '', 'base64'));
    const data = form.get('data') ?? '';
    const rc4Hash = form.get('rc4_hash__') ?? '';
    if (form.get('signature') !== signature(path, data, rc4Hash, key)) return new Response('bad signature', { status: 403 });
    const params = rc4(key, Buffer.from(data, 'base64')).toString('utf8');
    if (rc4(key, Buffer.from(rc4Hash, 'base64')).toString('utf8') !== signature(path, params, undefined, key)) return new Response('bad hash', { status: 403 });

    const parsed = JSON.parse(params) as Record<string, unknown>;
    calls.push({ url: url.toString(), path, params: parsed });
    const region = url.hostname === 'api.io.mi.com' ? 'cn' : url.hostname.split('.')[0]!;

    let result: unknown = null;
    let error: string | undefined;
    if (path === '/v2/home/device_list_page') {
      if (scenario.deviceListDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.deviceListDelayMs));
      const list = scenario.devices[region];
      if (!list) return new Response('region down', { status: 502 });
      result = { list, has_more: false };
    } else if (path === '/v2/device/miss_get_vendor') {
      const answer = scenario.vendors?.[String(parsed.did)];
      if (answer instanceof Error) error = answer.message;
      else result = answer;
    } else if (path === '/device/devicepass') {
      result = scenario.devicepass?.[String(parsed.did)];
    } else if (path === '/miotspec/prop/get' || path === '/miotspec/prop/set') {
      const values = (scenario.miot ??= {});
      result = ((parsed.params ?? []) as { did: string; siid: number; piid: number; value?: unknown }[]).map((item) => {
        const key = `${item.did}.${item.siid}.${item.piid}`;
        if (!(key in values)) return { ...item, code: -4003 };
        if (path === '/miotspec/prop/set') values[key] = item.value;
        return { did: item.did, siid: item.siid, piid: item.piid, code: 0, ...(path === '/miotspec/prop/get' ? { value: values[key] } : {}) };
      });
    } else if (path === '/miotspec/action') {
      result = { code: 0, out: [] };
    } else if (path.startsWith('/home/rpc/')) {
      if (scenario.wakeUpError) error = scenario.wakeUpError;
      else result = { code: 0 };
    }
    const plain = JSON.stringify(error ? { code: -1, message: error } : { code: 0, message: 'ok', result });
    return new Response(rc4(key, Buffer.from(plain)).toString('base64'));
  };

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname.endsWith('api.io.mi.com') && url.pathname.startsWith('/app/')) return api(url, init);
    calls.push({ url: url.toString() });

    if (url.hostname === 'account.xiaomi.com') {
      switch (url.pathname) {
        case '/pass/serviceLogin': {
          const token = cookie(init, 'passToken');
          if (token !== undefined) {
            if (!scenario.tokens.has(token)) return login({ qs: '%3Fsid', _sign: 'S', sid: 'xiaomiio', callback: 'https://sts.api.io.mi.com/sts' });
            return login({ ssecurity: SSECURITY.toString('base64'), passToken: token, location: 'https://sts.api.io.mi.com/sts?token=1' });
          }
          return login({ qs: '%3Fsid', _sign: 'S', sid: 'xiaomiio', callback: 'https://sts.api.io.mi.com/sts' });
        }
        case '/pass/serviceLoginAuth2': {
          const form = new URLSearchParams(String(init?.body));
          if (form.get('_sign') !== 'S' || form.get('sid') !== 'xiaomiio' || !cookie(init, 'deviceId')) return new Response('bad request', { status: 400 });
          if (form.get('hash') !== createHash('md5').update(PASSWORD).digest('hex').toUpperCase()) return login({ code: 70016, desc: 'wrong password' });
          if (scenario.captcha && !captchaSolved) {
            if (form.get('captCode') === CAPTCHA && cookie(init, 'ick') === 'ICK1') captchaSolved = true;
            else return login(captcha('login'));
          }
          if (scenario.verify) return login({ code: 0, notificationUrl: 'https://account.xiaomi.com/fe/service/identity/authStart?sid=xiaomiio' });
          return login({ code: 0, ssecurity: SSECURITY.toString('base64'), passToken: 'PT1', location: 'https://sts.api.io.mi.com/sts?d=1' });
        }
        case '/pass/getCode':
          return new Response(CAPTCHA_IMAGE, {
            headers: [
              ['content-type', 'image/jpeg'],
              ['set-cookie', 'ick=ICK1; Path=/'],
            ],
          });
        case '/identity/list':
          return login({ code: 0, flag: 4 }, { cookies: ['identity_session=IS1; Path=/'] });
        case '/identity/auth/verifyPhone':
          if (cookie(init, 'identity_session') !== 'IS1' || url.searchParams.get('_flag') !== '4') return new Response('bad session', { status: 400 });
          if (init?.method !== 'POST') return login({ code: 0, maskedPhone: '+7*****12' });
          if (!ticketSent) return login({ code: 70014, desc: 'no code sent' });
          if (url.searchParams.get('ticket') !== TICKET) return login({ code: 70014, desc: 'wrong code' });
          return login({ code: 0, location: 'https://sts.api.io.mi.com/sts?v=1' });
        case '/identity/auth/sendPhoneTicket': {
          if (cookie(init, 'identity_session') !== 'IS1') return new Response('bad session', { status: 400 });
          if (scenario.ticketCaptcha && !ticketCaptchaSolved) {
            const form = new URLSearchParams(String(init?.body));
            if (form.get('icode') === CAPTCHA && cookie(init, 'ick') === 'ICK1') ticketCaptchaSolved = true;
            else return login(captcha('antispam'));
          }
          ticketSent = true;
          return login({ code: 0 });
        }
      }
    }

    if (url.hostname === 'sts.api.io.mi.com') {
      // the first hop sets the session; after a code the secret comes in a header, not in the sign-in answer
      const headers = new Headers({ location: 'https://api.io.mi.com/sts/done' });
      for (const value of ['userId=42; Path=/', 'cUserId=c42; Path=/', 'serviceToken=ST; Path=/']) headers.append('set-cookie', value);
      if (url.searchParams.has('v')) {
        headers.append('set-cookie', 'passToken=PT-VERIFIED; Path=/');
        headers.set('extension-pragma', JSON.stringify({ ssecurity: SSECURITY.toString('base64') }));
      }
      return new Response(null, { status: 302, headers });
    }
    if (url.hostname === 'api.io.mi.com' && url.pathname === '/sts/done') return new Response('ok');

    if (url.hostname === 'miot-spec.org') {
      if (url.pathname === '/miot-spec-v2/instances') return Response.json({ instances: scenario.instances ?? [] });
      const spec = scenario.specs?.[url.searchParams.get('type') ?? ''];
      if (url.pathname === '/miot-spec-v2/instance' && spec) return Response.json(spec);
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    return new Response(`unexpected ${url}`, { status: 404 });
  };

  return { fetch: handler as typeof fetch, calls };
}
