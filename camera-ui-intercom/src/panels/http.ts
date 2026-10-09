/**
 * Requests to a panel: always to its own host and port, with its login (HTTP digest as Dahua and Hikvision want it,
 * basic, or in the query as Akuvox and RUBITEK take it). Node's fetch knows no digest, so the challenge is answered
 * here (RFC 7616, MD5 or SHA-256, qop=auth).
 */
import { createHash, randomBytes } from 'node:crypto';

export type Auth = 'digest' | 'basic' | 'query' | 'none';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface PanelAddress {
  host: string;
  port: number;
  username: string;
  password: string;
  auth: Auth;
}

export interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
}

/** The digest challenge of a WWW-Authenticate header, if it is one. */
export function parseChallenge(header: string | null): Challenge | undefined {
  if (!header || !/^digest\s/i.test(header)) return undefined;
  const fields: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) fields[match[1].toLowerCase()] = match[2] ?? match[3];
  if (!fields.realm || !fields.nonce) return undefined;
  const qop = fields.qop
    ?.split(',')
    .map((q) => q.trim())
    .find((q) => q === 'auth');
  return { realm: fields.realm, nonce: fields.nonce, qop, opaque: fields.opaque, algorithm: (fields.algorithm ?? 'MD5').toUpperCase() };
}

/** The Authorization header answering a digest challenge for one request. */
export function digestHeader(challenge: Challenge, method: string, uri: string, username: string, password: string, cnonce = randomBytes(8).toString('hex')): string {
  const hashName = challenge.algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const h = (text: string) => createHash(hashName).update(text).digest('hex');
  const ha1 = h(`${username}:${challenge.realm}:${password}`);
  const ha2 = h(`${method}:${uri}`);
  const nc = '00000001';
  const response = challenge.qop ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`) : h(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`,
  ];
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export interface PanelRequest {
  method: 'GET' | 'PUT' | 'POST';
  /** the path of the request, credentials of the 'query' kind already in it */
  path: string;
  body?: string;
  contentType?: string;
  signal?: AbortSignal;
}

/** One request to the panel, answering a digest challenge when it comes. The response body is not read. */
export async function panelRequest(address: PanelAddress, request: PanelRequest, fetcher: Fetcher = fetch): Promise<Response> {
  if (!request.path.startsWith('/')) throw new Error('a request to a panel takes a path');
  const url = `http://${address.host}:${address.port}${request.path}`;
  const headers: Record<string, string> = {};
  if (request.contentType) headers['content-type'] = request.contentType;
  if (address.auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${address.username}:${address.password}`).toString('base64')}`;
  const init = (extra: Record<string, string> = {}): RequestInit => ({
    method: request.method,
    headers: { ...headers, ...extra },
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
  });
  const first = await fetcher(url, init());
  if (first.status !== 401 || address.auth !== 'digest') return first;
  const challenge = parseChallenge(first.headers.get('www-authenticate'));
  await first.body?.cancel().catch(() => undefined);
  if (!challenge) return first;
  return fetcher(url, init({ authorization: digestHeader(challenge, request.method, request.path, address.username, address.password) }));
}

/** The text of a response, at most `limit` bytes (a panel answering with a page of HTML must not fill the memory). */
export async function readText(response: Response, limit = 64 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}
