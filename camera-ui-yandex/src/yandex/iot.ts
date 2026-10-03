// The official API of Yandex Smart Home for the owner of the account: devices, their state, commands and scenarios.
// A token of Yandex ID with the rights iot:view and iot:control opens it.
import { YandexApiError, YandexAuthError, http, json } from './http.js';
import { parseUserInfo } from './home.js';

import type { YHome } from './home.js';

export const IOT_URL = 'https://api.iot.yandex.net';
export const OAUTH_URL = 'https://oauth.yandex.ru';
export const IOT_SCOPES = 'iot:view iot:control';

export interface YAction {
  type: string;
  state: { instance: string; value: unknown; relative?: boolean };
}

export class YandexIot {
  constructor(private readonly token: () => Promise<string>) {}

  private async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await http(`${IOT_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new YandexAuthError('Yandex did not accept the token of the Smart Home API, sign in again');
    const answer = await json<T & { status?: string; message?: string }>(res);
    if (!res.ok || answer.status !== 'ok')
      throw new YandexApiError(`Smart Home API ${path} answered ${res.status}: ${answer.message ?? answer.status ?? ''}`.trim(), res.status);
    return answer;
  }

  async home(): Promise<YHome> {
    return parseUserInfo(await this.request('GET', '/v1.0/user/info'));
  }

  /** Runs commands on one device; a command the device refused is an error with its code. */
  async action(deviceId: string, actions: YAction[]): Promise<any> {
    const answer = await this.request('POST', '/v1.0/devices/actions', { devices: [{ id: deviceId, actions }] });
    const device = (answer.devices ?? []).find((d: any) => d.id === deviceId) ?? answer.devices?.[0];
    for (const capability of device?.capabilities ?? []) {
      const result = capability?.state?.action_result;
      if (result?.status === 'ERROR') throw new YandexApiError(`The device refused the command: ${result.error_code ?? 'error'}`);
    }
    return device;
  }

  async runScenario(id: string): Promise<void> {
    await this.request('POST', `/v1.0/scenarios/${encodeURIComponent(id)}/actions`);
  }

  /** The HLS address of a camera of the Smart Home, when the official API gives it. */
  async streamUrl(deviceId: string): Promise<string | undefined> {
    const device = await this.action(deviceId, [{ type: 'devices.capabilities.video_stream', state: { instance: 'get_stream', value: { protocols: ['hls'] } } }]);
    const state = device?.capabilities?.find((c: any) => c.type === 'devices.capabilities.video_stream')?.state;
    const url = state?.value?.stream_url ?? state?.action_result?.value?.stream_url;
    return typeof url === 'string' ? url : undefined;
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** The token is not there yet: the user has not entered the code. */
export class AuthorizationPending extends Error {
  constructor() {
    super('The code has not been confirmed yet');
    this.name = 'AuthorizationPending';
  }
}

/** The address a user opens to give the app the rights and see the token, for an app without a secret. */
export function tokenPageUrl(clientId: string): string {
  return `${OAUTH_URL}/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(IOT_SCOPES)}`;
}

/** Sign-in of Yandex ID by a code the user enters on another device: no address of ViON has to be reachable. */
export async function requestDeviceCode(clientId: string, deviceId: string): Promise<DeviceCode> {
  const res = await http(`${OAUTH_URL}/device/code`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, device_id: deviceId, device_name: 'ViON', scope: IOT_SCOPES }),
  });
  const body = await json<Record<string, any>>(res);
  if (!res.ok || !body.device_code) throw new YandexAuthError(`Yandex ID did not give a code: ${body.error_description ?? body.error ?? res.status}`);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url ?? 'https://ya.ru/device',
    intervalMs: Math.max(1, Number(body.interval) || 5) * 1000,
    expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000,
  };
}

/** Answers of Yandex ID that stay the same however often it is asked: the token or the app is refused. */
const REFUSALS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

async function tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
  const res = await http(`${OAUTH_URL}/token`, { method: 'POST', body: new URLSearchParams(params) });
  const body = await json<Record<string, any>>(res);
  if (body.error === 'authorization_pending' || body.error === 'slow_down') throw new AuthorizationPending();
  if (!body.access_token) {
    const message = `Yandex ID did not give a token: ${body.error_description ?? body.error ?? res.status}`;
    // a renewal Yandex ID refused is final, any other failure (an outage, a limit) is worth another try later
    throw REFUSALS.has(body.error) ? new YandexAuthError(message) : new YandexApiError(message, res.status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : undefined,
  };
}

export function exchangeDeviceCode(clientId: string, clientSecret: string, deviceCode: string): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: 'device_code', code: deviceCode, client_id: clientId, client_secret: clientSecret });
}

export function refreshOAuthToken(clientId: string, clientSecret: string, refreshToken: string): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
}
