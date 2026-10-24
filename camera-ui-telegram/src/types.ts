import type { LinkedChat, PendingLink } from './links.js';

export interface StorageValues {
  /** the token @BotFather gave */
  botToken?: string;
  /** the Bot API server; empty: api.telegram.org */
  apiUrl?: string;
  /** the VION address the button of a message opens; empty: no button */
  linkBase?: string;
  _chats?: LinkedChat[];
  _pending?: PendingLink[];
  /** the next update to read: what was read before a restart is not answered twice */
  _offset?: number;
}
