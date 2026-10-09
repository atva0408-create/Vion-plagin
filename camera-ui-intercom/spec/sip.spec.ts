// SIP for a panel that calls ViON directly by IP, over real UDP on this machine with a fake panel: a call rings and is
// answered with G.711, the sound goes both ways, keys come as telephone events and SIP INFO and go out as events, the
// panel or ViON ends the call, a call is cancelled while it rings, an INVITE repeated, an answer never confirmed, an
// offer without G.711, and a stranger who gets no answer at all. Messages are written as Akuvox-based panels send them.
// Run: npx tsx spec/sip.spec.ts
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';

import { runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { chooseAudio, header, headers, infoDigit, parseSdp, parseSip, parseVia, textParam } from '../src/sip/message.js';
import { decodeTo16k, parseRtp, ulawDecodeSample, ulawEncodeSample } from '../src/sip/rtp.js';
import { SipServer } from '../src/sip/server.js';
import { SipPanel } from '../src/panels/sip.js';
import { PhraseCache, sipSound } from '../src/sound.js';
import { checkProfile } from '../src/panels/profile.js';
import { readFileSync } from 'node:fs';

import type { Socket } from 'node:dgram';
import type { SipMessage } from '../src/sip/message.js';
import type { SipCall, SipCallHandler, SipEnd } from '../src/sip/server.js';
import type { Audio, SpeechEngine, VoiceActivity } from '@vionvision/speech';
import type { PanelEventKind, PanelProfile } from '../src/panels/profile.js';

const T1 = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function bound(host = '127.0.0.1'): Promise<Socket> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, host, () => resolve()));
  return socket;
}

/** A panel: its SIP socket, its RTP socket, and what it received. */
class Panel {
  sip!: Socket;
  rtp!: Socket;
  messages: SipMessage[] = [];
  packets: Buffer[] = [];
  private waiters: { match: (m: SipMessage) => boolean; resolve: (m: SipMessage) => void }[] = [];

  static async open(host = '127.0.0.1'): Promise<Panel> {
    const panel = new Panel();
    panel.sip = await bound(host);
    panel.rtp = await bound(host);
    panel.sip.on('message', (data) => {
      const message = parseSip(data);
      if (!message) return;
      panel.messages.push(message);
      for (const waiter of [...panel.waiters]) {
        if (!waiter.match(message)) continue;
        panel.waiters.splice(panel.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    panel.rtp.on('message', (data) => panel.packets.push(data));
    return panel;
  }

  get sipPort(): number {
    return this.sip.address().port;
  }

  get rtpPort(): number {
    return this.rtp.address().port;
  }

  send(text: string, port: number): void {
    this.sip.send(Buffer.from(text.replace(/\n/g, '\r\n')), port, '127.0.0.1');
  }

  /** The next message that matches, or one that came already and was not taken. */
  next(match: (m: SipMessage) => boolean, timeoutMs = 2_000): Promise<SipMessage> {
    const found = this.messages.find(match);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (m: SipMessage) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('no such message came'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.sip.close();
    this.rtp.close();
  }
}

const status = (code: number) => (m: SipMessage) => m.status === code;
const method = (name: string) => (m: SipMessage) => m.method === name;

function invite(panel: Panel, callId: string, sdp?: string, branch = 'z9hG4bK1803457221'): string {
  const body =
    sdp ??
    `v=0
o=- 8000 8000 IN IP4 127.0.0.1
s=SIP Call
c=IN IP4 127.0.0.1
t=0 0
m=audio ${panel.rtpPort} RTP/AVP 8 0 101
a=rtpmap:8 PCMA/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-15
a=ptime:20
a=sendrecv
`;
  const length = Buffer.byteLength(body.replace(/\n/g, '\r\n'));
  return `INVITE sip:vion@127.0.0.1 SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:${panel.sipPort};rport;branch=${branch}
From: "Gate" <sip:100@127.0.0.1:${panel.sipPort}>;tag=1438281950
To: <sip:vion@127.0.0.1>
Call-ID: ${callId}
CSeq: 20 INVITE
Contact: <sip:100@127.0.0.1:${panel.sipPort}>
Content-Type: application/sdp
Allow: INVITE, INFO, PRACK, ACK, BYE, CANCEL, OPTIONS, NOTIFY, REGISTER, SUBSCRIBE, REFER, PUBLISH, UPDATE, MESSAGE
Max-Forwards: 70
User-Agent: Akuvox R20B 220.30.2.28
Supported: replaces
Content-Length: ${length}

${body}`;
}

/** The ACK of a 2xx: a new transaction in the dialog, with the To tag of the answer. */
function ack(panel: Panel, ok: SipMessage): string {
  return `ACK sip:vion@127.0.0.1 SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:${panel.sipPort};rport;branch=z9hG4bK2045821917
From: ${header(ok, 'From')}
To: ${header(ok, 'To')}
Call-ID: ${header(ok, 'Call-ID')}
CSeq: 20 ACK
Max-Forwards: 70
Content-Length: 0

`;
}

function inDialog(panel: Panel, ok: SipMessage, name: string, seq: number, extra = '', body = ''): string {
  return `${name} sip:vion@127.0.0.1 SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:${panel.sipPort};rport;branch=z9hG4bK${seq}77
From: ${header(ok, 'From')}
To: ${header(ok, 'To')}
Call-ID: ${header(ok, 'Call-ID')}
CSeq: ${seq} ${name}
${extra}Content-Length: ${Buffer.byteLength(body.replace(/\n/g, '\r\n'))}

${body}`;
}

class Calls implements SipCallHandler {
  rung: SipCall[] = [];
  ends: SipEnd[] = [];
  digits: string[] = [];
  seenCount = 0;
  ring(call: SipCall): void {
    this.rung.push(call);
  }
  ended(_call: SipCall, why: SipEnd): void {
    this.ends.push(why);
  }
  dtmf(_call: SipCall, digit: string): void {
    this.digits.push(digit);
  }
  seen(): void {
    this.seenCount++;
  }
}

async function world(host = '127.0.0.1') {
  const server = new SipServer({ port: 0, t1Ms: T1, localAddress: async () => '127.0.0.1' });
  await server.start();
  const panel = await Panel.open(host);
  const calls = new Calls();
  server.peer('127.0.0.1', calls);
  return { server, panel, calls, close: async () => (panel.close(), await server.stop()) };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waited in vain');
    await sleep(5);
  }
}

test('messages as a panel writes them: compact headers, folded lines, parameters, the audio of an offer', () => {
  const sdp = 'v=0\r\nc=IN IP4 192.168.1.50\r\nt=0 0\r\nm=audio 11800 RTP/AVP 18 0 101\r\na=rtpmap:18 G729/8000\r\na=rtpmap:101 telephone-event/8000\r\n';
  const text =
    'INVITE sip:vion@192.168.1.10 SIP/2.0\r\n' +
    'v: SIP/2.0/UDP 192.168.1.50:5060;branch=z9hG4bK77;rport\r\n' +
    'f: "Калитка" <sip:100@192.168.1.50>;tag=a1\r\n' +
    't: <sip:vion@192.168.1.10>\r\n' +
    'i: 1-2@192.168.1.50\r\n' +
    'CSeq: 1 INVITE\r\n' +
    'Subject: a call\r\n' +
    ' from the gate\r\n' +
    'c: application/sdp\r\n' +
    `l: ${sdp.length}\r\n\r\n` +
    sdp +
    'garbage after the body';
  const message = parseSip(text)!;
  assert.equal(message.method, 'INVITE');
  assert.equal(header(message, 'Call-ID'), '1-2@192.168.1.50');
  assert.equal(header(message, 'subject'), 'a call from the gate');
  assert.equal(textParam(header(message, 'From'), 'tag'), 'a1');
  const via = parseVia(headers(message, 'Via')[0])!;
  assert.deepEqual([via.host, via.port, via.branch, via.rport], ['192.168.1.50', 5060, 'z9hG4bK77', true]);
  assert.equal(message.body, sdp, 'the body ends where Content-Length says');
  const offer = parseSdp(message.body)!;
  assert.deepEqual([offer.address, offer.port, offer.payloads], ['192.168.1.50', 11800, [18, 0, 101]]);
  // G.729 is not taken; μ-law is, with the events
  assert.deepEqual(chooseAudio(offer), { payloadType: 0, codec: 'PCMU', dtmfPayloadType: 101 });
  assert.equal(parseSip('\r\n\r\n'), undefined, 'a keep-alive is not a message');
  assert.equal(infoDigit(parseSip('INFO sip:a SIP/2.0\r\nContent-Type: application/dtmf-relay\r\nContent-Length: 24\r\n\r\nSignal=#\r\nDuration=160\r\n')!), '#');
  assert.equal(infoDigit(parseSip('INFO sip:a SIP/2.0\r\nContent-Type: application/dtmf-relay\r\nContent-Length: 25\r\n\r\nSignal=11\r\nDuration=160\r\n')!), '#');
});

test('μ-law both ways keeps the sound; 8 kHz becomes 16 kHz for recognition', () => {
  for (const value of [0, 100, -100, 1000, -12345, 32000]) {
    const back = ulawDecodeSample(ulawEncodeSample(value));
    assert.ok(Math.abs(back - value) <= Math.max(8, Math.abs(value) * 0.07), `${value} came back as ${back}`);
  }
  const samples = decodeTo16k('PCMA', new Uint8Array(160).fill(0xd5), { value: 0 });
  assert.equal(samples.length, 320);
});

test('a ring, the answer with A-law, sound both ways, keys both ways, ViON ends the call', async () => {
  const w = await world();
  try {
    w.panel.send(invite(w.panel, 'call-1@127.0.0.1'), w.server.port);
    await w.panel.next(status(100));
    const ringing = await w.panel.next(status(180));
    assert.ok(textParam(header(ringing, 'To'), 'tag'), 'the 180 starts the dialog');
    assert.match(header(ringing, 'Contact') ?? '', /<sip:vion@127\.0\.0\.1:\d+>/);
    await until(() => w.calls.rung.length === 1);
    const call = w.calls.rung[0];
    assert.equal(call.caller, 'Gate');

    const accepted = call.accept();
    const ok = await w.panel.next(status(200));
    const answer = parseSdp(ok.body)!;
    assert.deepEqual(chooseAudio(answer), { payloadType: 8, codec: 'PCMA', dtmfPayloadType: 101 }, 'A-law, as the panel offered first');
    assert.equal(answer.address, '127.0.0.1');
    w.panel.send(ack(w.panel, ok), w.server.port);
    await accepted;
    assert.equal(call.state, 'answered');

    // the panel's sound reaches the listeners, at 16 kHz
    let heard = 0;
    call.rtp!.onAudio((samples) => (heard += samples.length));
    const packet = Buffer.alloc(172, 0xd5);
    packet[0] = 0x80;
    packet[1] = 8;
    for (let i = 0; i < 5; i++) {
      packet.writeUInt16BE(i, 2);
      packet.writeUInt32BE(i * 160, 4);
      w.panel.rtp.send(packet, answer.port, '127.0.0.1');
    }
    await until(() => heard >= 5 * 320);

    // ViON speaks: 200 ms of a tone in 20 ms packets, the first marked
    const tone = new Float32Array(3_200).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
    const said = await call.rtp!.speak(tone, 16_000);
    assert.equal(said.status, 'spoken');
    assert.equal(said.durationMs, 200);
    await sleep(60);
    const sent = w.panel.packets.map((p) => parseRtp(p)!).filter((p) => p.payloadType === 8);
    const speech = sent.filter((p) => p.payload.some((b) => b !== 0xd5));
    assert.ok(speech.length >= 10, `speech packets: ${speech.length}`);
    assert.ok(speech[0].marker, 'the talk spurt is marked');
    assert.ok(sent.every((p) => p.payload.length === 160));

    // keys at the panel: an RFC 4733 event (its three end packets told once) and a SIP INFO
    const event = Buffer.alloc(16);
    event[0] = 0x80;
    event[1] = 101;
    event.writeUInt32BE(9_999, 4);
    event[12] = 5; // "5"
    for (const end of [false, true, true, true]) {
      event[13] = end ? 0x8a : 0x0a;
      w.panel.rtp.send(event, answer.port, '127.0.0.1');
    }
    w.panel.send(inDialog(w.panel, ok, 'INFO', 21, 'Content-Type: application/dtmf-relay\n', 'Signal=#\nDuration=160\n'), w.server.port);
    await w.panel.next((m) => m.status === 200 && header(m, 'CSeq') === '21 INFO');
    await until(() => w.calls.digits.length === 2);
    assert.deepEqual(w.calls.digits, ['5', '#']);

    // a door that opens by a DTMF code: "#1" as events, each with an end
    w.panel.packets = [];
    assert.equal(await call.dtmf('#1'), true);
    const events = w.panel.packets.map((p) => parseRtp(p)!).filter((p) => p.payloadType === 101);
    const ends = events.filter((p) => p.payload[1] & 0x80);
    assert.deepEqual([...new Set(ends.map((p) => p.payload[0]))], [11, 1]);
    assert.equal(ends.length, 6);
    assert.ok(events.filter((p) => p.marker).length === 2);

    // ViON hangs up: a BYE to the panel's Contact, answered
    const hungUp = call.hangUp();
    const bye = await w.panel.next(method('BYE'));
    assert.equal(textParam(header(bye, 'From'), 'tag'), textParam(header(ok, 'To'), 'tag'), "the BYE comes from ViON's side of the dialog");
    w.panel.send(
      `SIP/2.0 200 OK\nVia: ${header(bye, 'Via')}\nFrom: ${header(bye, 'From')}\nTo: ${header(bye, 'To')}\nCall-ID: ${header(bye, 'Call-ID')}\nCSeq: ${header(bye, 'CSeq')}\nContent-Length: 0\n\n`,
      w.server.port,
    );
    await hungUp;
    assert.deepEqual(w.calls.ends, ['local']);
    assert.equal(call.rtp!.speak(tone, 16_000) instanceof Promise, true);
    assert.equal((await call.rtp!.speak(tone, 16_000)).status, 'failed');
  } finally {
    await w.close();
  }
});

test('the visitor gives up while it rings: CANCEL, 487 for the INVITE until its ACK', async () => {
  const w = await world();
  try {
    w.panel.send(invite(w.panel, 'call-2@127.0.0.1'), w.server.port);
    await w.panel.next(status(180));
    w.panel.send(
      `CANCEL sip:vion@127.0.0.1 SIP/2.0\nVia: SIP/2.0/UDP 127.0.0.1:${w.panel.sipPort};rport;branch=z9hG4bK1803457221\nFrom: "Gate" <sip:100@127.0.0.1:${w.panel.sipPort}>;tag=1438281950\nTo: <sip:vion@127.0.0.1>\nCall-ID: call-2@127.0.0.1\nCSeq: 20 CANCEL\nMax-Forwards: 70\nContent-Length: 0\n\n`,
      w.server.port,
    );
    await w.panel.next((m) => m.status === 200 && header(m, 'CSeq') === '20 CANCEL');
    const terminated = await w.panel.next(status(487));
    await w.panel.next(status(487), 500); // resent while no ACK
    w.panel.send(ack(w.panel, terminated), w.server.port);
    assert.deepEqual(w.calls.ends, ['cancel']);
    await sleep(T1 * 6);
    w.panel.messages = w.panel.messages.filter((m) => m.status !== 487);
    await sleep(T1 * 8);
    assert.equal(w.panel.messages.filter((m) => m.status === 487).length, 0, 'not resent after the ACK');
  } finally {
    await w.close();
  }
});

test('the INVITE again rings once; a second call from the busy panel is turned away', async () => {
  const w = await world();
  try {
    w.panel.send(invite(w.panel, 'call-3@127.0.0.1'), w.server.port);
    await w.panel.next(status(180));
    w.panel.send(invite(w.panel, 'call-3@127.0.0.1'), w.server.port);
    await w.panel.next(status(180));
    assert.equal(w.calls.rung.length, 1);
    w.panel.send(invite(w.panel, 'call-4@127.0.0.1', undefined, 'z9hG4bK999'), w.server.port);
    await w.panel.next(status(486));
  } finally {
    await w.close();
  }
});

test('the panel hangs up: BYE ends the call', async () => {
  const w = await world();
  try {
    w.panel.send(invite(w.panel, 'call-5@127.0.0.1'), w.server.port);
    await until(() => w.calls.rung.length === 1);
    const accepted = w.calls.rung[0].accept();
    const ok = await w.panel.next(status(200));
    w.panel.send(ack(w.panel, ok), w.server.port);
    await accepted;
    w.panel.send(inDialog(w.panel, ok, 'BYE', 21), w.server.port);
    await w.panel.next((m) => m.status === 200 && header(m, 'CSeq') === '21 BYE');
    assert.deepEqual(w.calls.ends, ['bye']);
    assert.equal(w.calls.rung[0].state, 'ended');
  } finally {
    await w.close();
  }
});

test('an answer never confirmed: the 200 is resent, then the call is given up with a BYE', async () => {
  const w = await world();
  try {
    w.panel.send(invite(w.panel, 'call-6@127.0.0.1'), w.server.port);
    await until(() => w.calls.rung.length === 1);
    const accepted = w.calls.rung[0].accept();
    await w.panel.next(status(200));
    await w.panel.next(status(200), 500);
    await assert.rejects(accepted, /did not confirm/);
    assert.deepEqual(w.calls.ends, ['timeout']);
    await w.panel.next(method('BYE'), 500);
  } finally {
    await w.close();
  }
});

test('no G.711 in the offer: 488, and no ring', async () => {
  const w = await world();
  try {
    const sdp = `v=0\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio ${w.panel.rtpPort} RTP/AVP 18\na=rtpmap:18 G729/8000\n`;
    w.panel.send(invite(w.panel, 'call-7@127.0.0.1', sdp), w.server.port);
    await w.panel.next(status(488));
    assert.equal(w.calls.rung.length, 0);
  } finally {
    await w.close();
  }
});

test('a stranger on the network gets no answer at all; the panel is answered OPTIONS', async () => {
  const w = await world();
  const stranger = await Panel.open('127.0.0.2');
  try {
    stranger.send(invite(stranger, 'call-8@127.0.0.2').replace(/127\.0\.0\.1/g, '127.0.0.2'), w.server.port);
    stranger.send(
      `OPTIONS sip:vion@127.0.0.1 SIP/2.0\nVia: SIP/2.0/UDP 127.0.0.2:${stranger.sipPort};branch=z9hG4bK5\nFrom: <sip:x@127.0.0.2>;tag=1\nTo: <sip:vion@127.0.0.1>\nCall-ID: o1\nCSeq: 1 OPTIONS\nContent-Length: 0\n\n`,
      w.server.port,
    );
    await sleep(200);
    assert.equal(stranger.messages.length, 0);
    assert.equal(w.calls.rung.length, 0);
    w.panel.send(
      `OPTIONS sip:vion@127.0.0.1 SIP/2.0\nVia: SIP/2.0/UDP 127.0.0.1:${w.panel.sipPort};rport;branch=z9hG4bK6\nFrom: <sip:100@127.0.0.1>;tag=1\nTo: <sip:vion@127.0.0.1>\nCall-ID: o2\nCSeq: 1 OPTIONS\nContent-Length: 0\n\n`,
      w.server.port,
    );
    const ok = await w.panel.next(status(200));
    assert.match(header(ok, 'Via') ?? '', new RegExp(`rport=${w.panel.sipPort}`));
    assert.ok(w.calls.seenCount >= 1);
  } finally {
    stranger.close();
    await w.close();
  }
});

const rubetek = checkProfile(JSON.parse(readFileSync(new URL('../profiles/rubetek-rv-34xx-sip.json', import.meta.url), 'utf8'))) as PanelProfile;

/** A voice activity detector that calls every 640 samples of sound an utterance. */
class CountingVad implements VoiceActivity {
  private heard: number[] = [];
  private done: Float32Array[] = [];
  accept(samples: Float32Array): void {
    for (const sample of samples) this.heard.push(sample);
    while (this.heard.length >= 640) this.done.push(Float32Array.from(this.heard.splice(0, 640)));
  }
  utterance(): Float32Array | undefined {
    return this.done.shift();
  }
  speaking(): boolean {
    return this.heard.length > 0;
  }
  flush(): void {
    this.heard = [];
  }
}

const engine: SpeechEngine = {
  synthesize: async (): Promise<Audio> => ({ samples: new Float32Array(1_600).fill(0.2), sampleRate: 16_000 }),
  transcribe: async (samples) => `heard ${samples.length}`,
  voiceActivity: async () => new CountingVad(),
} as unknown as SpeechEngine;

async function sipWorld(profile: PanelProfile = rubetek) {
  const server = new SipServer({ port: 0, t1Ms: T1, localAddress: async () => '127.0.0.1' });
  await server.start();
  const panel = await Panel.open();
  const events: [PanelEventKind, Record<string, string>][] = [];
  let online = false;
  const engine = new SipPanel(
    profile,
    { host: '127.0.0.1', username: 'admin', password: 'x' },
    { event: (kind, fields) => events.push([kind, fields]), online: (ok) => (online = ok) },
    () => server,
  );
  engine.start();
  return { server, panel, events, engine, online: () => online, close: async () => (engine.stop(), panel.close(), await server.stop()) };
}

test('a SIP panel: the call rings, a code typed at the panel comes whole, the panel hanging up ends it', async () => {
  const w = await sipWorld();
  try {
    w.panel.send(invite(w.panel, 'p-1@127.0.0.1'), w.server.port);
    await until(() => w.events.length === 1);
    assert.deepEqual(w.events[0], ['ring', { caller: 'Gate' }]);
    assert.ok(w.online(), 'a panel that called is there');
    assert.ok(w.engine.call);
    // ViON answered (a person took it): the panel's call is answered
    const answered = w.engine.answered();
    const ok = await w.panel.next(status(200));
    w.panel.send(ack(w.panel, ok), w.server.port);
    assert.deepEqual(await answered, { ok: true });
    // "1 2 3 4 #" as SIP INFO: one code
    let seq = 30;
    for (const digit of ['1', '2', '3', '4', '#']) {
      w.panel.send(inDialog(w.panel, ok, 'INFO', seq++, 'Content-Type: application/dtmf-relay\n', `Signal=${digit}\nDuration=160\n`), w.server.port);
    }
    await until(() => w.events.length === 2);
    assert.deepEqual(w.events[1], ['code', { digits: '1234' }]);
    w.panel.send(inDialog(w.panel, ok, 'BYE', seq++), w.server.port);
    await until(() => w.events.length === 3);
    assert.deepEqual(w.events[2], ['call_end', { why: 'bye' }]);
    assert.equal(w.engine.call, undefined);
  } finally {
    await w.close();
  }
});

test('ViON ends a call that still rings: the panel hears "busy"; a DTMF door needs a call', async () => {
  const dtmfDoor = { ...rubetek, doors: [{ key: '1', name: 'Calitka', open: { dtmf: '#1' } }] } as PanelProfile;
  const w = await sipWorld(dtmfDoor);
  try {
    assert.match((await w.engine.open('1')).error ?? '', /not calling/);
    w.panel.send(invite(w.panel, 'p-2@127.0.0.1'), w.server.port);
    await until(() => Boolean(w.engine.call));
    await w.engine.hangUp();
    await w.panel.next(status(486));
    assert.deepEqual(
      w.events.map(([kind]) => kind),
      ['ring'],
      "ViON's own end is not told back to ViON",
    );
    // a new call: the door opens by its code, the ringing call answered first
    w.panel.send(invite(w.panel, 'p-3@127.0.0.1', undefined, 'z9hG4bK31'), w.server.port);
    await until(() => w.events.length === 2);
    const opening = w.engine.open('1');
    const ok = await w.panel.next(status(200));
    w.panel.send(ack(w.panel, ok), w.server.port);
    assert.deepEqual(await opening, { ok: true });
    const ends = w.panel.packets.map((p) => parseRtp(p)!).filter((p) => p.payloadType === 101 && p.payload[1] & 0x80);
    assert.deepEqual([...new Set(ends.map((p) => p.payload[0]))], [11, 1]);
  } finally {
    await w.close();
  }
});

test("the agent's sound in a SIP call: it answers the call, speaks into it, hears the visitor, stops with the call", async () => {
  const w = await sipWorld();
  try {
    w.panel.send(invite(w.panel, 'p-4@127.0.0.1'), w.server.port);
    await until(() => Boolean(w.engine.call));
    const io = sipSound({
      call: () => w.engine.call,
      engine,
      cache: new PhraseCache(engine),
      clock: { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      language: () => 'ru',
      speed: () => 1,
    });
    const listening = io.listen();
    const ok = await w.panel.next(status(200));
    w.panel.send(ack(w.panel, ok), w.server.port);
    const audio = await listening;
    const heard: number[] = [];
    audio.hearing.onUtterance((samples) => heard.push(samples.length));
    const answer = parseSdp(ok.body)!;
    const packet = Buffer.alloc(172, 0x2a);
    packet[0] = 0x80;
    packet[1] = 8;
    for (let i = 0; i < 4; i++) {
      packet.writeUInt16BE(i, 2);
      w.panel.rtp.send(packet, answer.port, '127.0.0.1');
    }
    await until(() => heard.length >= 1);
    assert.equal(heard[0], 640);
    const phrase = await io.prepare('Здравствуйте');
    assert.equal(phrase.durationMs, 100);
    assert.equal((await phrase.play()).status, 'spoken');
    w.panel.send(inDialog(w.panel, ok, 'BYE', 40), w.server.port);
    assert.equal(await audio.ended, 'the panel ended the call (bye)');
    assert.equal((await phrase.play()).status, 'failed', 'nothing to say into an ended call');
  } finally {
    await w.close();
  }
});

void runTests();
