// The devices of a Yandex Smart Home in one shape, whichever API they were read from: the official API of the
// account (api.iot.yandex.net) and the web API of the app (iot.quasar.yandex.ru) both describe a device by the
// capabilities and properties of the Smart Home protocol, with small differences in where the instance is.

export interface YCapability {
  type: string;
  instance: string;
  value: unknown;
  parameters: Record<string, any>;
}

export interface YProperty {
  type: string;
  instance: string;
  value: unknown;
  parameters: Record<string, any>;
  /** When the value last changed, in milliseconds; tells a new press of a button from the old one. */
  updatedAt?: number;
}

export interface YDevice {
  id: string;
  name: string;
  type: string;
  room?: string;
  household?: string;
  online: boolean;
  capabilities: YCapability[];
  properties: YProperty[];
  /** Ids of a station for its own protocols. */
  quasar?: { deviceId: string; platform: string };
}

export interface YScenario {
  id: string;
  name: string;
}

export interface YHome {
  devices: YDevice[];
  scenarios: YScenario[];
}

export function isStation(device: YDevice): boolean {
  return device.type.startsWith('devices.types.smart_speaker') || device.type.startsWith('devices.types.media_device.dongle.yandex');
}

export function isCamera(device: YDevice): boolean {
  return device.capabilities.some((c) => c.type === 'devices.capabilities.video_stream' && (c.parameters.protocols ?? ['hls']).includes('hls'));
}

function instanceOf(item: any): string {
  if (item?.type === 'devices.capabilities.on_off') return 'on';
  return String(item?.state?.instance ?? item?.parameters?.instance ?? '');
}

function timeOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function capabilities(raw: unknown): YCapability[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => typeof c?.type === 'string').map((c) => ({ type: c.type, instance: instanceOf(c), value: c.state?.value, parameters: c.parameters ?? {} }));
}

function properties(raw: unknown): YProperty[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => typeof p?.type === 'string' && instanceOf(p))
    .map((p) => ({
      type: p.type,
      instance: instanceOf(p),
      value: p.state?.value,
      parameters: p.parameters ?? {},
      updatedAt: timeOf(p.last_updated ?? p.state_changed_at),
    }));
}

/** The answer of GET /v1.0/user/info of the official API. */
export function parseUserInfo(info: any): YHome {
  const rooms = new Map<string, string>((info?.rooms ?? []).map((room: any) => [String(room.id), String(room.name)]));
  const households = new Map<string, string>((info?.households ?? []).map((house: any) => [String(house.id), String(house.name)]));
  const devices: YDevice[] = (info?.devices ?? []).map((device: any) => ({
    id: String(device.id),
    name: String(device.name ?? device.id),
    type: String(device.type ?? 'devices.types.other'),
    room: device.room ? (rooms.get(String(device.room)) ?? undefined) : undefined,
    household: device.household_id ? households.get(String(device.household_id)) : undefined,
    // the official API has no online flag on the list; a device that cannot answer has no state
    online: device.state !== 'offline',
    capabilities: capabilities(device.capabilities),
    properties: properties(device.properties),
  }));
  const scenarios: YScenario[] = (info?.scenarios ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id) }));
  return { devices, scenarios };
}

/** One device as the web API of the app gives it, in the list and in the updates. */
export function parseQuasarDevice(device: any, household?: string): YDevice {
  return {
    id: String(device.id),
    name: String(device.name ?? device.id),
    type: String(device.type ?? 'devices.types.other'),
    room: device.room_name ?? device.room?.name ?? undefined,
    household,
    online: device.state !== 'offline',
    capabilities: capabilities(device.capabilities),
    properties: properties(device.properties),
    quasar: device.quasar_info?.device_id ? { deviceId: String(device.quasar_info.device_id), platform: String(device.quasar_info.platform ?? '') } : undefined,
  };
}

/** The answer of GET /m/v3/user/devices of the web API: the devices of every house, shared houses aside. */
export function parseQuasarDevices(answer: any): YDevice[] {
  const devices: YDevice[] = [];
  for (const house of answer?.households ?? []) {
    if (house?.sharing_info) continue;
    for (const device of house?.all ?? []) devices.push(parseQuasarDevice(device, house.name));
  }
  return devices;
}

/** Fields of an update of the web API applied to a known device: an update may carry only what changed. */
export function mergeDevice(known: YDevice, update: any): YDevice {
  const next = parseQuasarDevice({ ...update, name: update.name ?? known.name, type: update.type ?? known.type }, known.household);
  return {
    ...known,
    online: update.state !== undefined ? update.state !== 'offline' : known.online,
    capabilities: mergeItems(known.capabilities, next.capabilities),
    properties: mergeItems(known.properties, next.properties),
  };
}

function mergeItems<T extends { type: string; instance: string }>(known: T[], fresh: T[]): T[] {
  if (!fresh.length) return known;
  const result = [...known];
  for (const item of fresh) {
    const i = result.findIndex((k) => k.type === item.type && k.instance === item.instance);
    if (i >= 0) result[i] = item;
    else result.push(item);
  }
  return result;
}
