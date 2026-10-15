// The few methods of the Telegram Bot API the plugin uses, over fetch. The token is part of every address: it is never
// put in an error or a log line.

export const DEFAULT_API = 'https://api.telegram.org';

export interface BotUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface SendOptions {
  silent?: boolean;
  /** a button under the message that opens an address */
  button?: { text: string; url: string };
}

/** What the Bot API answered when it did not do it: its status, its words, how long to wait when it says so. */
export class BotApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'BotApiError';
  }
}

export class TelegramBot {
  private readonly base: string;

  constructor(
    private readonly token: string,
    base = DEFAULT_API,
  ) {
    this.base = (base.trim() || DEFAULT_API).replace(/\/+$/, '');
  }

  public getMe(signal?: AbortSignal): Promise<BotUser> {
    return this.call<BotUser>('getMe', {}, signal);
  }

  /** Long polling: waits up to `timeoutS` for new messages. */
  public getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message'] }, signal);
  }

  /** A webhook left by another program stops long polling (409): it is dropped. */
  public deleteWebhook(signal?: AbortSignal): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', {}, signal);
  }

  public sendMessage(chatId: number, html: string, options: SendOptions = {}, signal?: AbortSignal): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', ...extras(options) }, signal);
  }

  public sendPhoto(chatId: number, photo: Uint8Array, html: string, options: SendOptions = {}, signal?: AbortSignal): Promise<TgMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', html);
    form.set('parse_mode', 'HTML');
    for (const [key, value] of Object.entries(extras(options))) form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    // a copy on an ArrayBuffer of its own: a view of a shared or larger buffer is no BlobPart
    form.set('photo', new Blob([Uint8Array.from(photo)], { type: 'image/jpeg' }), 'vion.jpg');
    return this.call<TgMessage>('sendPhoto', form, signal);
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        signal,
      });
    } catch (error) {
      // the address holds the token: only the cause is said
      if (signal?.aborted) throw error;
      const cause = (error as Error)?.cause instanceof Error ? ((error as Error).cause as Error).message : (error as Error)?.message;
      throw new BotApiError(0, `Telegram is not reachable (${cause})`);
    }
    const answer = (await response.json().catch(() => undefined)) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | undefined;
    if (!answer?.ok) throw new BotApiError(response.status, answer?.description ?? `HTTP ${response.status}`, answer?.parameters?.retry_after);
    return answer.result as T;
  }
}

function extras(options: SendOptions): Record<string, unknown> {
  return {
    ...(options.silent ? { disable_notification: true } : {}),
    ...(options.button ? { reply_markup: { inline_keyboard: [[{ text: options.button.text, url: options.button.url }]] } } : {}),
  };
}

/** Text for parse_mode HTML: its own <, > and & are shown, not read as tags. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
