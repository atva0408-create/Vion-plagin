import type { VoiceMode } from './voice.js';

/** Which API the devices are read from and commanded through. */
export type Source = 'auto' | 'official' | 'app';

export interface YandexConfig {
  debug?: boolean;

  /** App of Yandex ID with the rights iot:view and iot:control, for the official API. */
  clientId?: string;
  clientSecret?: string;
  oauthToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;

  /** Sign-in as the Yandex app: by QR code or by an x_token. */
  xToken?: string;
  cookies?: string;
  stationToken?: string;
  account?: string;

  source?: Source;
  pollSeconds?: number;
  scenarios?: boolean;
  voiceMode?: VoiceMode;
  stationHosts?: string;

  mutedStations?: string[];
  stationNames?: Record<string, string>;
}
