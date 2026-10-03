// Properties and actions of a device through the Mi Home cloud (MIoT): how the Mi Home app zooms and focuses a camera.
import type { XiaomiCamera } from './cameras.js';
import type { XiaomiCloud } from './cloud.js';
import type { ActionRef, PropRef } from './spec.js';

interface MiotAnswer {
  code?: number;
  value?: unknown;
}

/** The commands of one device; each goes through the cloud of the region the device is in. */
export interface MiotDevice {
  get(prop: PropRef): Promise<unknown>;
  set(prop: PropRef, value: unknown): Promise<void>;
  action(action: ActionRef): Promise<void>;
}

function checked(answer: MiotAnswer | undefined, what: string): MiotAnswer {
  // the device refuses with a negative code: -4001 not readable, -4002 not writable, -704… offline
  if (!answer || (answer.code !== undefined && answer.code !== 0)) throw new Error(`The camera refused ${what} (code ${answer?.code ?? 'none'})`);
  return answer;
}

export function miotDevice(withCloud: <T>(run: (cloud: XiaomiCloud) => Promise<T>) => Promise<T>, camera: () => Promise<XiaomiCamera>): MiotDevice {
  return {
    async get(prop) {
      const { did, region } = await camera();
      const answer = (await withCloud((cloud) => cloud.request(region, '/miotspec/prop/get', JSON.stringify({ params: [{ did, ...prop }] })))) as MiotAnswer[] | null;
      return checked(answer?.[0], `to read ${prop.siid}.${prop.piid}`).value;
    },
    async set(prop, value) {
      const { did, region } = await camera();
      const params = JSON.stringify({ params: [{ did, ...prop, value }] });
      const answer = (await withCloud((cloud) => cloud.request(region, '/miotspec/prop/set', params))) as MiotAnswer[] | null;
      checked(answer?.[0], `to set ${prop.siid}.${prop.piid}`);
    },
    async action(action) {
      const { did, region } = await camera();
      const answer = (await withCloud((cloud) => cloud.request(region, '/miotspec/action', JSON.stringify({ params: { did, ...action, in: [] } })))) as MiotAnswer | null;
      checked(answer ?? undefined, `the action ${action.siid}.${action.aiid}`);
    },
  };
}
