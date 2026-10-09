// The speaker: PCM → A-law → RTP, the packet headers, the 20 ms pace, the queue. Run: npx tsx spec/speaker.spec.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PhraseQueue } from '../src/queue.js';
import { PACKET_MS, SAMPLES_PER_PACKET, alawDecodeSample, alawEncode, alawEncodeSample, packetize, sendPaced, speakerProblem, toPcm8k } from '../src/speaker.js';
import { FakeClock, runTests, test } from './helpers.js';

import type { SpeakResult } from '../src/speaker.js';

/** A recorded phrase: "Voice check. Can you hear me well?" by the public-domain voice of VOICE, 16 kHz 16-bit mono. */
function recording(): { samples: Float32Array; rate: number } {
  const wav = readFileSync(join(import.meta.dirname, 'fixtures', 'phrase-16k.wav'));
  const rate = wav.readUInt32LE(24);
  const dataAt = wav.indexOf('data') + 8;
  const count = (wav.length - dataAt) / 2;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = wav.readInt16LE(dataAt + i * 2) / 32768;
  return { samples, rate };
}

test('A-law: reference values of G.711 (as ffmpeg encodes and decodes them) and a round trip within the quantization step', () => {
  assert.equal(alawEncodeSample(0), 0xd5);
  assert.equal(alawEncodeSample(32767), 0xaa);
  assert.equal(alawEncodeSample(-32768), 0x2a);
  assert.equal(alawEncodeSample(1000), 0xfa);
  assert.equal(alawEncodeSample(-1000), 0x7a);
  // decoding as ffmpeg's pcm_alaw decodes (checked with ffmpeg 6.1)
  assert.deepEqual([0xd5, 0xaa, 0x2a, 0x55, 0xfa].map(alawDecodeSample), [8, 32256, -32256, -8, 1008]);
  for (let x = -32768; x <= 32767; x += 97) {
    const back = alawDecodeSample(alawEncodeSample(x));
    assert.ok(Math.abs(back - x) <= Math.max(16, Math.abs(x) / 16), `${x} → ${back}`);
  }
});

test('14. the recorded phrase: 8 kHz A-law in 20 ms RTP packets with running numbers and timestamps', () => {
  const { samples, rate } = recording();
  const pcm = toPcm8k(samples, rate);
  assert.equal(pcm.length, Math.floor((samples.length * 8000) / rate));
  const alaw = alawEncode(pcm);
  const state = { ssrc: 0x11223344, sequence: 65534, timestamp: 0xffffff00 };
  const packets = packetize(alaw, state);
  assert.equal(packets.length, Math.ceil(alaw.length / SAMPLES_PER_PACKET));
  packets.forEach((packet, i) => {
    assert.equal(packet.length, 12 + SAMPLES_PER_PACKET);
    assert.equal(packet[0], 0x80, 'RTP version 2, no padding, no extension');
    assert.equal(packet[1] & 0x7f, 8, 'payload type 8: PCMA');
    assert.equal(Boolean(packet[1] & 0x80), i === 0, 'marker only on the first packet');
    assert.equal(packet.readUInt16BE(2), (65534 + i) & 0xffff, 'sequence numbers run on and wrap');
    assert.equal(packet.readUInt32BE(4), (0xffffff00 + i * 160) >>> 0, 'timestamps step by 160 samples and wrap');
    assert.equal(packet.readUInt32BE(8), 0x11223344);
  });
  // what the camera gets back is the phrase: the decoded audio follows the original closely
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < pcm.length; i++) {
    const decoded = alawDecodeSample(packets[Math.floor(i / 160)][12 + (i % 160)]);
    signal += pcm[i] ** 2;
    noise += (pcm[i] - decoded) ** 2;
  }
  const snr = 10 * Math.log10(signal / noise);
  assert.ok(snr > 30, `SNR ${snr.toFixed(1)} dB`);
  assert.equal(state.sequence, (65534 + packets.length) & 0xffff, 'the state continues for the next phrase');
});

test('14b. packets leave at the pace of real time, 20 ms apart, without drift from late timers', async () => {
  const fake = new FakeClock(1_000_000);
  // every third timer fires 7 ms late, as a busy event loop does
  let timers = 0;
  const clock = {
    ...fake,
    now: () => fake.now(),
    clearTimeout: (h: unknown) => fake.clearTimeout(h),
    setTimeout: (fn: () => void, ms: number) => fake.setTimeout(fn, ms + (++timers % 3 === 0 ? 7 : 0)),
  };
  const sent: number[] = [];
  const packets = Array.from({ length: 50 }, () => Buffer.alloc(172));
  const done = sendPaced(packets, () => void sent.push(clock.now()), clock);
  await fake.advance(50 * PACKET_MS + 100);
  await done;
  assert.equal(sent.length, 50);
  sent.forEach((at, i) => {
    const late = at - (1_000_000 + i * PACKET_MS);
    assert.ok(late >= 0 && late <= 7, `packet ${i} is ${late} ms off its time`);
  });
  assert.ok(
    sent.some((at, i) => at !== 1_000_000 + i * PACKET_MS),
    'the late timers did fire late',
  );
});

test('9. a camera without a talk channel cannot speak, and says why', () => {
  assert.match(speakerProblem({ sources: [{ backchannelAudioCodec: undefined }] as never, connected: true })!, /no speaker channel/);
  assert.match(speakerProblem({ sources: [{ backchannelAudioCodec: 'opus', backchannelDisabled: true }] as never, connected: true })!, /turned off/);
  assert.match(speakerProblem({ sources: [{ backchannelAudioCodec: 'opus' }] as never, connected: false })!, /offline/);
  assert.equal(speakerProblem({ sources: [{ backchannelAudioCodec: 'opus' }] as never, connected: true }), undefined);
});

test('10. ten phrases in five seconds: said one at a time, those over the limit dropped and logged', async () => {
  const clock = new FakeClock(0);
  const logs: string[] = [];
  const queue = new PhraseQueue(
    clock,
    () => 6,
    (message) => logs.push(message),
  );
  let speaking = 0;
  let most = 0;
  const order: number[] = [];
  const results: Promise<SpeakResult>[] = [];
  for (let i = 0; i < 10; i++) {
    results.push(
      queue.add({
        text: `phrase ${i}`,
        run: async () => {
          speaking++;
          most = Math.max(most, speaking);
          await new Promise((resolve) => clock.setTimeout(() => resolve(undefined), 2_000));
          order.push(i);
          speaking--;
          return { status: 'spoken' };
        },
      }),
    );
    await clock.advance(500);
  }
  await clock.advance(30_000);
  const statuses = (await Promise.all(results)).map((r) => r.status);
  assert.deepEqual(statuses, ['spoken', 'spoken', 'spoken', 'spoken', 'spoken', 'spoken', 'busy', 'busy', 'busy', 'busy']);
  assert.equal(most, 1, 'never two phrases at once');
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  assert.equal(logs.length, 4);
  assert.match(logs[0], /more than 6 phrases a minute/);

  // a minute later the camera may speak again
  await clock.advance(60_000);
  const later = queue.add({ text: 'later', run: async () => ({ status: 'spoken' }) });
  await clock.advance(10);
  assert.equal((await later).status, 'spoken');
});

test('10b. a phrase that fails does not stop the ones behind it', async () => {
  const queue = new PhraseQueue(
    new FakeClock(0),
    () => 6,
    () => undefined,
  );
  const first = queue.add({ text: 'a', run: async () => Promise.reject(new Error('stream lost')) });
  const second = queue.add({ text: 'b', run: async () => ({ status: 'spoken' }) });
  assert.deepEqual(await first, { status: 'failed', reason: 'stream lost' });
  assert.equal((await second).status, 'spoken');
});

test('a talk channel that fails to start does not leave the camera stream open', async () => {
  const { CameraSpeaker } = await import('../src/speaker.js');
  let stopped = 0;
  const session = {
    hasBackchannel: false,
    onError: { subscribe: () => ({ unsubscribe() {} }) },
    onEnded: { subscribe: () => ({ unsubscribe() {} }) },
    startStream: async () => undefined,
    startBackchannel: async () => Promise.reject(new Error('no encoder for the camera codec')),
    sendAudioPacket: async () => undefined,
    stop: async () => void stopped++,
  };
  const source = { backchannelAudioCodec: 'opus', createRtpSession: () => session };
  const camera = { name: 'Детская', connected: true, sources: [source] } as never;
  const speaker = new CameraSpeaker(camera, new FakeClock(0), () => undefined);
  const result = await speaker.speak(new Float32Array(160), 8000);
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /no encoder/);
  assert.equal(stopped, 1, 'the stream opened for the phrase is stopped');
});

test('a packet the server refuses fails the phrase, in the middle or as the last one', async () => {
  for (const failing of [2, 3]) {
    const clock = new FakeClock(0);
    let calls = 0;
    const packets = [Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1)];
    const done = sendPaced(
      packets,
      async () => {
        if (++calls === failing) throw new Error('backchannel closed');
      },
      clock,
    ).then(
      () => 'said',
      (error: Error) => error.message,
    );
    await clock.advance(200);
    assert.equal(await done, 'backchannel closed', `packet ${failing} refused`);
  }
});

test('a talk channel the server ends during a phrase: the phrase failed, and the next one opens a new channel', async () => {
  const { CameraSpeaker } = await import('../src/speaker.js');
  let opened = 0;
  const source = {
    backchannelAudioCodec: 'opus',
    createRtpSession: () => {
      const session = ++opened;
      const ended = new Set<() => void>();
      let sent = 0;
      return {
        hasBackchannel: true,
        onError: { subscribe: () => ({ unsubscribe() {} }) },
        onEnded: {
          subscribe: (listener: () => void) => {
            ended.add(listener);
            return { unsubscribe() {} };
          },
        },
        startStream: async () => undefined,
        startBackchannel: async () => undefined,
        // the first channel ends after its third packet; the server drops the rest without an error
        sendAudioPacket: async () => {
          if (session === 1 && ++sent === 3) ended.forEach((listener) => listener());
        },
        stop: async () => undefined,
      };
    },
  };
  const clock = new FakeClock(0);
  const speaker = new CameraSpeaker({ name: 'Детская', connected: true, sources: [source] } as never, clock, () => undefined);
  const first = speaker.speak(new Float32Array(1600), 16_000);
  await clock.advance(1_000);
  assert.deepEqual(await first, { status: 'failed', reason: 'the talk channel of the camera ended' });
  const second = speaker.speak(new Float32Array(1600), 16_000);
  await clock.advance(1_000);
  assert.equal((await second).status, 'spoken');
  assert.equal(opened, 2);
});

/** A talk channel that counts what it opened, sent and stopped. */
function countingSource() {
  const counts = { opened: 0, packets: 0, stops: 0 };
  const source = {
    backchannelAudioCodec: 'opus',
    createRtpSession: () => {
      counts.opened++;
      return {
        hasBackchannel: true,
        onError: { subscribe: () => ({ unsubscribe() {} }) },
        onEnded: { subscribe: () => ({ unsubscribe() {} }) },
        startStream: async () => undefined,
        startBackchannel: async () => undefined,
        sendAudioPacket: async () => void counts.packets++,
        stop: async () => void counts.stops++,
      };
    },
  };
  return { counts, camera: { name: 'Калитка', connected: true, sources: [source] } as never };
}

test('a phrase given while another is said is busy and sends nothing; the camera speaks again after it', async () => {
  const { CameraSpeaker } = await import('../src/speaker.js');
  const { counts, camera } = countingSource();
  const clock = new FakeClock(0);
  const speaker = new CameraSpeaker(camera, clock, () => undefined);
  const first = speaker.speak(new Float32Array(1600), 16_000);
  await clock.advance(100);
  assert.deepEqual(await speaker.speak(new Float32Array(1600), 16_000), { status: 'busy', reason: 'the camera is already speaking' });
  await clock.advance(1_000);
  assert.equal((await first).status, 'spoken');
  assert.equal(counts.packets, 15, 'the first phrase alone went out: 0.1 s and 0.2 s of lead');
  assert.equal(counts.opened, 1);
  const next = speaker.speak(new Float32Array(1600), 16_000);
  await clock.advance(1_000);
  assert.equal((await next).status, 'spoken');
});

test('a signal stops the phrase between packets; a disposed speaker opens nothing more', async () => {
  const { CameraSpeaker } = await import('../src/speaker.js');
  const { counts, camera } = countingSource();
  const clock = new FakeClock(0);
  const speaker = new CameraSpeaker(camera, clock, () => undefined);
  const controller = new AbortController();
  const phrase = speaker.speak(new Float32Array(16_000), 16_000, controller.signal);
  await clock.advance(200);
  const sent = counts.packets;
  controller.abort(new Error('the camera was released'));
  await clock.advance(2_000);
  assert.deepEqual(await phrase, { status: 'failed', reason: 'the camera was released' });
  assert.equal(counts.packets, sent, 'nothing sent after the abort');
  assert.equal(counts.stops, 1, 'its stream is stopped');
  await speaker.dispose();
  assert.equal((await speaker.speak(new Float32Array(160), 8000)).status, 'failed');
  assert.equal(counts.opened, 1, 'no stream for a phrase that came after the camera was released');
});

void runTests();
