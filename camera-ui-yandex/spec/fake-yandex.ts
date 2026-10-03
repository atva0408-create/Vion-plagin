// A stand-in for the servers of Yandex the plugin talks to, reached through a replaced `fetch`: Passport with the QR
// sign-in and the x_token, Yandex ID with the code sign-in, the official Smart Home API, and the web API of the app
// with its CSRF token and cookies. It refuses what the real servers refuse: a request of the app without the
// cookies of the session, a change without the CSRF token, the official API without the token.

export const X_TOKEN = 'x-token-1';
export const OAUTH_TOKEN = 'oauth-1';
export const CSRF = 'csrf-1';
export const SESSION = 'sess-1';
export const STATION_TOKEN = 'music-1';

export interface Call {
  method: string;
  url: string;
  body?: any;
}

export interface FakeState {
  /** devices in the format of the protocol: the official list and the app list are made from them */
  devices: any[];
  scenarios: { id: string; name: string }[];
  /** times the QR status is asked before the app confirms */
  qrConfirmAfter: number;
  /** the code of the sign-in by code is confirmed */
  codeConfirmed: boolean;
  /** the session of the app ended: the next request of the app gets 401 */
  sessionEnded: boolean;
  stationHost?: { host: string; port: number };
  /** scenarios the plugin made, by id */
  own: Map<string, any>;
  /** scenarios run, by id */
  ran: string[];
  /** actions sent to devices */
  actions: { id: string; actions: any[] }[];
}

function ok(body: unknown, init: ResponseInit & { cookies?: string[] } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function cookie(init: RequestInit | undefined, name: string): string | undefined {
  const raw = new Headers(init?.headers).get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
}

function body(init: RequestInit | undefined): any {
  if (init?.body instanceof URLSearchParams) return Object.fromEntries(init.body);
  if (typeof init?.body === 'string') {
    try {
      return JSON.parse(init.body);
    } catch {
      return init.body;
    }
  }
  return undefined;
}

export function fakeYandex(state: FakeState): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let qrAsked = 0;
  let qrStarted = false;
  let nextScenario = 100;

  const handler = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname;

    // ---- Passport: QR sign-in
    if (url.host === 'passport.yandex.ru') {
      if (path === '/pwl-yandex') return new Response('<script>window.__CSRF__ = "qr-csrf";</script>', { headers: { 'set-cookie': 'yandexuid=1; Domain=.yandex.ru; Path=/' } });
      if (path === '/auth/session/') {
        if (url.searchParams.get('track_id') !== 'xtrack') return new Response('', { status: 400 });
        return new Response('', { status: 302, headers: { location: 'https://passport.yandex.ru/auth/finish?x=1', 'set-cookie': `Session_id=${SESSION}; Domain=.yandex.ru; Path=/` } });
      }
      if (headers.get('x-csrf-token') !== 'qr-csrf') return new Response('no csrf', { status: 403 });
      if (path.endsWith('/auth/password/submit')) return ok({ status: 'ok', track_id: 'track-1', csrf_token: 'x' });
      if (path.endsWith('/auth/magic/code')) {
        qrStarted = form(init).get('magic_track_id') === 'track-1';
        return ok({ status: 'ok', link: 'https://passport.yandex.ru/am/push/qrsecure?track_id=track-1' });
      }
      if (path.endsWith('/magic/code/status')) {
        if (!qrStarted) return ok({ status: 'error' });
        qrAsked++;
        return ok(qrAsked > state.qrConfirmAfter ? { status: 'ok', state: 'otp_auth_finished', trackId: 'track-1' } : { status: 'ok', state: 'otp_auth_waiting' });
      }
      if (path.endsWith('/sessions/get_session')) return ok({ status: 'ok' }, { cookies: [`Session_id=${SESSION}; Domain=.yandex.ru; Path=/`] });
    }

    // ---- mobile Passport: tokens
    if (url.host === 'mobileproxy.passport.yandex.net') {
      if (path === '/1/bundle/oauth/token_by_sessionid') {
        if (!(headers.get('ya-client-cookie') ?? '').includes(`Session_id=${SESSION}`)) return ok({ status: 'error', errors: ['sessionid.invalid'] });
        return ok({ access_token: X_TOKEN });
      }
      if (path === '/1/bundle/account/short_info/') {
        return headers.get('authorization') === `OAuth ${X_TOKEN}` ? ok({ status: 'ok', display_login: 'ivan', uid: 7 }) : ok({ status: 'error', errors: ['oauth_token.invalid'] });
      }
      if (path === '/1/bundle/auth/x_token/') {
        return headers.get('ya-consumer-authorization') === `OAuth ${X_TOKEN}`
          ? ok({ status: 'ok', passport_host: 'https://passport.yandex.ru', track_id: 'xtrack' })
          : ok({ status: 'error', errors: ['oauth_token.invalid'] });
      }
    }
    if (url.host === 'oauth.mobile.yandex.net' && path === '/1/token') {
      return form(init).get('access_token') === X_TOKEN ? ok({ access_token: STATION_TOKEN }) : ok({ error: 'invalid_grant' }, { status: 400 });
    }

    // ---- Yandex ID: sign-in by code
    if (url.host === 'oauth.yandex.ru') {
      const params = form(init);
      if (path === '/device/code') return ok({ device_code: 'dc-1', user_code: 'ABCD1234', verification_url: 'https://ya.ru/device', interval: 1, expires_in: 300 });
      if (path === '/token') {
        if (params.get('client_secret') !== 'secret') return ok({ error: 'invalid_client' }, { status: 400 });
        if (params.get('grant_type') === 'device_code') {
          if (!state.codeConfirmed) return ok({ error: 'authorization_pending' }, { status: 400 });
          return ok({ access_token: OAUTH_TOKEN, refresh_token: 'rt-1', expires_in: 31536000 });
        }
        if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'rt-1') return ok({ access_token: 'oauth-2', refresh_token: 'rt-2', expires_in: 31536000 });
        return ok({ error: 'invalid_grant' }, { status: 400 });
      }
    }

    // ---- official Smart Home API
    if (url.host === 'api.iot.yandex.net') {
      const auth = headers.get('authorization');
      if (auth !== `Bearer ${OAUTH_TOKEN}` && auth !== 'Bearer oauth-2') return ok({ status: 'error', message: 'unauthorized' }, { status: 401 });
      if (path === '/v1.0/user/info') {
        return ok({
          status: 'ok',
          request_id: 'r',
          rooms: [{ id: 'room-1', name: 'Прихожая', household_id: 'h1', devices: [] }],
          households: [{ id: 'h1', name: 'Дом' }],
          devices: state.devices.map((d) => ({ ...d, room: d.room ? 'room-1' : undefined, household_id: 'h1', quasar_info: undefined })),
          scenarios: state.scenarios.map((s) => ({ ...s, is_active: true })),
        });
      }
      if (path === '/v1.0/devices/actions') {
        const request = body(init);
        for (const device of request.devices) state.actions.push({ id: device.id, actions: device.actions });
        return ok({
          status: 'ok',
          devices: request.devices.map((d: any) => ({
            id: d.id,
            capabilities: d.actions.map((a: any) => ({
              type: a.type,
              state: {
                instance: a.state.instance,
                action_result: { status: 'DONE' },
                ...(a.type === 'devices.capabilities.video_stream' ? { value: { stream_url: `https://streaming.yandex/${d.id}.m3u8`, protocol: 'hls' } } : {}),
              },
            })),
          })),
        });
      }
      const run = /^\/v1\.0\/scenarios\/([^/]+)\/actions$/.exec(path);
      if (run) {
        state.ran.push(decodeURIComponent(run[1]!));
        return ok({ status: 'ok' });
      }
    }

    // ---- the page of the Smart Home with the CSRF token
    if (url.host === 'yandex.ru' && path === '/quasar') {
      if (cookie(init, 'Session_id') !== SESSION) return new Response('<html>guest</html>');
      return new Response(`<script>{"csrfToken2":"${CSRF}"}</script>`);
    }

    // ---- web API of the app
    if (url.host === 'iot.quasar.yandex.ru') {
      if (state.sessionEnded || cookie(init, 'Session_id') !== SESSION) {
        state.sessionEnded = false;
        return ok({ status: 'error' }, { status: 401 });
      }
      if (method !== 'GET' && headers.get('x-csrf-token') !== CSRF) return ok({ status: 'error' }, { status: 403 });
      if (path === '/m/v3/user/devices') {
        return ok({
          status: 'ok',
          updates_url: '',
          households: [
            {
              id: 'h1',
              name: 'Дом',
              all: state.devices.map((d) => ({ ...d, room_name: d.room ? 'Прихожая' : undefined, room: undefined })),
            },
            { id: 'h2', name: 'Чужой дом', sharing_info: { owner: 'x' }, all: [{ id: 'foreign', name: 'Чужая лампа', type: 'devices.types.light', capabilities: [], properties: [] }] },
          ],
        });
      }
      if (path === '/m/user/scenarios' && method === 'GET') {
        return ok({ status: 'ok', scenarios: [...state.scenarios.map((s) => ({ ...s, triggers: [] })), ...[...state.own.entries()].map(([id, s]) => ({ id, name: s.name, triggers: [{ type: 'scenario.trigger.voice', value: s.triggers[0].trigger.value }] }))] });
      }
      if (path === '/m/v4/user/scenarios' && method === 'POST') {
        const id = `own-${nextScenario++}`;
        state.own.set(id, body(init));
        return ok({ status: 'ok', scenario_id: id });
      }
      const put = /^\/m\/v4\/user\/scenarios\/([^/]+)$/.exec(path);
      if (put && method === 'PUT') {
        if (!state.own.has(put[1]!)) return ok({ status: 'error', message: 'not found' }, { status: 404 });
        state.own.set(put[1]!, body(init));
        return ok({ status: 'ok' });
      }
      const run = /^\/m\/user\/scenarios\/([^/]+)\/actions$/.exec(path);
      if (run && method === 'POST') {
        state.ran.push(run[1]!);
        return ok({ status: 'ok' });
      }
      const action = /^\/m\/user\/devices\/([^/]+)\/actions$/.exec(path);
      if (action && method === 'POST') {
        const request = body(init);
        state.actions.push({ id: action[1]!, actions: request.actions });
        const stream = request.actions.some((a: any) => a.type === 'devices.capabilities.video_stream');
        return ok({
          status: 'ok',
          devices: [{ id: action[1], capabilities: stream ? [{ type: 'devices.capabilities.video_stream', state: { instance: 'get_stream', value: { stream_url: `https://app-stream.yandex/${action[1]}.m3u8` } } }] : [] }],
        });
      }
    }

    // ---- the apps of the stations
    if (url.host === 'quasar.yandex.net') {
      if (headers.get('authorization') !== `OAuth ${STATION_TOKEN}`) return new Response('', { status: 403 });
      if (path === '/glagol/device_list') {
        return ok({
          status: 'ok',
          devices: state.devices
            .filter((d) => d.quasar_info)
            .map((d) => ({
              id: d.quasar_info.device_id,
              name: d.name,
              platform: d.quasar_info.platform,
              networkInfo: state.stationHost ? { ip_addresses: ['fe80::1', state.stationHost.host], external_port: state.stationHost.port } : undefined,
            })),
        });
      }
      if (path === '/glagol/token') return ok({ status: 'ok', token: `conv-${url.searchParams.get('device_id')}` });
    }

    return new Response(`unknown ${method} ${url}`, { status: 404 });
  };

  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: url.toString(), body: body(init) });
      return handler(url, init);
    }) as typeof fetch,
  };
}

export function baseDevices(): any[] {
  return [
    {
      id: 'motion-1',
      name: 'Датчик в прихожей',
      type: 'devices.types.sensor.motion',
      room: true,
      capabilities: [],
      properties: [
        { type: 'devices.properties.event', retrievable: true, reportable: true, parameters: { instance: 'motion' }, state: { instance: 'motion', value: 'not_detected' }, last_updated: 1000 },
        { type: 'devices.properties.float', retrievable: true, reportable: true, parameters: { instance: 'illumination', unit: 'unit.illumination.lux' }, state: { instance: 'illumination', value: 42 } },
      ],
    },
    {
      id: 'door-1',
      name: 'Входная дверь',
      type: 'devices.types.sensor.open',
      capabilities: [],
      properties: [{ type: 'devices.properties.event', parameters: { instance: 'open' }, state: { instance: 'open', value: 'closed' } }],
    },
    {
      id: 'button-1',
      name: 'Кнопка',
      type: 'devices.types.sensor.button',
      capabilities: [],
      properties: [{ type: 'devices.properties.event', parameters: { instance: 'button' }, state: { instance: 'button', value: 'click' }, last_updated: 1000 }],
    },
    {
      id: 'relay-1',
      name: 'Реле насоса',
      type: 'devices.types.switch.relay',
      capabilities: [{ type: 'devices.capabilities.on_off', retrievable: true, parameters: { split: false }, state: { instance: 'on', value: false } }],
      properties: [],
    },
    {
      id: 'lamp-1',
      name: 'Лампа',
      type: 'devices.types.light',
      capabilities: [
        { type: 'devices.capabilities.on_off', parameters: {}, state: { instance: 'on', value: true } },
        { type: 'devices.capabilities.range', parameters: { instance: 'brightness', unit: 'unit.percent' }, state: { instance: 'brightness', value: 60 } },
      ],
      properties: [],
    },
    {
      id: 'station-1',
      name: 'Станция',
      type: 'devices.types.smart_speaker.yandex.station.max',
      capabilities: [{ type: 'devices.capabilities.quasar', parameters: {}, state: null }],
      properties: [],
      quasar_info: { device_id: 'ST100', platform: 'yandexstation_2' },
    },
    {
      id: 'cam-1',
      name: 'Камера во дворе',
      type: 'devices.types.camera',
      capabilities: [{ type: 'devices.capabilities.video_stream', parameters: { protocols: ['hls'] }, state: null }],
      properties: [],
    },
  ];
}

export function baseState(patch: Partial<FakeState> = {}): FakeState {
  return {
    devices: baseDevices(),
    scenarios: [{ id: 'sc-1', name: 'Я ушёл' }],
    qrConfirmAfter: 1,
    codeConfirmed: false,
    sessionEnded: false,
    own: new Map(),
    ran: [],
    actions: [],
    ...patch,
  };
}
