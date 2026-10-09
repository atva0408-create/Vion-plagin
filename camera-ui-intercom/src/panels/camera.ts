/**
 * The camera of a driver panel, as the server creates it (POST /api/intercom/panels → the cameras service): its
 * sources made from the profile's templates (ТЗ 14.3, 14.4).
 *
 * The main and the small stream never ask for the talk channel (`backchannelDisabled`): a Dahua VTO has one talk
 * channel, and an open one silences its call button and takes the conversation from the vendor's app. The talk channel
 * has its own source, opened only by "Answer" and by the agent. The server wants a role for every source, unique among
 * them; the talk source takes "mid-resolution" and is neither kept hot nor preloaded, so nothing opens it by itself.
 */
import { fill, rtspUrl } from './profile.js';

import type { Credentials, PanelProfile } from './profile.js';

export interface CameraSourceConfig {
  name: string;
  role: 'high-resolution' | 'mid-resolution' | 'low-resolution';
  urls: string[];
  useForSnapshot: boolean;
  hotMode: boolean;
  preload: boolean;
  backchannelDisabled: boolean;
}

export interface PanelCameraConfig {
  name: string;
  type: 'doorbell';
  info: { manufacturer: string; model: string; hardware: string; serialNumber: string; firmwareVersion: string; supportUrl: string };
  sources: CameraSourceConfig[];
}

/**
 * The camera of the panel, or why it cannot be made. A profile without an RTSP path of its own (a model whose path is
 * not known yet) takes the address the owner typed.
 */
export function cameraConfig(profile: PanelProfile, credentials: Credentials, name: string, ownMainUrl?: string): PanelCameraConfig | string {
  const main = profile.video.main ? rtspUrl(profile.video.main, profile, credentials) : ownMainUrl;
  if (!main) return 'this model has no known video address: give the RTSP address of the panel';
  if (!/^rtsps?:\/\//.test(main)) return 'the video address must start with rtsp://';
  const sources: CameraSourceConfig[] = [
    { name: 'main', role: 'high-resolution', urls: [main], useForSnapshot: !profile.video.sub, hotMode: true, preload: true, backchannelDisabled: true },
  ];
  if (profile.video.sub) {
    sources.push({
      name: 'sub',
      role: 'low-resolution',
      urls: [rtspUrl(profile.video.sub, profile, credentials)],
      useForSnapshot: true,
      hotMode: true,
      preload: false,
      backchannelDisabled: true,
    });
  }
  if (profile.audio.toPanel !== 'none' && profile.audio.toPanel !== 'sip') {
    const talk = profile.video.talk ? rtspUrl(profile.video.talk, profile, credentials) : main;
    // Hikvision speaks back through ISAPI: the video of the talk source is the main stream, the channel the second url
    const urls = profile.talkSource ? [talk, fill(profile.talkSource, profile, credentials)] : [talk];
    sources.push({ name: 'talk', role: 'mid-resolution', urls, useForSnapshot: false, hotMode: false, preload: false, backchannelDisabled: false });
  }
  return {
    name,
    type: 'doorbell',
    info: {
      manufacturer: profile.vendor,
      model: profile.models[0] ?? profile.id,
      hardware: 'Door station',
      serialNumber: 'Unknown',
      firmwareVersion: 'Unknown',
      supportUrl: 'Unknown',
    },
    sources,
  };
}
