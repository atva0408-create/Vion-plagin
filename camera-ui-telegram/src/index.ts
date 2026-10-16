import { API_EVENT, ServicePlugin } from '@camera.ui/sdk';

import { BotApiError, TelegramBot } from './bot.js';
import { chatName, fresh, isStop, LINK_TTL_MS, linkChat, MAX_PENDING, newCode, startCode } from './links.js';
import { CAPTION_MAX, messageOf, TEXT_MAX } from './message.js';

import type { DeviceStorage, JsonSchema, LoggerService, Notification, NotifierDevice, NotifierInterface, PluginAPI } from '@camera.ui/sdk';
import type { TgUpdate } from './bot.js';
import type { LinkedChat, PendingLink } from './links.js';
import type { StorageValues } from './types.js';

// ViON notifications in Telegram chats, through the owner's own bot. A ViON user links a chat with a link of a
// one-time code (Settings → Notifications → «Подключить Telegram»): the chat that opens the bot with it gets that
// user's notifications, as their phone would, with quiet hours, mute and the cameras they may see. The bot reads its
// messages by long polling: nothing has to reach the server from outside.

const POLL_TIMEOUT_S = 50;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** A «too many requests» is waited out once, if it asks for no longer than this. */
const RATE_WAIT_MAX_S = 30;

// the bot does not know who opens it: its own words are said in both languages of the home
const LINKED = 'Готово: уведомления ViON будут приходить в этот чат. /stop — отключить.\nDone: ViON notifications will come to this chat. /stop to turn them off.';
const UNKNOWN =
  'Ссылка устарела или неверна. Получите новую в ViON: Настройки → Уведомления → «Подключить Telegram».\n' +
  'The link is old or wrong. Get a new one in ViON: Settings → Notifications → Connect Telegram.';
const HELLO =
  'Это бот уведомлений ViON. Подключите чат в ViON: Настройки → Уведомления → «Подключить Telegram».\n' +
  'This is the ViON notification bot. Connect the chat in ViON: Settings → Notifications → Connect Telegram.';
const STOPPED = 'Уведомления ViON в этот чат отключены.\nViON notifications to this chat are off.';
// shown as is under «Подключить Telegram» in ViON, whose language the plugin does not know
const NO_BOT =
  'Бот Telegram ещё не подключён: введите его токен в настройках плагина Telegram.\n' + 'The Telegram bot is not connected yet: enter its token in the plugin settings.';
const OPEN = 'Открыть в ViON';
/** Why a notification went to no chat: no token yet, or Telegram did not answer the bot's sign-in (getMe) so far. */
const NOT_CONNECTED = 'the bot of the server is not connected: no token in the settings of the Telegram plugin, or Telegram is not reachable';

/** Whether a chat got a notification, and why not: ViON keeps it and sends the notification another way. */
interface ChatDelivery {
  deviceId: string;
  ok: boolean;
  error?: string;
}

/**
 * The answer of sendNotification. The SDK of camera.ui (upstream's) says it answers nothing; ViON reads an answer per
 * device when there is one (server manager/channels.ts, deliveriesOf), so the list passes the SDK's type as void.
 */
function answered(deliveries: ChatDelivery[]): void {
  return deliveries as unknown as void;
}

export default class Telegram extends ServicePlugin<StorageValues> implements NotifierInterface {
  private bot?: TelegramBot;
  private botName?: string;
  private run?: AbortController;
  private chats: LinkedChat[] = [];
  private pending: PendingLink[] = [];

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => this.start());
    this.api.on(API_EVENT.SHUTDOWN, () => this.stop());
  }

  public get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'botToken',
        title: 'Bot token',
        description:
          'Create a bot with @BotFather in Telegram (/newbot) and paste the token it gives. ' + 'Each ViON user then connects their chat under Settings, Notifications.',
        format: 'password',
        required: false,
        store: true,
        onSet: async () => this.restart(),
      },
      {
        type: 'string',
        key: 'apiUrl',
        title: 'Bot API address',
        description: 'Leave empty for api.telegram.org. A self-hosted Bot API server or a proxy in its place, for example when Telegram is blocked.',
        required: false,
        store: true,
        onSet: async () => this.restart(),
      },
      {
        type: 'string',
        key: 'linkBase',
        title: 'ViON address for the button',
        description: 'For example https://vion.example.com. A message then has a button that opens the moment in ViON; empty: no button.',
        required: false,
        store: true,
      },
    ];
  }

  /** Reads what was linked and connects the bot. Public for the tests. */
  public start(): void {
    this.chats = [...(this.storage.values._chats ?? [])];
    this.pending = [...(this.storage.values._pending ?? [])];
    this.connect();
  }

  public stop(): void {
    this.run?.abort();
    this.run = undefined;
    this.bot = undefined;
    this.botName = undefined;
  }

  private restart(): void {
    this.stop();
    this.connect();
  }

  private connect(): void {
    const token = this.storage.values.botToken?.trim();
    if (!token) {
      this.logger.log('Telegram: no bot token yet. Create a bot with @BotFather and paste its token in the plugin settings.');
      return;
    }
    const run = new AbortController();
    this.run = run;
    void this.serve(new TelegramBot(token, this.storage.values.apiUrl ?? ''), run.signal);
  }

  /** Until stopped: the bot's name, then its messages. A token Telegram refuses stops it until the token changes. */
  private async serve(bot: TelegramBot, signal: AbortSignal): Promise<void> {
    let wait = RETRY_MIN_MS;
    while (!signal.aborted && !this.botName) {
      try {
        const me = await bot.getMe(signal);
        if (signal.aborted) return;
        this.bot = bot;
        this.botName = me.username;
        // a webhook set by another program stops long polling
        await bot.deleteWebhook(signal).catch(() => undefined);
        this.logger.log(`Telegram: bot @${me.username} ready, ${this.chats.length} chat(s) linked`);
      } catch (error) {
        if (signal.aborted) return;
        if (refused(error)) {
          this.logger.error('Telegram: the bot token is not accepted. Check it in the plugin settings.');
          return;
        }
        this.logger.warn(`Telegram: the bot could not be reached, trying again in ${wait / 1000} s: ${(error as Error).message}`);
        await pause(wait, signal);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      }
    }
    await this.poll(bot, signal);
  }

  private async poll(bot: TelegramBot, signal: AbortSignal): Promise<void> {
    let offset = this.storage.values._offset ?? 0;
    let wait = RETRY_MIN_MS;
    let lastProblem = '';
    while (!signal.aborted) {
      try {
        const updates = await bot.getUpdates(offset, POLL_TIMEOUT_S, signal);
        wait = RETRY_MIN_MS;
        lastProblem = '';
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handle(bot, update).catch((error: Error) => this.logger.warn(`Telegram: a message was not answered: ${error.message}`));
        }
        if (updates.length) await this.storage.setInternalValue('_offset', offset);
      } catch (error) {
        if (signal.aborted) return;
        if (refused(error)) {
          this.logger.error('Telegram: the bot token is no longer accepted. Check it in the plugin settings.');
          return;
        }
        const problem =
          error instanceof BotApiError && error.status === 409
            ? 'another program reads the messages of this bot (another ViON with the same token?)'
            : (error as Error).message;
        // said once while it stays the same: a blocked network would say it every minute
        if (problem !== lastProblem) this.logger.warn(`Telegram: messages are not read, trying again: ${problem}`);
        lastProblem = problem;
        await pause(wait, signal);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      }
    }
  }

  /** A message to the bot: a link opened, /stop, or anything else. Public for the tests. */
  public async handle(bot: TelegramBot, update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message?.chat) return;
    const code = startCode(message.text);
    if (code) {
      const result = linkChat(this.chats, this.pending, code, message.chat, Date.now());
      this.chats = result.chats;
      this.pending = result.pending;
      await this.save();
      if (result.linked) this.logger.log(`Telegram: chat ${result.linked.name} linked`);
      await bot.sendMessage(message.chat.id, result.linked ? LINKED : UNKNOWN);
      return;
    }
    if (isStop(message.text)) {
      const before = this.chats.length;
      this.chats = this.chats.filter((chat) => chat.chatId !== message.chat.id);
      if (this.chats.length !== before) {
        await this.save();
        this.logger.log(`Telegram: chat ${chatName(message.chat)} unlinked itself`);
      }
      await bot.sendMessage(message.chat.id, STOPPED);
      return;
    }
    if (message.text?.trim().startsWith('/start')) await bot.sendMessage(message.chat.id, HELLO);
  }

  public async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    const owners = new Set(ownerUserIds);
    return this.chats.filter((chat) => owners.has(chat.ownerUserId)).map(deviceOf);
  }

  public async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    const chat = this.chats.find((candidate) => candidate.id === deviceId);
    return chat ? deviceOf(chat) : null;
  }

  /**
   * A link for one ViON user: the chat that opens the bot with it is theirs. The device it answers is not one yet (not
   * active): it carries the link to show; the chat becomes a device once it opens the bot.
   */
  public async registerDevice(ownerUserId: string): Promise<NotifierDevice> {
    if (!this.bot || !this.botName) throw new Error(NO_BOT);
    const now = Date.now();
    const code = newCode();
    this.pending = [...fresh(this.pending, now), { code, ownerUserId, expiresAt: now + LINK_TTL_MS }].slice(-MAX_PENDING);
    await this.save();
    return {
      id: `link:${code}`,
      ownerUserId,
      name: 'Telegram',
      active: false,
      metadata: { link: `https://t.me/${this.botName}?start=${code}`, expiresAt: now + LINK_TTL_MS },
    };
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    const chat = this.chats.find((candidate) => candidate.id === deviceId);
    if (!chat) return;
    this.chats = this.chats.filter((candidate) => candidate !== chat);
    await this.save();
    await this.bot?.sendMessage(chat.chatId, STOPPED).catch(() => undefined);
  }

  public async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const chat = this.chats.find((candidate) => candidate.id === deviceId);
    if (!chat) return null;
    if (typeof patch.active === 'boolean') chat.active = patch.active;
    if (typeof patch.name === 'string' && patch.name.trim()) chat.name = patch.name.trim().slice(0, 64);
    await this.save();
    return deviceOf(chat);
  }

  /**
   * To each chat named: the picture with the words under it, or the words alone. A chat that blocked the bot is
   * switched off (it would refuse every time); a «too many requests» is waited out once. What became of it in each
   * chat goes back to ViON, which keeps it and sends the notification another way when no chat got it: without a bot
   * nothing was sent and ViON counted it delivered (the audit of 2026-10-17).
   */
  public async sendNotification(deviceIds: string[], notification: Notification): Promise<void> {
    const ids = [...new Set(deviceIds)];
    const bot = this.bot;
    if (!bot) return answered(ids.map((deviceId) => ({ deviceId, ok: false, error: NOT_CONNECTED })));
    const options = { silent: notification.silent === true, button: this.buttonFor(notification) };
    const deliveries: ChatDelivery[] = [];
    for (const id of ids) {
      const chat = this.chats.find((candidate) => candidate.id === id);
      if (!chat) {
        deliveries.push({ deviceId: id, ok: false, error: 'no such chat' });
        continue;
      }
      if (!chat.active) {
        deliveries.push({ deviceId: id, ok: false, error: 'this chat is switched off' });
        continue;
      }
      const send = () =>
        notification.thumbnail?.length
          ? bot.sendPhoto(chat.chatId, notification.thumbnail, messageOf(notification, CAPTION_MAX), options)
          : bot.sendMessage(chat.chatId, messageOf(notification, TEXT_MAX), options);
      try {
        await send().catch(async (error: unknown) => {
          if (error instanceof BotApiError && error.status === 429 && (error.retryAfter ?? Infinity) <= RATE_WAIT_MAX_S) {
            await pause(error.retryAfter! * 1000);
            return send();
          }
          throw error;
        });
        deliveries.push({ deviceId: id, ok: true });
      } catch (error) {
        if (error instanceof BotApiError && error.status === 403) {
          chat.active = false;
          await this.save();
          this.logger.warn(`Telegram: chat ${chat.name} blocked the bot or left: switched off`);
          deliveries.push({ deviceId: id, ok: false, error: 'the chat blocked the bot or left it: switched off' });
          continue;
        }
        this.logger.error(`Telegram: a notification to ${chat.name} was not sent: ${(error as Error).message}`);
        deliveries.push({ deviceId: id, ok: false, error: (error as Error).message });
      }
    }
    return answered(deliveries);
  }

  private buttonFor(notification: Notification): { text: string; url: string } | undefined {
    const base = this.storage.values.linkBase?.trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//.test(base) || !notification.deepLink?.startsWith('/')) return undefined;
    return { text: OPEN, url: `${base}${notification.deepLink}` };
  }

  private async save(): Promise<void> {
    await this.storage.setInternalValue('_chats', this.chats);
    await this.storage.setInternalValue('_pending', this.pending);
  }
}

function deviceOf(chat: LinkedChat): NotifierDevice {
  return { id: chat.id, ownerUserId: chat.ownerUserId, name: chat.name, active: chat.active, metadata: { chatId: chat.chatId, linkedAt: chat.linkedAt } };
}

function refused(error: unknown): boolean {
  return error instanceof BotApiError && (error.status === 401 || error.status === 404);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
