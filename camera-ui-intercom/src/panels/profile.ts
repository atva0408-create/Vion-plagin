/**
 * A model of a panel as data: which engine speaks to it, its video addresses, how a ring and the door show in its
 * events, the request that opens each door. A new model on a known engine is a new profile, with no new code; a
 * profile from the catalog is checked here before it is used, and it can only ever send requests to the panel's own
 * address (every path is a path, never a URL).
 */

export const ENGINES = ['generic', 'hook', 'akuvox', 'dahua', 'hikvision', 'sip'] as const;
export type EngineId = (typeof ENGINES)[number];

/** A request to the panel; `path` is fixed to the panel's host and port, `{door}` and the credentials are filled in. */
export interface HttpCommand {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  body?: string;
  contentType?: string;
  /** statuses that mean done (default: any 2xx) */
  okStatus?: number[];
}

/** A command said into a SIP call as DTMF digits. */
export interface DtmfCommand {
  dtmf: string;
}

export type PanelCommand = HttpCommand | DtmfCommand;

export type PanelEventKind = 'ring' | 'door_open' | 'door_closed' | 'tamper' | 'call_end';

/** An event of the panel, as flat fields ("Code", "data.State", "CallStatus.status") each equal to one of the values. */
export interface EventRule {
  event: PanelEventKind;
  match: Record<string, string[]>;
}

export interface PanelProfile {
  id: string;
  version: number;
  vendor: string;
  models: string[];
  firmware?: string[];
  engine: EngineId;
  minPluginVersion: string;
  status: 'verified' | 'documented' | 'community';
  ports: { http: number; rtsp: number };
  /** RTSP paths of the main, the small and the talk stream; `{user}`, `{pass}`, `{host}`, `{rtspPort}` filled in */
  video: { main: string; sub?: string; talk?: string };
  /** a second source that carries only the talk channel (Hikvision's isapi://) */
  talkSource?: string;
  audio: { fromPanel: boolean; toPanel: 'rtsp-backchannel' | 'isapi' | 'sip' | 'none' };
  auth: 'digest' | 'basic' | 'query' | 'none';
  /** where the events come from: a stream that stays open, a status read every so often, or the panel calling ViON */
  events:
    | { via: 'stream'; path: string; format: 'dahua' | 'hikvision' }
    | { via: 'poll'; path: string; everyMs: number }
    | { via: 'hook' }
    | { via: 'sip' }
    | { via: 'sensors' };
  rules: EventRule[];
  doors: { key: string; name: string; open: PanelCommand }[];
  /** tells the panel the call was answered in ViON, so its own monitors stop ringing */
  answered?: PanelCommand;
  hangUp?: PanelCommand;
  /** a request that works only with the right login; its answer names the model and firmware */
  probe?: { command: HttpCommand; model?: string[]; firmware?: string[] };
  features?: { display?: boolean; keypad?: boolean };
  /** i18n keys: what the owner turns on in the panel's own web page */
  setup: string[];
  quirks?: string[];
}

export interface Credentials {
  host: string;
  httpPort?: number;
  rtspPort?: number;
  username: string;
  password: string;
}

const isText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;

/** A path of a request to the panel: starts with "/", has no scheme, host, user or "..". */
export function safePath(path: unknown): path is string {
  return isText(path, 1024) && path.startsWith('/') && !path.startsWith('//') && !/[\s\\]|:\/\/|@|\.\./.test(path);
}

function checkCommand(command: unknown, where: string): string | undefined {
  if (!command || typeof command !== 'object') return `${where}: not a command`;
  const c = command as Record<string, unknown>;
  if ('dtmf' in c) return isText(c.dtmf, 32) && /^[0-9*#A-D]+$/.test(c.dtmf) ? undefined : `${where}: DTMF digits 0-9 * # A-D`;
  if (!['GET', 'PUT', 'POST'].includes(c.method as string)) return `${where}: method GET, PUT or POST`;
  if (!safePath(c.path)) return `${where}: the path must be a path of the panel ("/..."), not an address`;
  if (c.body !== undefined && !isText(c.body, 4096)) return `${where}: body`;
  if (c.okStatus !== undefined && !(Array.isArray(c.okStatus) && c.okStatus.every((s) => Number.isInteger(s)))) return `${where}: okStatus`;
  return undefined;
}

/** The profile, or why it is not one. */
export function checkProfile(data: unknown): PanelProfile | string {
  if (!data || typeof data !== 'object') return 'not an object';
  const p = data as Record<string, unknown>;
  if (!isText(p.id, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) return 'id: lower-case letters, digits and dashes';
  if (!Number.isInteger(p.version)) return 'version: a whole number';
  if (!isText(p.vendor, 64)) return 'vendor';
  if (!Array.isArray(p.models) || !p.models.every((m) => isText(m, 64))) return 'models';
  if (!ENGINES.includes(p.engine as EngineId)) return `engine: one of ${ENGINES.join(', ')}`;
  if (!isText(p.minPluginVersion, 16) || !/^\d+\.\d+\.\d+$/.test(p.minPluginVersion)) return 'minPluginVersion: x.y.z';
  if (!['verified', 'documented', 'community'].includes(p.status as string)) return 'status';
  const ports = p.ports as Record<string, unknown> | undefined;
  if (!ports || !isPort(ports.http) || !isPort(ports.rtsp)) return 'ports: http and rtsp';
  const video = p.video as Record<string, unknown> | undefined;
  if (!video || typeof video.main !== 'string') return 'video.main';
  for (const key of ['main', 'sub', 'talk'] as const) {
    const path = video[key];
    if (path !== undefined && path !== '' && !safePath(path)) return `video.${key}: a path of the panel's RTSP server`;
  }
  if (p.talkSource !== undefined && (typeof p.talkSource !== 'string' || !/^isapi:\/\/\{user\}:\{pass\}@\{host\}:\{httpPort\}\/?$/.test(p.talkSource))) {
    return 'talkSource: isapi://{user}:{pass}@{host}:{httpPort}/';
  }
  const audio = p.audio as Record<string, unknown> | undefined;
  if (!audio || typeof audio.fromPanel !== 'boolean' || !['rtsp-backchannel', 'isapi', 'sip', 'none'].includes(audio.toPanel as string)) return 'audio';
  if (!['digest', 'basic', 'query', 'none'].includes(p.auth as string)) return 'auth';
  const events = p.events as Record<string, unknown> | undefined;
  if (!events) return 'events';
  if (events.via === 'stream') {
    if (!safePath(events.path) || !['dahua', 'hikvision'].includes(events.format as string)) return 'events: a stream path and its format';
  } else if (events.via === 'poll') {
    if (!safePath(events.path) || !Number.isInteger(events.everyMs) || (events.everyMs as number) < 250) return 'events: a poll path, every 250 ms or more';
  } else if (!['hook', 'sip', 'sensors'].includes(events.via as string)) return 'events.via';
  if (!Array.isArray(p.rules)) return 'rules';
  for (const rule of p.rules as unknown[]) {
    const r = rule as Record<string, unknown>;
    if (!['ring', 'door_open', 'door_closed', 'tamper', 'call_end'].includes(r?.event as string)) return 'rules: event';
    if (!r.match || typeof r.match !== 'object' || !Object.values(r.match).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      return 'rules: match is fields with lists of values';
    }
  }
  if (!Array.isArray(p.doors)) return 'doors';
  for (const door of p.doors as unknown[]) {
    const d = door as Record<string, unknown>;
    if (!isText(d?.key, 32) || !isText(d.name, 64)) return 'doors: key and name';
    const problem = checkCommand(d.open, `doors.${d.key}.open`);
    if (problem) return problem;
  }
  for (const key of ['answered', 'hangUp'] as const) {
    if (p[key] !== undefined) {
      const problem = checkCommand(p[key], key);
      if (problem) return problem;
    }
  }
  if (p.probe !== undefined) {
    const probe = p.probe as Record<string, unknown>;
    const problem = checkCommand(probe.command, 'probe');
    if (problem) return problem;
  }
  if (!Array.isArray(p.setup) || !p.setup.every((s) => isText(s, 128))) return 'setup';
  return p as unknown as PanelProfile;
}

/** Fills `{user}`, `{pass}`, `{host}`, `{httpPort}`, `{rtspPort}`, `{door}`; credentials are URL-encoded. */
export function fill(template: string, profile: PanelProfile, credentials: Credentials, door?: string): string {
  const values: Record<string, string> = {
    user: encodeURIComponent(credentials.username),
    pass: encodeURIComponent(credentials.password),
    host: credentials.host,
    httpPort: String(credentials.httpPort ?? profile.ports.http),
    rtspPort: String(credentials.rtspPort ?? profile.ports.rtsp),
    door: door ?? '',
  };
  return template.replace(/\{(user|pass|host|httpPort|rtspPort|door)\}/g, (_, key: string) => values[key]);
}

/** The RTSP address of a stream of the panel. */
export function rtspUrl(path: string, profile: PanelProfile, credentials: Credentials): string {
  const port = credentials.rtspPort ?? profile.ports.rtsp;
  return `rtsp://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${credentials.host}:${port}${fill(path, profile, credentials)}`;
}

/** A host as typed by the owner: an IPv4 address or a name, nothing else (no scheme, port or path). */
export function validHost(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
    ? host.split('.').every((n) => Number(n) <= 255)
    : /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

// ---- events as flat fields ----

/** Nested JSON as flat fields: {"CallStatus": {"status": "ring"}} is "CallStatus.status" = "ring". */
export function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out[prefix] = String(value);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/** "key=value" lines, simple XML elements and JSON alike, as flat fields (what a probe or a hook answers). */
export function fieldsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return flatten(JSON.parse(trimmed));
    } catch {
      // not JSON after all
    }
  }
  for (const match of trimmed.matchAll(/<([A-Za-z][\w.-]*)>([^<]*)<\/\1>/g)) out[match[1]] = match[2].trim();
  for (const line of trimmed.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('<')) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The events the fields are, by the profile's rules (values compared without case). */
export function eventsOf(fields: Record<string, string>, rules: EventRule[]): PanelEventKind[] {
  const out: PanelEventKind[] = [];
  for (const rule of rules) {
    const all = Object.entries(rule.match).every(([key, values]) => {
      const got = fields[key];
      return got !== undefined && values.some((value) => value.toLowerCase() === got.toLowerCase());
    });
    if (all && !out.includes(rule.event)) out.push(rule.event);
  }
  return out;
}

/** The first field of the names given that the fields have (a probe's model or firmware). */
export function pick(fields: Record<string, string>, names: string[] | undefined): string | undefined {
  for (const name of names ?? []) if (fields[name]) return fields[name];
  return undefined;
}

/** Compares versions "x.y.z". */
export function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
