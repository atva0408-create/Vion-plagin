/**
 * SIP messages and SDP, as much as a panel that calls ViON directly by IP needs (RFC 3261, RFC 4566): reading a
 * request or a response, writing one, the parameters of a header, the audio of an offer and the answer to it.
 * Nothing here talks to the network.
 */

export interface SipMessage {
  /** a request has a method and a URI, a response a status and a reason */
  method?: string;
  uri?: string;
  status?: number;
  reason?: string;
  /** in order, names in their usual spelling ("Call-ID", "Via"); a header that came twice is here twice */
  headers: [string, string][];
  body: string;
}

const COMPACT: Record<string, string> = {
  v: 'Via',
  f: 'From',
  t: 'To',
  i: 'Call-ID',
  m: 'Contact',
  l: 'Content-Length',
  c: 'Content-Type',
  k: 'Supported',
  s: 'Subject',
  e: 'Content-Encoding',
  o: 'Event',
  u: 'Allow-Events',
};

const SPELLING = new Map(
  [
    'Via',
    'From',
    'To',
    'Call-ID',
    'CSeq',
    'Contact',
    'Content-Length',
    'Content-Type',
    'Max-Forwards',
    'User-Agent',
    'Server',
    'Allow',
    'Supported',
    'Expires',
    'Record-Route',
    'Route',
  ].map((name) => [name.toLowerCase(), name]),
);

function spelled(name: string): string {
  const lower = name.trim().toLowerCase();
  return COMPACT[lower] ?? SPELLING.get(lower) ?? name.trim();
}

/** The message, or undefined when the bytes are not one (a keep-alive "\r\n\r\n", a STUN packet, noise). */
export function parseSip(data: Buffer | string): SipMessage | undefined {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const head = (split < 0 ? text : text.slice(0, split)).replace(/^(\r\n)+/, '');
  if (!head) return undefined;
  const lines = head.split('\r\n');
  const first = lines.shift() ?? '';
  const message: SipMessage = { headers: [], body: '' };
  const response = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(first);
  const request = /^([A-Z]+) (\S+) SIP\/2\.0$/.exec(first);
  if (response) {
    message.status = Number(response[1]);
    message.reason = response[2];
  } else if (request) {
    message.method = request[1];
    message.uri = request[2];
  } else return undefined;
  for (const line of lines) {
    // a line that starts with a space or a tab continues the header above it
    if (/^[ \t]/.test(line) && message.headers.length) {
      message.headers[message.headers.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    message.headers.push([spelled(line.slice(0, colon)), line.slice(colon + 1).trim()]);
  }
  if (split >= 0) {
    const body = text.slice(split + 4);
    const length = Number(header(message, 'Content-Length'));
    message.body = Number.isInteger(length) && length >= 0 ? Buffer.from(body, 'utf8').subarray(0, length).toString('utf8') : body;
  }
  return message;
}

export function header(message: SipMessage, name: string): string | undefined {
  const wanted = spelled(name).toLowerCase();
  return message.headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Every value of a header, a list in one line split at its commas (outside quotes and angle brackets). */
export function headers(message: SipMessage, name: string): string[] {
  const wanted = spelled(name).toLowerCase();
  return message.headers.filter(([key]) => key.toLowerCase() === wanted).flatMap(([, value]) => splitList(value));
}

function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted;
    else if (!quoted && c === '<') depth++;
    else if (!quoted && c === '>') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

export function serializeSip(message: SipMessage): Buffer {
  const first = message.method ? `${message.method} ${message.uri} SIP/2.0` : `SIP/2.0 ${message.status} ${message.reason ?? ''}`.trimEnd();
  const body = Buffer.from(message.body, 'utf8');
  const lines = [first, ...message.headers.filter(([name]) => name !== 'Content-Length').map(([name, value]) => `${name}: ${value}`), `Content-Length: ${body.length}`];
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), body]);
}

/** A parameter after the address of a header (`;tag=…`, `;branch=…`); true for one without a value. */
export function param(value: string, name: string): string | true | undefined {
  const close = value.lastIndexOf('>');
  const params = (close >= 0 ? value.slice(close + 1) : value).split(';').slice(1);
  for (const item of params) {
    const [key, ...rest] = item.split('=');
    if (key.trim().toLowerCase() === name.toLowerCase()) return rest.length ? rest.join('=').trim() : true;
  }
  return undefined;
}

export function textParam(value: string | undefined, name: string): string | undefined {
  const found = value === undefined ? undefined : param(value, name);
  return typeof found === 'string' ? found : undefined;
}

/** The URI of a name-address (`"Gate" <sip:1@10.0.0.5>;tag=1` → `sip:1@10.0.0.5`). */
export function uriOf(value: string): string {
  const open = value.indexOf('<');
  const close = value.indexOf('>', open);
  if (open >= 0 && close > open) return value.slice(open + 1, close);
  return value.split(';')[0].trim();
}

/** The host and the port of a SIP URI (`sip:1001@192.168.1.50:5062;transport=udp`). */
export function hostOf(uri: string): { user?: string; host: string; port?: number } | undefined {
  const match = /^sips?:(?:([^@;]+)@)?(\[[^\]]+\]|[^:;?>]+)(?::(\d+))?/i.exec(uri.trim());
  if (!match) return undefined;
  return { user: match[1], host: match[2].replace(/^\[|\]$/g, ''), port: match[3] ? Number(match[3]) : undefined };
}

export function parseCSeq(value: string | undefined): { seq: number; method: string } | undefined {
  const match = /^(\d+)\s+([A-Z]+)$/.exec(value?.trim() ?? '');
  return match ? { seq: Number(match[1]), method: match[2] } : undefined;
}

/** `SIP/2.0/UDP 192.168.1.50:5060;branch=z9hG4bK1;rport` */
export function parseVia(value: string): { transport: string; host: string; port?: number; branch?: string; rport: boolean } | undefined {
  const match = /^SIP\/2\.0\/(\w+)\s+(\[[^\]]+\]|[^:;\s]+)(?::(\d+))?/i.exec(value.trim());
  if (!match) return undefined;
  return {
    transport: match[1].toUpperCase(),
    host: match[2].replace(/^\[|\]$/g, ''),
    port: match[3] ? Number(match[3]) : undefined,
    branch: textParam(value, 'branch'),
    rport: param(value, 'rport') !== undefined,
  };
}

// ---- SDP ----

export interface AudioOffer {
  address: string;
  port: number;
  /** payload types in the order of preference of the side that offered */
  payloads: number[];
  /** payload type → encoding name in upper case and clock rate */
  rtpmap: Map<number, { name: string; rate: number }>;
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
}

/** The audio of a session description, or undefined when it has none. */
export function parseSdp(body: string): AudioOffer | undefined {
  let sessionAddress: string | undefined;
  let mediaAddress: string | undefined;
  let audio: AudioOffer | undefined;
  let inAudio = false;
  let sessionDirection: AudioOffer['direction'] = 'sendrecv';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      if (audio) break; // the first audio stream only
      const match = /^m=audio (\d+) RTP\/(?:S?AVPF?) ([\d ]+)$/.exec(line);
      inAudio = Boolean(match);
      if (match) {
        audio = {
          address: '',
          port: Number(match[1]),
          payloads: match[2].trim().split(/\s+/).map(Number),
          rtpmap: new Map(),
          direction: sessionDirection,
        };
      }
      continue;
    }
    const address = /^c=IN IP4 (\S+)/.exec(line)?.[1];
    if (address) {
      if (inAudio) mediaAddress = address;
      else if (!audio) sessionAddress = address;
      continue;
    }
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)?.[1] as AudioOffer['direction'] | undefined;
    if (direction) {
      if (inAudio && audio) audio.direction = direction;
      else if (!audio) sessionDirection = direction;
      continue;
    }
    const map = /^a=rtpmap:(\d+) ([\w-]+)\/(\d+)/.exec(line);
    if (map && inAudio && audio) audio.rtpmap.set(Number(map[1]), { name: map[2].toUpperCase(), rate: Number(map[3]) });
  }
  if (!audio) return undefined;
  audio.address = mediaAddress ?? sessionAddress ?? '';
  // the static payload types need no rtpmap (RFC 3551)
  if (audio.payloads.includes(0) && !audio.rtpmap.has(0)) audio.rtpmap.set(0, { name: 'PCMU', rate: 8000 });
  if (audio.payloads.includes(8) && !audio.rtpmap.has(8)) audio.rtpmap.set(8, { name: 'PCMA', rate: 8000 });
  return audio;
}

export type G711 = 'PCMA' | 'PCMU';

export interface AudioChoice {
  payloadType: number;
  codec: G711;
  /** the payload type of RFC 4733 telephone events, when the offer has them */
  dtmfPayloadType?: number;
}

/** G.711 from the offer, A-law first (the panels' own), and its telephone events; undefined when it has no G.711. */
export function chooseAudio(offer: AudioOffer): AudioChoice | undefined {
  const g711 = (name: G711) => offer.payloads.find((pt) => offer.rtpmap.get(pt)?.name === name && offer.rtpmap.get(pt)?.rate === 8000);
  const alaw = g711('PCMA');
  const ulaw = g711('PCMU');
  const payloadType = alaw ?? ulaw;
  if (payloadType === undefined) return undefined;
  const dtmfPayloadType = offer.payloads.find((pt) => offer.rtpmap.get(pt)?.name === 'TELEPHONE-EVENT' && offer.rtpmap.get(pt)?.rate === 8000);
  return { payloadType, codec: alaw !== undefined ? 'PCMA' : 'PCMU', ...(dtmfPayloadType !== undefined ? { dtmfPayloadType } : {}) };
}

/** The answer (or, to an INVITE without an offer, the offer) for one audio stream of G.711. */
export function describeAudio(options: { address: string; port: number; sessionId: number; choice?: AudioChoice }): string {
  const choice = options.choice;
  const payloads = choice ? [choice.payloadType, ...(choice.dtmfPayloadType !== undefined ? [choice.dtmfPayloadType] : [])] : [8, 0, 101];
  const lines = [
    'v=0',
    `o=vion ${options.sessionId} ${options.sessionId} IN IP4 ${options.address}`,
    's=ViON',
    `c=IN IP4 ${options.address}`,
    't=0 0',
    `m=audio ${options.port} RTP/AVP ${payloads.join(' ')}`,
  ];
  if (choice) {
    lines.push(`a=rtpmap:${choice.payloadType} ${choice.codec}/8000`);
    if (choice.dtmfPayloadType !== undefined) lines.push(`a=rtpmap:${choice.dtmfPayloadType} telephone-event/8000`, `a=fmtp:${choice.dtmfPayloadType} 0-15`);
  } else lines.push('a=rtpmap:8 PCMA/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-15');
  lines.push('a=ptime:20', 'a=sendrecv');
  return `${lines.join('\r\n')}\r\n`;
}

/** The digit of a SIP INFO (application/dtmf-relay "Signal=5", or application/dtmf "5"). */
export function infoDigit(message: SipMessage): string | undefined {
  const type = header(message, 'Content-Type')?.toLowerCase() ?? '';
  const body = message.body.trim();
  const digit = type.includes('dtmf-relay') ? /Signal\s*=\s*(\S)/i.exec(body)?.[1] : type.includes('application/dtmf') ? body.slice(0, 1) : undefined;
  if (!digit) return undefined;
  // some panels send the events' numbers: 10 is "*", 11 is "#"
  const named: Record<string, string> = { 10: '*', 11: '#' };
  const value = named[/Signal\s*=\s*(\d{2})/i.exec(body)?.[1] ?? ''] ?? digit.toUpperCase();
  return /^[0-9*#A-D]$/.test(value) ? value : undefined;
}
