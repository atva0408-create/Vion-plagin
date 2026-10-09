import { REGIONS } from './cloud.js';
import { generateKeyPair } from './keys.js';
import { reachableLocally } from './p2p.js';
import { nonEmpty } from './text.js';

import type { Region, XiaomiCloud } from './cloud.js';
import type { SessionKeys } from './miss.js';
import type { ConnectionMode } from './p2p.js';
import type { RelayCredentials } from './relay.js';

/** A camera of the account, as the Mi Home device list gives it. */
export interface XiaomiCamera {
  did: string;
  name: string;
  model: string;
  /** address in the local network: the server connects to the camera there */
  ip: string;
  mac?: string;
  online?: boolean;
  region: Region;
  /** the MIoT spec of the device (urn:miot-spec-v2:device:camera:…), when the list names it */
  specType?: string;
}

/** Picture quality the camera is asked for. `default` leaves the choice to the stream engine (HD). */
export type Quality = 'default' | 'sd' | 'hd' | 'max';

interface DeviceListPage {
  list?: { did?: string; name?: string; model?: string; localip?: string; mac?: string; isOnline?: boolean; spec_type?: string }[];
  has_more?: boolean;
  next_start_did?: string;
}

/** Cameras and the door viewers with a camera (cateye). */
export function isCameraModel(model: string): boolean {
  return model.includes('.camera.') || model.includes('.cateye.');
}

/** Models that predate the common camera protocol of Xiaomi (miss) and are asked for their keys another way. */
const LEGACY_MODELS = new Set(['lumi.camera.gwagl01', 'loock.cateye.v01', 'chuangmi.camera.xiaobai', 'isa.camera.isc5']);

const MAX_PAGES = 20;

/** The cameras of one region of the account. */
async function camerasOfRegion(cloud: XiaomiCloud, region: Region): Promise<XiaomiCamera[]> {
  const cameras: XiaomiCamera[] = [];
  let startDid: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = startDid ? JSON.stringify({ start_did: startDid }) : '{}';
    const result = (await cloud.request(region, '/v2/home/device_list_page', params)) as DeviceListPage | null;
    for (const device of result?.list ?? []) {
      if (!device.did || !device.model || !isCameraModel(device.model)) continue;
      cameras.push({
        did: device.did,
        name: nonEmpty(device.name) ?? device.model,
        model: device.model,
        ip: device.localip ?? '',
        mac: device.mac,
        online: device.isOnline,
        region,
        ...(nonEmpty(device.spec_type) ? { specType: device.spec_type } : {}),
      });
    }
    if (!result?.has_more || !result.next_start_did || result.next_start_did === startDid) break;
    startDid = result.next_start_did;
  }
  return cameras;
}

/**
 * The cameras of every region of the account: a user rarely knows the region the Mi Home app chose. A region that
 * cannot be read is skipped and reported; when none can be read, that is an error.
 */
export async function listCameras(cloud: XiaomiCloud, onRegionError?: (region: Region, error: Error) => void): Promise<{ cameras: XiaomiCamera[]; complete: boolean }> {
  const results = await Promise.allSettled(REGIONS.map((region) => camerasOfRegion(cloud, region)));
  const cameras = new Map<string, XiaomiCamera>();
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      for (const camera of result.value) if (!cameras.has(camera.did)) cameras.set(camera.did, camera);
    } else {
      failed++;
      onRegionError?.(REGIONS[i], result.reason as Error);
    }
  });
  if (failed === REGIONS.length) throw (results[0] as PromiseRejectedResult).reason as Error;
  return { cameras: [...cameras.values()], complete: failed === 0 };
}

/**
 * P2P vendors the stream engine dials. The cloud names MTP and Agora cameras as well (it is asked the way the engine
 * asks it), and the engine refuses those with "unsupported vendor".
 */
const PLAYABLE_VENDORS = new Set(['cs2', 'tutk']);
const VENDOR_LABELS: Record<string, string> = { agora: 'Agora', mtp: 'MTP' };

/** A camera ViON cannot play: the cloud connects it over a P2P vendor the stream engine does not dial. */
export class UnplayableCameraError extends Error {
  constructor(
    public readonly camera: XiaomiCamera,
    public readonly vendor: string,
  ) {
    super(`${camera.name} (${camera.model}) connects over ${VENDOR_LABELS[vendor] ?? `P2P vendor "${vendor}"`}, which ViON cannot play`);
    this.name = 'UnplayableCameraError';
  }
}

/** Keys of the newer protocol (miss): the cloud names the P2P vendor of the camera and signs a fresh key of ours. */
async function missParams(cloud: XiaomiCloud, camera: XiaomiCamera): Promise<Record<string, string>> {
  const { publicKey, privateKey } = generateKeyPair();
  const params = JSON.stringify({ app_pubkey: publicKey, did: camera.did, support_vendors: 'TUTK_CS2_MTP' });
  const result = (await cloud.request(camera.region, '/v2/device/miss_get_vendor', params)) as {
    vendor?: { vendor?: number; vendor_params?: { p2p_id?: string; init_string?: string } };
    public_key?: string;
    sign?: string;
  };

  const vendorId = result.vendor?.vendor;
  // an address the engine refuses would be a camera without video and only a line in the engine's log to say why
  if (!PLAYABLE_VENDORS.has(vendorName(vendorId))) throw new UnplayableCameraError(camera, vendorName(vendorId));
  const query: Record<string, string> = {
    client_public: publicKey,
    client_private: privateKey,
    device_public: result.public_key ?? '',
    sign: result.sign ?? '',
    vendor: vendorName(vendorId),
  };
  if (vendorId === 1 && result.vendor?.vendor_params?.p2p_id) query.uid = result.vendor.vendor_params.p2p_id;
  if (vendorId === 4) {
    const relay = result.vendor?.vendor_params;
    if (relay?.p2p_id) query.relay_uid = relay.p2p_id;
    if (relay?.init_string) query.relay_init = relay.init_string;
  }
  return query;
}

/** Keys of the older protocol: a device password, or a signed key of ours. */
async function legacyParams(cloud: XiaomiCloud, camera: XiaomiCamera): Promise<Record<string, string>> {
  const { publicKey, privateKey } = generateKeyPair();
  const params = JSON.stringify({ did: camera.did, toSignAppData: publicKey });
  const result = (await cloud.request(camera.region, '/device/devicepass', params)) as {
    p2p_id?: string;
    password?: string;
    p2p_dev_public_key?: string;
    signForAppData?: string;
  };

  const query: Record<string, string> = { uid: result.p2p_id ?? '' };
  if (result.signForAppData) {
    query.client_public = publicKey;
    query.client_private = privateKey;
    query.device_public = result.p2p_dev_public_key ?? '';
    query.sign = result.signForAppData;
  } else {
    query.password = result.password ?? '';
  }
  return query;
}

export function vendorName(id: number | undefined): string {
  switch (id) {
    case 1:
      return 'tutk';
    case 3:
      return 'agora';
    case 4:
      return 'cs2';
    case 6:
      return 'mtp';
    default:
      return String(id ?? '');
  }
}

/** The answer of the newer protocol for a camera of the older one that is not on the list of those models. */
function isOlderProtocol(error: unknown): boolean {
  return String((error as Error).message).includes('no available vendor support');
}

/**
 * Whether ViON can play the camera, asked the way a connection asks: throws UnplayableCameraError when the cloud
 * connects it over a P2P vendor the stream engine refuses. A camera of the older protocol plays.
 */
export async function checkPlayable(cloud: XiaomiCloud, camera: XiaomiCamera): Promise<void> {
  if (LEGACY_MODELS.has(camera.model)) return;
  try {
    await missParams(cloud, camera);
  } catch (error) {
    if (!isOlderProtocol(error)) throw error;
  }
}

/** Door viewers and battery cameras sleep: they are woken up before a connection. */
async function wakeUp(cloud: XiaomiCloud, camera: XiaomiCamera): Promise<void> {
  await cloud.request(camera.region, `/home/rpc/${camera.did}`, JSON.stringify({ id: 1, method: 'wakeup', params: { video: '1' } }));
}

/**
 * The address the stream engine opens the camera with: the local address of the camera and keys for this one
 * connection. Asked again for every connection: the keys are not meant to be kept. A door viewer that could not be
 * woken is reported to `onWakeUpError` and dialled all the same: it may be awake already.
 */
export async function cameraStreamUrl(
  cloud: XiaomiCloud,
  camera: XiaomiCamera,
  quality: Quality = 'default',
  channel?: number,
  onWakeUpError?: (error: Error) => void,
  connection: ConnectionOptions = {},
): Promise<string> {
  if (!camera.ip && (connection.mode ?? 'lan') === 'lan')
    throw new Error(`Xiaomi reports no local address for ${camera.name}: is it switched on and in the same network as the server?`);

  if (camera.model.includes('.cateye.')) await wakeUp(cloud, camera).catch((error: Error) => onWakeUpError?.(error));

  let params: Record<string, string>;
  if (LEGACY_MODELS.has(camera.model)) {
    params = await legacyParams(cloud, camera);
  } else {
    try {
      params = await missParams(cloud, camera);
    } catch (error) {
      // a camera of the older protocol that is not on the list
      if (!isOlderProtocol(error)) throw error;
      params = await legacyParams(cloud, camera);
    }
  }

  const host = await connectionHost(camera, params, connection);
  // Rendezvous credentials are used by the bridge, never placed in a logged or persisted stream URL.
  const { relay_uid: _uid, relay_init: _init, ...streamParams } = params;
  const query = new URLSearchParams({ did: camera.did, model: camera.model, ...streamParams });
  if (quality === 'sd' || quality === 'hd') query.set('subtype', quality);
  if (quality === 'max') query.set('subtype', '3');
  if (channel && channel > 1) query.set('channel', String(channel));
  return `xiaomi://${host}?${query.toString()}`;
}

export interface ConnectionOptions {
  mode?: ConnectionMode;
  openRelay?: (credentials: RelayCredentials) => Promise<string>;
  /** Replace the LAN probe in cloud contract tests. */
  localReachable?: (host: string) => Promise<boolean>;
}

export async function connectionHost(camera: XiaomiCamera, params: Record<string, string>, options: ConnectionOptions): Promise<string> {
  const mode = options.mode ?? 'lan';
  const credentials = params.relay_uid && params.relay_init ? { uid: params.relay_uid, init: params.relay_init } : undefined;
  if (mode === 'lan' || (mode === 'auto' && (!credentials || params.vendor !== 'cs2'))) {
    if (!camera.ip) throw new Error(`Xiaomi reports no local address for ${camera.name}`);
    return camera.ip;
  }
  if (mode === 'auto' && camera.ip && (await (options.localReachable ?? reachableLocally)(camera.ip))) return camera.ip;
  if (params.vendor !== 'cs2') throw new Error(`${camera.name}: remote P2P is supported for CS2 cameras only`);
  if (camera.online === false) throw new Error(`${camera.name} is offline in Mi Home; remote P2P is unavailable`);
  if (!credentials) throw new Error(`${camera.name}: Xiaomi did not provide remote P2P credentials`);
  if (!options.openRelay) throw new Error('The Xiaomi P2P bridge is not available');
  return options.openRelay(credentials);
}

/**
 * Keys for a session of the plugin's own with the camera, to turn it: asked like those of a stream connection, a new
 * pair each time. Only cameras of the newer protocol over CS2 are turned.
 */
export async function motorKeys(cloud: XiaomiCloud, camera: XiaomiCamera, mode: ConnectionMode = 'lan'): Promise<SessionKeys> {
  if (!camera.ip && mode === 'lan') throw new Error(`Xiaomi reports no local address for ${camera.name}: is it switched on and in the same network as the server?`);
  if (LEGACY_MODELS.has(camera.model)) throw new Error(`${camera.name} (${camera.model}) uses the older protocol, which the plugin cannot turn`);
  const params = await missParams(cloud, camera);
  if (params.vendor !== 'cs2') {
    throw new Error(`${camera.name} (${camera.model}) connects over ${VENDOR_LABELS[params.vendor] ?? params.vendor}: the plugin turns cameras over CS2 only`);
  }
  return {
    client_public: params.client_public,
    client_private: params.client_private,
    device_public: params.device_public,
    sign: params.sign,
    vendor: params.vendor,
    relay_uid: params.relay_uid,
    relay_init: params.relay_init,
  };
}
