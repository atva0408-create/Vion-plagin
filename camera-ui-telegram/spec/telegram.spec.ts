// The plugin as ViON drives it, against a stand-in of the Telegram Bot API (fetch replaced): a chat linked by the
// one-time link of a ViON user, a wrong or old link, the picture with its words, silent and with a button, a chat that
// blocked the bot, a «too many requests», /stop, unlinking and renaming, a token Telegram refuses, the place to read
// from kept over a restart, and the token never in a log line.
// Run: npx tsx spec/telegram.spec.ts
import assert from 'node:assert/strict';

import Telegram from '../src/index.js';
import { BotApiError, TelegramBot } from '../src/bot.js';
import { chatDeviceId, linkChat, LINK_TTL_MS, startCode } from '../src/links.js';
import { CAPTION_MAX, messageOf } from '../src/message.js';

import type { TgUpdate } from '../src/bot.js';

const TOKEN = '123456:SECRET-token';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end; ) await sleep(10);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

interface Call {
  method: string;
  body: Record<string, unknown>;
  photo?: number[];
}

/** The Bot API: answers each method, keeps what was asked, gives the updates queued, and refuses as it is told. */
function fakeTelegram() {
  const calls: Call[] = [];
  const updates: TgUpdate[] = [];
  const refuse: Record<string, { status: number; description: string; retryAfter?: number }[]> = {};
  let me: { status: number } | undefined;
  let unreachable = false;
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (unreachable) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo EAI_AGAIN api.telegram.org') });
    const url = String(input);
    const match = /\/bot([^/]+)\/(\w+)$/.exec(url);
    assert.ok(match, `a Bot API address: ${url}`);
    assert.equal(match[1], TOKEN, 'the token is in the address');
    const method = match[2]!;
    let body: Record<string, unknown> = {};
    let photo: number[] | undefined;
    if (init?.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        if (typeof value === 'string') body[key] = value;
        else photo = Array.from(new Uint8Array(await value.arrayBuffer()));
      }
    } else if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body, ...(photo ? { photo } : {}) });
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const refusal = refuse[method]?.shift();
    if (refusal) return reply(refusal.status, { ok: false, description: refusal.description, ...(refusal.retryAfter ? { parameters: { retry_after: refusal.retryAfter } } : {}) });
    if (method === 'getMe') return me ? reply(me.status, { ok: false, description: 'Unauthorized' }) : reply(200, { ok: true, result: { id: 1, is_bot: true, first_name: 'ViON', username: 'vion_home_bot' } });
    if (method === 'getUpdates') {
      const offset = Number(body.offset ?? 0);
      const due = updates.filter((update) => update.update_id >= offset);
      if (!due.length) {
        // long polling: nothing yet; a short wait instead of 50 s
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 20);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      return reply(200, { ok: true, result: due });
    }
    return reply(200, { ok: true, result: method === 'deleteWebhook' ? true : { message_id: calls.length, chat: { id: Number(body.chat_id), type: 'private' } } });
  };
  return {
    calls,
    updates,
    refuse,
    fetch,
    refuseMe: (status: number) => (me = { status }),
    setUnreachable: (value: boolean) => (unreachable = value),
    sent: (method?: string) => calls.filter((call) => (method ? call.method === method : call.method === 'sendMessage' || call.method === 'sendPhoto')),
  };
}

function host(values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const say = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const logger = { log: say, warn: say, error: say, debug: () => {}, success: say, trace: () => {}, attention: say };
  const storage = {
    values,
    async setValue(key: string, value: unknown) {
      values[key] = value;
    },
    async setInternalValue(key: string, value: unknown) {
      values[key] = JSON.parse(JSON.stringify(value));
    },
  };
  const api = { on: () => api };
  const plugin = new Telegram(logger as never, api as never, storage as never);
  return { plugin, values, lines };
}

const realFetch = globalThis.fetch;
const tg = fakeTelegram();
globalThis.fetch = tg.fetch as typeof fetch;
let update = 0;
const opens = (text: string, chat = { id: 111, type: 'private', username: 'anna' }) => tg.updates.push({ update_id: ++update, message: { message_id: update, chat, text } });

try {
  // ---- the parts: the code of /start, a link used once and only while good, the words cut to the limit, escaped
  {
    assert.equal(startCode('/start abcDEF12_-x'), 'abcDEF12_-x');
    assert.equal(startCode('/start@vion_home_bot abcDEF12_-x'), 'abcDEF12_-x');
    assert.equal(startCode('/start'), undefined);
    assert.equal(startCode('/start a b'), undefined);
    const chat = { id: 5, type: 'private', first_name: 'Борис' };
    const pending = [{ code: 'code12345', ownerUserId: 'u2', expiresAt: 1000 + LINK_TTL_MS }];
    const used = linkChat([], pending, 'code12345', chat, 1000);
    assert.deepEqual(used.linked, { id: chatDeviceId(5, 'u2'), ownerUserId: 'u2', chatId: 5, name: 'Борис', active: true, linkedAt: 1000 });
    assert.equal(linkChat(used.chats, used.pending, 'code12345', chat, 1001).reason, 'unknown', 'a link links once');
    assert.equal(linkChat([], pending, 'code12345', chat, 1000 + LINK_TTL_MS + 1).reason, 'unknown', 'an old link links nobody');

    const long = messageOf({ title: 'Комната: Стена', body: '<'.repeat(2000) }, CAPTION_MAX);
    assert.ok(long.length <= CAPTION_MAX, `cut to the caption: ${long.length}`);
    assert.ok(long.startsWith('<b>Комната: Стена</b>\n&lt;'));
    assert.ok(!/&[a-z]*…|&…/.test(long), 'never cut inside an escape');
    assert.equal(messageOf({ title: 'A & B', subtitle: 'x', body: '<y>' }, 4096), '<b>A &amp; B</b>\nx\n&lt;y&gt;');
  }

  // ---- no token: said, and no link to give
  {
    const { plugin, lines } = host();
    plugin.start();
    assert.ok(lines.some((line) => /no bot token yet/.test(line)));
    await assert.rejects(plugin.registerDevice('u1'), /not connected/);
  }

  // ---- linked by its link, the notifications of its user only
  const { plugin, values, lines } = host({ botToken: TOKEN, linkBase: 'https://vion.example.com/' });
  plugin.start();
  await until(() => lines.some((line) => /bot @vion_home_bot ready/.test(line)), 'the bot ready');
  assert.ok(tg.calls.some((call) => call.method === 'deleteWebhook'), 'a webhook of another program is dropped');
  const link = await plugin.registerDevice('u1');
  assert.equal(link.active, false);
  const url = String(link.metadata?.link);
  assert.match(url, /^https:\/\/t\.me\/vion_home_bot\?start=[A-Za-z0-9_-]{16}$/);
  opens(`/start ${url.split('=')[1]}`);
  await until(() => tg.sent('sendMessage').length === 1, 'the answer to the link');
  assert.equal(tg.sent('sendMessage')[0]!.body.chat_id, 111);
  assert.match(String(tg.sent('sendMessage')[0]!.body.text), /^Готово/);
  assert.deepEqual(await plugin.getDevices(['u1', 'u3']), [
    { id: 'tg:111:u1', ownerUserId: 'u1', name: '@anna', active: true, metadata: { chatId: 111, linkedAt: (values._chats as { linkedAt: number }[])[0]!.linkedAt } },
  ]);
  assert.deepEqual(await plugin.getDevices(['u2']), [], 'not another user\'s');
  await until(() => values._offset === update + 1, 'the place to read from kept');

  // ---- a wrong link, a bare /start
  opens('/start nosuchcode123');
  opens('/start', { id: 222, type: 'private', username: 'boris' });
  await until(() => tg.sent('sendMessage').length === 3, 'two more answers');
  assert.match(String(tg.sent('sendMessage')[1]!.body.text), /^Ссылка устарела/);
  assert.match(String(tg.sent('sendMessage')[2]!.body.text), /^Это бот уведомлений ViON/);
  assert.equal((await plugin.getDevices(['u1'])).length, 1);

  // ---- a zone rule's notice: the picture, the words bold title first, silent, the button to the moment
  await plugin.sendNotification(['tg:111:u1', 'tg:999:u9'], {
    title: 'Комната: Стена',
    body: 'Кот точит когти о стену',
    thumbnail: new Uint8Array([255, 216, 9]),
    silent: true,
    deepLink: '/cameras/%D0%9A%D0%BE%D0%BC%D0%BD%D0%B0%D1%82%D0%B0?startTs=1',
  });
  const photo = tg.sent('sendPhoto')[0]!;
  assert.equal(photo.body.chat_id, '111');
  assert.deepEqual(photo.photo, [255, 216, 9]);
  assert.equal(photo.body.caption, '<b>Комната: Стена</b>\nКот точит когти о стену');
  assert.equal(photo.body.parse_mode, 'HTML');
  assert.equal(photo.body.disable_notification, 'true');
  assert.deepEqual(JSON.parse(String(photo.body.reply_markup)), {
    inline_keyboard: [[{ text: 'Открыть в ViON', url: 'https://vion.example.com/cameras/%D0%9A%D0%BE%D0%BC%D0%BD%D0%B0%D1%82%D0%B0?startTs=1' }]],
  });
  assert.equal(tg.sent().length, 4, 'nothing to a chat that is not linked');
  // words alone, with sound
  await plugin.sendNotification(['tg:111:u1'], { title: 'Сервер', body: 'Обновление' });
  const text = tg.sent('sendMessage').at(-1)!;
  assert.equal(text.body.text, '<b>Сервер</b>\nОбновление');
  assert.equal(text.body.disable_notification, undefined);

  // ---- a «too many requests» waited out once
  tg.refuse.sendMessage = [{ status: 429, description: 'Too Many Requests: retry after 1', retryAfter: 1 }];
  const before = tg.sent('sendMessage').length;
  const started = Date.now();
  await plugin.sendNotification(['tg:111:u1'], { title: 'Ещё' });
  assert.equal(tg.sent('sendMessage').length - before, 2, 'tried twice: refused, then sent');
  assert.equal(tg.sent('sendMessage').at(-1)!.body.text, '<b>Ещё</b>');
  assert.ok(Date.now() - started >= 900, 'the second try waited what Telegram asked');

  // ---- renamed, switched off and on, by the person's settings
  assert.deepEqual(await plugin.updateDevice('tg:111:u1', { name: 'Анна', active: false }), {
    id: 'tg:111:u1',
    ownerUserId: 'u1',
    name: 'Анна',
    active: false,
    metadata: { chatId: 111, linkedAt: (values._chats as { linkedAt: number }[])[0]!.linkedAt },
  });
  const quiet = tg.sent().length;
  await plugin.sendNotification(['tg:111:u1'], { title: 'Тихо' });
  assert.equal(tg.sent().length, quiet, 'a switched-off chat gets nothing');
  await plugin.updateDevice('tg:111:u1', { active: true });
  assert.equal(await plugin.updateDevice('nope', { active: true }), null, 'not ours: the next notifier is asked');

  // ---- a chat that blocked the bot is switched off, not tried every time
  tg.refuse.sendMessage = [{ status: 403, description: 'Forbidden: bot was blocked by the user' }];
  await plugin.sendNotification(['tg:111:u1'], { title: 'Заблокирован' });
  assert.equal((await plugin.getDevice('tg:111:u1'))?.active, false);
  assert.ok(lines.some((line) => /blocked the bot or left: switched off/.test(line)));
  await plugin.updateDevice('tg:111:u1', { active: true });

  // ---- /stop from the chat, then unlinking from ViON
  opens('/stop');
  await until(() => (values._chats as unknown[]).length === 0, 'the chat unlinked by /stop');
  const second = await plugin.registerDevice('u1');
  opens(`/start ${String(second.metadata?.link).split('=')[1]}`);
  await until(() => (values._chats as unknown[]).length === 1, 'linked again');
  await plugin.revokeDevice('tg:111:u1');
  assert.deepEqual(values._chats, []);
  assert.match(String(tg.sent('sendMessage').at(-1)!.body.text), /отключены/);

  // ---- a restart reads from where it left: nothing answered twice
  plugin.stop();
  const answered = tg.sent().length;
  const again = host(values);
  again.plugin.start();
  await until(() => again.lines.some((line) => /ready/.test(line)), 'ready again');
  await sleep(100);
  assert.equal(tg.sent().length, answered, 'the old messages are not answered again');
  again.plugin.stop();

  // ---- a token Telegram refuses: said once, and nothing more is asked
  tg.refuseMe(401);
  const refused = host({ botToken: TOKEN });
  refused.plugin.start();
  await until(() => refused.lines.some((line) => /token is not accepted/.test(line)), 'the refusal said');
  const asked = tg.calls.length;
  await sleep(100);
  assert.equal(tg.calls.length, asked, 'no more requests with a refused token');
  assert.ok(!refused.lines.some((line) => /trying again/.test(line)), 'a refused token is not tried again');

  // ---- Telegram out of reach: why, without the token
  tg.setUnreachable(true);
  await assert.rejects(new TelegramBot(TOKEN).getMe(), (error: unknown) => error instanceof BotApiError && /not reachable \(getaddrinfo/.test(error.message) && !error.message.includes(TOKEN));
  tg.setUnreachable(false);
  for (const line of [...lines, ...refused.lines, ...again.lines]) assert.ok(!line.includes('SECRET'), `the token in a log line: ${line}`);

  console.log('telegram.spec: linked by a link, wrong and old links, picture and words, silent, button, 429, 403, /stop, unlink, rename, restart, refused token, no token in logs — ok');
} finally {
  globalThis.fetch = realFetch;
}
process.exit(0);
