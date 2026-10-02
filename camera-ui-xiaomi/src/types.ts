import type { Quality } from './xiaomi/cameras.js';

/** What the plugin stores. The password is not stored: the token of the sign-in replaces it. */
export interface XiaomiConfig {
  username?: string;
  password?: string;
  userId?: string;
  passToken?: string;
  quality?: Quality;
}
