// Panels: profiles as data that can only reach the panel, digest login, Dahua's event stream, Hikvision's call status,
// RUBITEK/Akuvox commands, events a panel sends, the catalog from the mirror. Panels are a local HTTP server playing
// what the devices answer. Run: npx tsx spec/panels.spec.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock, flush, runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { ProfileCatalog } from '../src/panels/catalog.js';
import { HttpPanel } from '../src/panels/engine.js';
import { digestHeader, parseChallenge } from '../src/panels/http.js';
import { checkProfile, eventsOf, fieldsOf, rtspUrl, safePath, validHost } from '../src/panels/profile.js';
import { MultipartSplitter, dahuaFields } from '../src/panels/stream.js';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PanelListener } from '../src/panels/engine.js';
import type { PanelEventKind, PanelProfile } from '../src/panels/profile.js';

const PROFILES = join(import.meta.dirname, '..', 'profiles');

function shipped(id: string): PanelProfile {
  const checked = checkProfile(JSON.parse(readFileSync(join(PROFILES, `${id}.json`), 'utf8')));
  assert.notEqual(typeof checked, 'string', String(checked));
  return checked as PanelProfile;
}

/** A panel: a local HTTP server and what it was asked. */
async function panel(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; port: number; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      asked.push(`${req.method} ${req.url}`);
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, asked };
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Checks a digest Authorization as RFC 7616 does (MD5, qop=auth). */
function digestOk(header: string | undefined, method: string, password: string): boolean {
  if (!header?.startsWith('Digest ')) return false;
  const f: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) f[m[1]] = m[2] ?? m[3];
  const ha1 = md5(`${f.username}:${f.realm}:${password}`);
  const ha2 = md5(`${method}:${f.uri}`);
  return f.response === md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
}

function challenge(res: ServerResponse): void {
  res.writeHead(401, { 'www-authenticate': 'Digest realm="Login to 4L0C", qop="auth", nonce="1234567890", opaque="abc"' });
  res.end();
}

function collector(): PanelListener & { events: PanelEventKind[]; online: (ok: boolean) => void; states: boolean[] } {
  const events: PanelEventKind[] = [];
  const states: boolean[] = [];
  return { events, states, event: (kind) => events.push(kind), online: (ok) => states.push(ok) };
}

// ---- profiles ----

test('shipped profiles pass the check; a path that names another host, a user or a scheme is refused', () => {
  const ids = readdirSync(PROFILES).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(ids.sort(), ['camera-button', 'dahua-vto', 'generic-hook', 'hikvision-door-station', 'rubetek-rv-34xx', 'rubetek-rv-34xx-sip']);
  for (const id of ids) shipped(id);
  const dahua = JSON.parse(readFileSync(join(PROFILES, 'dahua-vto.json'), 'utf8'));
  const broken = (change: (p: any) => void) => {
    const copy = structuredClone(dahua);
    change(copy);
    return checkProfile(copy);
  };
  assert.match(String(broken((p) => (p.doors[0].open.path = 'http://evil.example/open'))), /path/);
  assert.match(String(broken((p) => (p.doors[0].open.path = '//evil.example/open'))), /path/);
  assert.match(String(broken((p) => (p.doors[0].open.path = '/x@evil.example'))), /path/);
  assert.match(String(broken((p) => (p.events.path = '/../../etc'))), /events/);
  assert.match(String(broken((p) => (p.video.main = 'rtsp://evil/stream'))), /video.main/);
  assert.match(String(broken((p) => (p.talkSource = 'isapi://x:y@evil:80/'))), /talkSource/);
  assert.match(String(broken((p) => (p.engine = 'shell'))), /engine/);
  assert.match(String(broken((p) => (p.id = 'Dahua VTO'))), /id/);
  assert.equal(safePath('/cgi-bin/accessControl.cgi?action=openDoor&channel=1'), true);
  assert.equal(validHost('192.168.10.41'), true);
  assert.equal(validHost('panel.local'), true);
  assert.equal(validHost('192.168.10.41:80'), false);
  assert.equal(validHost('http://192.168.10.41'), false);
  assert.equal(validHost('300.1.1.1'), false);
});

test('RTSP addresses carry the login URL-encoded and the panel host only', () => {
  const dahua = shipped('dahua-vto');
  assert.equal(
    rtspUrl(dahua.video.talk!, dahua, { host: '192.168.10.41', username: 'admin', password: 'p@ss:w/rd' }),
    'rtsp://admin:p%40ss%3Aw%2Frd@192.168.10.41:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif',
  );
});

test('fields: key=value lines, XML and JSON alike; rules match any of the values, without case', () => {
  assert.deepEqual(fieldsOf('deviceType=VTO2202F-P\nserialNumber=8F01\n'), { deviceType: 'VTO2202F-P', serialNumber: '8F01' });
  assert.equal(fieldsOf('<DeviceInfo><model>DS-KV6113-WPE1</model><firmwareVersion>V2.2.60</firmwareVersion></DeviceInfo>').model, 'DS-KV6113-WPE1');
  assert.equal(fieldsOf('{"CallStatus":{"status":"ring"}}')['CallStatus.status'], 'ring');
  const rules = shipped('dahua-vto').rules;
  assert.deepEqual(eventsOf({ Code: 'BackKeyLight', action: 'Pulse', index: '0', 'data.State': '1' }, rules), ['ring']);
  assert.deepEqual(eventsOf({ Code: 'BackKeyLight', action: 'Pulse', index: '0', 'data.State': '0' }, rules), []);
  assert.deepEqual(eventsOf({ Code: 'invite', action: 'start', index: '0' }, rules), ['ring']);
});

// ---- login ----

test('digest: the RFC example answer; a challenge is parsed with its realm, nonce, qop and opaque', () => {
  const c = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  )!;
  assert.equal(c.qop, 'auth');
  const header = digestHeader(c, 'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', '0a4f113b');
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.equal(parseChallenge('Basic realm="x"'), undefined);
});

// ---- Dahua ----

test('Dahua: the event stream through digest, parts cut anywhere, a ring and the door; heartbeats are nothing', async () => {
  const parts = ['Heartbeat', 'Code=BackKeyLight;action=Pulse;index=0;data={\n   "State" : 1\n}', 'Code=DoorStatus;action=Pulse;index=0;data={ "Status" : "Open" }'];
  const stream = parts.map((p) => `--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${p.length}\r\n\r\n${p}\r\n\r\n`).join('');
  const device = await panel((req, res) => {
    if (!digestOk(req.headers.authorization, 'GET', 'secret')) return challenge(res);
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=myboundary' });
    // cut the stream into pieces of 7 bytes, so markers and events are split
    let i = 0;
    const timer = setInterval(() => {
      if (i >= stream.length) return clearInterval(timer);
      res.write(stream.slice(i, i + 7));
      i += 7;
    }, 1);
  });
  const listener = collector();
  const engine = new HttpPanel(shipped('dahua-vto'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'secret' }, listener);
  engine.start();
  for (let i = 0; i < 200 && listener.events.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  engine.stop();
  device.server.close();
  assert.deepEqual(listener.events, ['ring', 'door_open']);
  assert.deepEqual(listener.states, [true]);
  assert.equal(device.asked.filter((a) => a.includes('eventManager')).length, 2, 'the challenge, then the stream');
});

test('Dahua: a stream that ends is opened again after a pause; offline only after the pauses ran out', async () => {
  let opened = 0;
  const device = await panel((_req, res) => {
    opened++;
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=myboundary' });
    res.end();
  });
  const clock = new FakeClock(0);
  const listener = collector();
  const engine = new HttpPanel({ ...shipped('dahua-vto'), auth: 'none' }, { host: '127.0.0.1', httpPort: device.port, username: 'a', password: 'b' }, listener, {
    clock,
  });
  engine.start();
  for (let i = 0; i < 50 && opened < 1; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opened, 1);
  await clock.advance(1_000);
  for (let i = 0; i < 50 && opened < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(opened, 2, 'reopened after 1 s');
  engine.stop();
  device.server.close();
  assert.deepEqual(listener.states, [true], 'a dropped stream that comes back is not "offline"');
});

test('Dahua: openDoor once with digest; an error is reported and not tried another way', async () => {
  let fail = false;
  const device = await panel((req, res) => {
    if (!digestOk(req.headers.authorization, 'GET', 'secret')) return challenge(res);
    res.writeHead(fail ? 400 : 200).end(fail ? 'Error' : 'OK');
  });
  const engine = new HttpPanel(shipped('dahua-vto'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'secret' }, collector());
  assert.deepEqual(await engine.open('1'), { ok: true, status: 200 });
  assert.ok(device.asked.at(-1)!.includes('action=openDoor&channel=1&UserID=101&Type=Remote'));
  fail = true;
  const before = device.asked.length;
  const failed = await engine.open('2');
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /400/);
  assert.equal(device.asked.length - before, 2, 'the challenge and one try');
  assert.equal((await engine.open('9')).ok, false, 'a door the panel does not have');
  device.server.close();
});

test('Dahua: the probe reads the model; a wrong password is "login wrong"', async () => {
  const device = await panel((req, res) => {
    if (!digestOk(req.headers.authorization, 'GET', 'secret')) return challenge(res);
    res.writeHead(200).end('deviceType=VTO2202F-P\nprocessor=SSC335\nserialNumber=8F0123\n');
  });
  const good = await new HttpPanel(shipped('dahua-vto'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'secret' }, collector()).probe();
  assert.deepEqual(good, { login: true, model: 'VTO2202F-P', firmware: undefined });
  const bad = await new HttpPanel(shipped('dahua-vto'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'nope' }, collector()).probe();
  assert.equal(bad.login, false);
  assert.match(bad.error!, /login/);
  device.server.close();
});

// ---- Hikvision ----

test('Hikvision: the call status read every second gives a ring once while it lasts, and the end once', async () => {
  const statuses = ['idle', 'ring', 'ring', 'ring', 'idle', 'idle'];
  let polled = 0;
  const device = await panel((req, res, body) => {
    if (!digestOk(req.headers.authorization, req.method!, 'secret')) return challenge(res);
    if (req.url?.startsWith('/ISAPI/VideoIntercom/callStatus')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ CallStatus: { status: statuses[Math.min(polled++, statuses.length - 1)] } }));
    } else if (req.url === '/ISAPI/AccessControl/RemoteControl/door/1') {
      res.writeHead(body.includes('<cmd>open</cmd>') ? 200 : 400).end();
    } else res.writeHead(404).end();
  });
  const clock = new FakeClock(0);
  const listener = collector();
  const engine = new HttpPanel(shipped('hikvision-door-station'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'secret' }, listener, {
    clock,
  });
  engine.start();
  for (let step = 0; step < statuses.length; step++) {
    for (let i = 0; i < 100 && polled <= step; i++) await new Promise((r) => setTimeout(r, 5));
    await flush(20);
    await clock.advance(1_000);
  }
  engine.stop();
  assert.deepEqual(listener.events, ['call_end', 'ring', 'call_end']);
  assert.deepEqual(await engine.open('1'), { ok: true, status: 200 });
  device.server.close();
});

// ---- RUBITEK / Akuvox and events sent to ViON ----

test('RUBITEK: OpenDoor and CallEnd with the login in the query, URL-encoded; the door number of the key', async () => {
  const device = await panel((req, res) => res.writeHead(req.url?.includes('Password=p%26w') ? 200 : 403).end());
  const engine = new HttpPanel(shipped('rubetek-rv-34xx'), { host: '127.0.0.1', httpPort: device.port, username: 'admin', password: 'p&w' }, collector());
  assert.equal((await engine.open('2')).ok, true);
  assert.equal(device.asked[0], 'GET /fcgi/do?action=OpenDoor&UserName=admin&Password=p%26w&DoorNum=2');
  assert.equal((await engine.hangUp())?.ok, true);
  assert.equal(device.asked[1], 'GET /fcgi/do?action=CallEnd&UserName=admin&Password=p%26w');
  device.server.close();
});

test('events sent by the panel: the query, a form or JSON body, matched by the profile', () => {
  const listener = collector();
  const engine = new HttpPanel(shipped('rubetek-rv-34xx'), { host: '127.0.0.1', username: 'a', password: 'b' }, listener);
  assert.deepEqual(engine.hook({ query: { event: 'ring' } }), ['ring']);
  assert.deepEqual(engine.hook({ query: {}, body: 'event=door&relay=1', contentType: 'application/x-www-form-urlencoded' }), ['door_open']);
  assert.deepEqual(engine.hook({ query: {}, body: '{"event":"end"}', contentType: 'application/json' }), ['call_end']);
  assert.deepEqual(engine.hook({ query: { event: 'motion' } }), []);
  assert.deepEqual(listener.events, ['ring', 'door_open', 'call_end']);
  assert.deepEqual(listener.states, [true]);
});

test('the multipart splitter: a part with its length at once, even with a Cyrillic name; one without at the next boundary', () => {
  const bytes = (text: string) => Buffer.from(text);
  const splitter = new MultipartSplitter('myboundary');
  const event = 'Code=Face;action=Start;index=0;data={"Name":"Маша"}';
  assert.deepEqual(splitter.push(bytes('--mybou')), []);
  assert.deepEqual(splitter.push(bytes(`ndary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(event)}\r\n\r\n${event.slice(0, 20)}`)), []);
  assert.deepEqual(splitter.push(bytes(`${event.slice(20)}\r\n`)), [event], 'given before any next part');
  assert.deepEqual(splitter.push(bytes('--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=A;action=Start;index=0\r\n--my')), []);
  assert.deepEqual(splitter.push(bytes('boundary\r\n')), ['Code=A;action=Start;index=0']);
  assert.deepEqual(dahuaFields('Code=A;action=Start;index=0\nCode=B;action=Stop;index=1'), [
    { Code: 'A', action: 'Start', index: '0' },
    { Code: 'B', action: 'Stop', index: '1' },
  ]);
});

// ---- the catalog ----

test('catalog: shipped models usable; from the mirror a newer profile is taken, a bad checksum, a wrong id or a bad file name are not', async () => {
  const newer = JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILES, 'dahua-vto.json'), 'utf8')), version: 2, models: ['VTO2202F', 'VTO9999'] });
  const akuvox = JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILES, 'generic-hook.json'), 'utf8')), id: 'akuvox-e12', vendor: 'Akuvox', models: ['E12'] });
  const future = JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILES, 'generic-hook.json'), 'utf8')), id: 'bas-ip', engine: 'basip' });
  const later = JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILES, 'generic-hook.json'), 'utf8')), id: 'twon', minPluginVersion: '9.0.0' });
  const files: Record<string, string> = { 'dahua-vto.json': newer, 'akuvox-e12.json': akuvox, 'bas-ip.json': future, 'twon.json': later, 'liar.json': akuvox };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const entry = (id: string, file: string, text: string, over: object = {}) => ({
    id,
    version: 2,
    file,
    size: Buffer.byteLength(text),
    sha256: sha(text),
    engine: 'x',
    minPluginVersion: '0.1.0',
    ...over,
  });
  const catalog = {
    profiles: [
      entry('dahua-vto', 'dahua-vto.json', newer),
      entry('akuvox-e12', 'akuvox-e12.json', akuvox),
      entry('bas-ip', 'bas-ip.json', future),
      entry('twon', 'twon.json', later),
      entry('liar', 'liar.json', akuvox),
      entry('broken', 'akuvox-e12.json', akuvox, { sha256: '0'.repeat(64) }),
      entry('escape', '../etc/passwd', akuvox),
    ],
  };
  const mirror = await panel((req, res) => {
    const name = req.url!.replace('/v1/intercom/profiles/', '');
    if (name === 'catalog.json') return res.writeHead(200).end(JSON.stringify(catalog));
    if (files[name]) return res.writeHead(200).end(files[name]);
    res.writeHead(404).end();
  });
  process.env.VION_MODELS_HOST = `http://127.0.0.1:${mirror.port}`;
  const store = mkdtempSync(join(tmpdir(), 'intercom-profiles-'));
  const profiles = new ProfileCatalog(PROFILES, store, '0.1.0');
  profiles.load();
  assert.equal(profiles.list().length, 6);
  assert.ok(profiles.list().every((choice) => choice.usable));
  const result = await profiles.refresh();
  mirror.server.close();
  assert.deepEqual(result.added.sort(), ['akuvox-e12', 'bas-ip', 'twon']);
  assert.deepEqual(result.updated, ['dahua-vto']);
  assert.deepEqual(result.failed.map((f) => f.id).sort(), ['broken', 'escape', 'liar']);
  assert.deepEqual(profiles.get('dahua-vto')?.models, ['VTO2202F', 'VTO9999']);
  assert.equal(profiles.get('bas-ip'), undefined, 'an engine of a newer plugin cannot be chosen');
  assert.match(profiles.list().find((c) => c.profile.id === 'bas-ip')!.why!, /newer version/);
  assert.equal(profiles.get('twon'), undefined);
  // the next start reads what was downloaded
  const again = new ProfileCatalog(PROFILES, store, '0.1.0');
  again.load();
  assert.equal(again.get('dahua-vto')?.version, 2);
  assert.equal(again.list().find((c) => c.profile.id === 'dahua-vto')?.source, 'downloaded');
  assert.ok(again.get('akuvox-e12'));
});

void runTests();
