// The agent's conversation with sound, played on fakes: phrases one at a time, deaf while speaking, the echo ignored,
// "one moment" when the LLM is slow, the owner's words, silence, the voice message, a take-over. Run:
// npx tsx spec/conversation.spec.ts
import assert from 'node:assert/strict';

import { Hearing } from '@vionvision/speech';

import { FakeClock, flush, runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { Conversation } from '../src/agent/conversation.js';
import { DoorAgent } from '../src/agent/dialog.js';

import type { AssistantAskResult } from '@camera.ui/sdk';
import type { SpeakResult, VoiceActivity } from '@vionvision/speech';
import type { AgentAction, AgentWorld } from '../src/agent/dialog.js';
import type { ConversationIO } from '../src/agent/conversation.js';
import type { Instruction } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 13, 11, 5);

/** Voice activity that ends an utterance at a 0 sample (other values are speech). */
class FakeVad implements VoiceActivity {
  private current: number[] = [];
  private done: Float32Array[] = [];
  accept(samples: Float32Array): void {
    for (const sample of samples) {
      if (sample !== 0) this.current.push(sample);
      else if (this.current.length) {
        this.done.push(Float32Array.from(this.current));
        this.current = [];
      }
    }
  }
  utterance(): Float32Array | undefined {
    return this.done.shift();
  }
  speaking(): boolean {
    return this.current.length > 0;
  }
  flush(): void {
    if (this.current.length) this.done.push(Float32Array.from(this.current));
    this.current = [];
  }
}

/** Phrases the "visitor" says, as samples whose first value is the index of the text. */
class Rig {
  clock = new FakeClock(NOW);
  hearing = new Hearing(new FakeVad(), this.clock);
  said: string[] = [];
  actions: AgentAction[] = [];
  voicemails: Float32Array[] = [];
  private texts: string[] = [];
  io: ConversationIO = {
    prepare: async (text) => ({
      durationMs: 1_000,
      play: async (): Promise<SpeakResult> => {
        this.said.push(text);
        return { status: 'spoken' };
      },
    }),
    listen: async () => ({ hearing: this.hearing, ended: new Promise(() => undefined), stop: () => undefined }),
    transcribe: async (samples) => this.texts[samples[0] - 1] ?? '',
  };

  /** The visitor says it (the microphone hears it now). */
  speak(text: string): void {
    this.texts.push(text);
    this.hearing.feed(Float32Array.from([this.texts.length, this.texts.length, 0]));
  }

  agent(over: Partial<AgentWorld> = {}): DoorAgent {
    return new DoorAgent({
      language: 'ru',
      timeZone: 'Europe/Moscow',
      clock: this.clock,
      panel: { id: 'gate', name: 'Калитка' },
      doors: [{ id: 'gate', name: 'Калитка' }],
      people: [],
      instructions: () => [],
      codes: () => [],
      identifications: () => [],
      recordNotice: true,
      verifyDigits: async () => undefined,
      maxTurns: 8,
      turnTimeoutMs: 6_000,
      ...over,
    });
  }

  conversation(agent: DoorAgent): Conversation {
    return new Conversation(agent, this.io, this.clock, {
      action: (action) => this.actions.push(action),
      said: () => undefined,
      voicemail: (samples) => this.voicemails.push(samples),
    });
  }

  /** Moves time on in small steps, letting the conversation run between them. */
  async pass(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 250) {
      await flush(10);
      await this.clock.advance(250);
    }
    await flush(10);
  }
}

const ozon: Instruction = {
  id: 'ozon',
  createdBy: 'u1',
  createdAt: NOW,
  text: 'курьер Озона',
  panels: 'all',
  when: { kind: 'window', from: NOW - 1, to: NOW + 3_600_000 },
  once: true,
  expect: { label: 'курьер Озона', companies: ['Озон'] },
  minIdentification: 'weak',
  say: 'Оставьте у калитки.',
  sayVerbatim: true,
  callOwner: 'if_needed',
  notify: 'normal',
  record: true,
};

test("a conversation without the LLM: greeting, the instruction by the service named, the visitor's words as the message, the end", async () => {
  const rig = new Rig();
  const run = rig.conversation(rig.agent({ instructions: () => [ozon] })).run();
  await rig.pass(3_000);
  assert.deepEqual(rig.said, ['Здравствуйте! Разговор записывается. Чем могу помочь?']);
  rig.speak('Я из Озона');
  await rig.pass(2_500);
  assert.equal(rig.said[1], 'Хозяева просили передать: Оставьте у калитки.');
  await rig.pass(1_000);
  rig.speak('Хорошо, оставил');
  await rig.pass(2_500);
  assert.equal(await run, 'message');
  assert.ok(rig.actions.some((a) => a.kind === 'instruction'));
});

test('deaf while it speaks: what the microphone hears then is not an answer; the echo after it is not either', async () => {
  const rig = new Rig();
  const conversation = rig.conversation(rig.agent());
  const run = conversation.run();
  await flush(10);
  rig.speak('Здравствуйте! Разговор записывается.');
  await rig.pass(3_000);
  rig.speak('разговор записывается чем могу помочь');
  await rig.pass(2_000);
  assert.deepEqual(rig.said, ['Здравствуйте! Разговор записывается. Чем могу помочь?'], 'neither its own voice nor its echo answered');
  conversation.stop('taken_over');
  assert.equal(await run, 'taken_over');
});

test('a slow LLM: "Секунду." is said once while it thinks, then its answer', async () => {
  const rig = new Rig();
  const ask: AgentWorld['ask'] = () =>
    new Promise<AssistantAskResult>((resolve) =>
      rig.clock.setTimeout(() => {
        const turn = {
          say: 'Как вас зовут?',
          visitor: { name: null, company: null, category: null, purpose: 'вопрос', callback: null, message: null },
          intent: 'continue',
          flags: { emergency: false, threat: false, probing: false, manipulation: false },
        };
        resolve({ ok: true, text: '', json: turn, usage: { promptTokens: 0, completionTokens: 0 } });
      }, 4_000),
    );
  const conversation = rig.conversation(rig.agent({ ask }));
  const run = conversation.run();
  await rig.pass(3_000);
  rig.speak('Здравствуйте, мне нужен хозяин');
  await rig.pass(6_000);
  assert.deepEqual(rig.said.slice(1), ['Секунду.', 'Как вас зовут?']);
  conversation.stop('taken_over');
  await run;
});

test('an answer that comes while "Секунду." is still being said waits for it: the camera says one phrase at a time', async () => {
  const rig = new Rig();
  // a camera speaker: a phrase lasts its second, and one asked meanwhile is refused as CameraSpeaker does
  let speaking = false;
  const refused: string[] = [];
  rig.io.prepare = async (text) => ({
    durationMs: 1_000,
    play: async (): Promise<SpeakResult> => {
      if (speaking) {
        refused.push(text);
        return { status: 'busy', reason: 'the camera is already speaking' };
      }
      speaking = true;
      rig.said.push(text);
      await new Promise((resolve) => rig.clock.setTimeout(resolve, 1_000));
      speaking = false;
      return { status: 'spoken' };
    },
  });
  const ask: AgentWorld['ask'] = () =>
    new Promise<AssistantAskResult>((resolve) =>
      // "Секунду." begins at 1.5 s and lasts to 2.5 s: the answer comes in the middle of it
      rig.clock.setTimeout(() => {
        const turn = {
          say: 'Как вас зовут?',
          visitor: { name: null, company: null, category: null, purpose: 'вопрос', callback: null, message: null },
          intent: 'continue',
          flags: { emergency: false, threat: false, probing: false, manipulation: false },
        };
        resolve({ ok: true, text: '', json: turn, usage: { promptTokens: 0, completionTokens: 0 } });
      }, 1_900),
    );
  const conversation = rig.conversation(rig.agent({ ask }));
  const run = conversation.run();
  await rig.pass(3_000);
  rig.speak('Здравствуйте, мне нужен хозяин');
  await rig.pass(6_000);
  assert.deepEqual(refused, [], 'no phrase was refused');
  assert.deepEqual(rig.said.slice(1), ['Секунду.', 'Как вас зовут?']);
  conversation.stop('taken_over');
  await run;
});

test("the owner's words are said between the visitor's phrases; a take-over stops the agent without a phrase", async () => {
  const rig = new Rig();
  const conversation = rig.conversation(rig.agent());
  const run = conversation.run();
  await rig.pass(2_000);
  conversation.ownerSays('Спущусь через минуту', 'u1');
  await rig.pass(2_000);
  assert.equal(rig.said.at(-1), 'Спущусь через минуту');
  const count = rig.said.length;
  conversation.stop('taken_over');
  assert.equal(await run, 'taken_over');
  assert.equal(rig.said.length, count);
});

test('the owners asked: their answer is waited 45 s, then "cannot answer"', async () => {
  const rig = new Rig();
  const turn = {
    say: 'Секунду',
    visitor: { name: null, company: 'Wildberries', category: 'delivery', purpose: 'посылка', callback: null, message: null },
    intent: 'ask_owner',
    flags: { emergency: false, threat: false, probing: false, manipulation: false },
  };
  const ask: AgentWorld['ask'] = async () => ({ ok: true, text: '', json: turn, usage: { promptTokens: 0, completionTokens: 0 } });
  const conversation = rig.conversation(rig.agent({ ask }));
  const run = conversation.run();
  await rig.pass(3_000);
  rig.speak('Можно оставить у соседей?');
  await rig.pass(3_000);
  assert.equal(rig.said.at(-1), 'Секунду, уточняю у хозяев.');
  assert.ok(rig.actions.some((a) => a.kind === 'ask_owner'));
  await rig.pass(30_000);
  assert.equal(rig.said.at(-1), 'Секунду, уточняю у хозяев.', 'no "can you hear me" while the owners are asked');
  await rig.pass(16_000);
  assert.equal(rig.said.at(-1), 'Хозяева сейчас не могут ответить. Я передам им ваши слова.');
  conversation.stop('taken_over');
  await run;
});

test('nobody answers the greeting: "can you hear me", then the end with nobody', async () => {
  const rig = new Rig();
  const run = rig.conversation(rig.agent()).run();
  await rig.pass(11_000);
  assert.equal(rig.said.at(-1), 'Вы меня слышите? Представьтесь, пожалуйста.');
  await rig.pass(11_000);
  assert.equal(await run, 'nobody');
});

test('the voice message: after the prompt the sound is kept until the visitor pauses, then it ends with the message', async () => {
  const rig = new Rig();
  const run = rig.conversation(rig.agent()).run();
  await rig.pass(3_000);
  rig.speak('...');
  await rig.pass(3_000);
  rig.speak('');
  await rig.pass(4_000);
  assert.equal(rig.said.at(-1), 'Оставьте, пожалуйста, сообщение после сигнала.');
  rig.hearing.feed(Float32Array.from([7, 7, 7, 7]));
  await rig.pass(1_000);
  rig.hearing.feed(Float32Array.from([7, 7, 0]));
  await rig.pass(4_000);
  assert.equal(await run, 'message');
  assert.equal(rig.voicemails.length, 1);
  assert.equal(rig.voicemails[0].length, 7);
  assert.equal(rig.said.at(-1), 'Спасибо, сообщение записано.');
});

test('three minutes at most: the closing phrase', async () => {
  const rig = new Rig();
  const ask: AgentWorld['ask'] = async () => ({
    ok: true,
    text: '',
    json: {
      say: 'Понятно, продолжайте.',
      visitor: { name: 'Иван', company: null, category: null, purpose: 'разговор', callback: null, message: null },
      intent: 'continue',
      flags: { emergency: false, threat: false, probing: false, manipulation: false },
    },
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  const run = rig.conversation(rig.agent({ ask, maxTurns: 100 })).run();
  for (let i = 0; i < 40 && rig.said.at(-1) !== 'Спасибо, я всё передам хозяевам. До свидания!'; i++) {
    await rig.pass(3_000);
    rig.speak(`фраза ${i}`);
    await rig.pass(3_000);
  }
  assert.equal(rig.said.at(-1), 'Спасибо, я всё передам хозяевам. До свидания!');
  assert.equal(await run, 'agent');
  assert.ok(rig.clock.now() - NOW <= 3 * 60_000 + 10_000);
});

void runTests();
