/** Time a request to Yandex may take. */
export const TIMEOUT_MS = 15_000;

/** Yandex refused the sign-in or the token: signing in again is needed. */
export class YandexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YandexAuthError';
  }
}

/** Yandex answered, but not with what was asked for. */
export class YandexApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'YandexApiError';
  }
}

/**
 * An error with what caused it, for the log: fetch says only "fetch failed" and keeps what happened (a name that does
 * not resolve, a refused connection) in `cause`. The query of an address in it is cut off: it can carry tokens.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    let text: string;
    let next: unknown;
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      text = current.message || (typeof code === 'string' ? code : current.name);
      // a connection tried on several addresses fails with all of them, the first one says enough
      next = current instanceof AggregateError && current.cause === undefined ? current.errors[0] : current.cause;
    } else {
      text = typeof current === 'string' ? current : JSON.stringify(current);
    }
    if (text && !parts.includes(text)) parts.push(text);
    current = next;
  }
  return parts.join(': ').replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, '$1?...');
}

/** The text of a WebSocket message, whichever way the library delivered it. */
export function messageText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

export function http(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
}

/** The JSON of an answer; a page instead of JSON is an error with the start of the page. */
export async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new YandexApiError(`Yandex answered ${res.status} without JSON: ${text.slice(0, 120)}`, res.status);
  }
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * The cookies of the Yandex sign-in. Passport sets them for .yandex.ru along redirects; every request to a host of
 * that domain carries them back. Kept as JSON in the storage of the plugin, so a restart needs no new sign-in.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(serialized?: string) {
    if (!serialized) return;
    try {
      for (const cookie of JSON.parse(serialized) as StoredCookie[]) {
        if (cookie?.name && typeof cookie.value === 'string' && cookie.domain) this.cookies.set(`${cookie.domain}|${cookie.name}`, cookie);
      }
    } catch {
      // a damaged value is a jar without cookies: the x_token signs in again
    }
  }

  absorb(res: Response, url: string): void {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let domain = host;
      let expired = false;
      for (const attribute of attributes) {
        const [key = '', raw = ''] = attribute.split('=');
        const k = key.trim().toLowerCase();
        const v = raw.trim();
        if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
        if (k === 'max-age' && Number(v) <= 0) expired = true;
        if (k === 'expires' && Date.parse(v) < Date.now()) expired = true;
      }
      const key = `${domain}|${name}`;
      if (expired || !value) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, domain });
    }
  }

  header(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    return [...this.cookies.values()]
      .filter((cookie) => host === cookie.domain || host.endsWith(`.${cookie.domain}`))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  get size(): number {
    return this.cookies.size;
  }

  clear(): void {
    this.cookies.clear();
  }

  serialize(): string {
    return JSON.stringify([...this.cookies.values()]);
  }
}
