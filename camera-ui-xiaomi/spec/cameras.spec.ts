// Cameras of a Mi account and the address the stream engine opens one with: the local address of the camera, its
// protocol and keys made for this one connection. Against a stand-in cloud that records what it is asked.
// Run: npx tsx spec/cameras.spec.ts
import assert from 'node:assert/strict';

import { cameraStreamUrl, isCameraModel, listCameras, vendorName } from '../src/xiaomi/cameras.js';

import type { XiaomiCamera } from '../src/xiaomi/cameras.js';
import type { XiaomiCloud } from '../src/xiaomi/cloud.js';

interface Asked {
  region: string;
  path: string;
  params: Record<string, unknown>;
}

function stubCloud(answer: (asked: Asked) => unknown): { cloud: XiaomiCloud; asked: Asked[] } {
  const asked: Asked[] = [];
  const cloud = {
    request: async (region: string, path: string, params: string) => {
      const call = { region, path, params: JSON.parse(params) as Record<string, unknown> };
      asked.push(call);
      return answer(call);
    },
  } as unknown as XiaomiCloud;
  return { cloud, asked };
}

const camera = (patch: Partial<XiaomiCamera> = {}): XiaomiCamera => ({
  did: '1001',
  name: 'Hall',
  model: 'chuangmi.camera.039a01',
  ip: '192.168.1.50',
  region: 'ru',
  ...patch,
});

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('cameras and door viewers count as cameras, nothing else does', () => {
  assert.equal(isCameraModel('chuangmi.camera.039a01'), true);
  assert.equal(isCameraModel('loock.cateye.v02'), true);
  assert.equal(isCameraModel('lumi.gateway.mgl03'), false);
  assert.equal(isCameraModel('xiaomi.vacuum.c102gl'), false);
});

test('the cameras of every region are listed, other devices are not, a region that fails is skipped', async () => {
  const reported: string[] = [];
  const { cloud } = stubCloud(({ region }) => {
    if (region === 'de') throw new Error('region down');
    if (region === 'ru') {
      return {
        list: [
          { did: '1001', name: 'Hall', model: 'chuangmi.camera.039a01', localip: '192.168.1.50', isOnline: true },
          { did: '1002', name: 'Lamp', model: 'yeelink.light.bslamp2', localip: '192.168.1.51' },
        ],
      };
    }
    if (region === 'cn') return { list: [{ did: '2001', name: '', model: 'loock.cateye.v02', localip: '' }] };
    return { list: [] };
  });

  const { cameras, complete } = await listCameras(cloud, (region) => reported.push(region));
  assert.equal(complete, false);
  assert.deepEqual(
    cameras.map((c) => [c.did, c.name, c.region, c.ip]),
    [
      ['2001', 'loock.cateye.v02', 'cn', ''],
      ['1001', 'Hall', 'ru', '192.168.1.50'],
    ],
  );
  assert.deepEqual(reported, ['de']);
});

test('when no region can be read, that is an error, not an empty account', async () => {
  const { cloud } = stubCloud(() => {
    throw new Error('Not signed in to Xiaomi');
  });
  await assert.rejects(listCameras(cloud), /Not signed in/);
});

test('a long device list is read page by page, and a page that repeats stops it', async () => {
  const { cloud, asked } = stubCloud(({ region, params }) => {
    if (region !== 'us') return { list: [] };
    if (!params.start_did) return { list: [{ did: '1', name: 'A', model: 'a.camera.x', localip: '10.0.0.1' }], has_more: true, next_start_did: '1' };
    return { list: [{ did: '2', name: 'B', model: 'b.camera.x', localip: '10.0.0.2' }], has_more: true, next_start_did: '1' };
  });
  const { cameras, complete } = await listCameras(cloud);
  assert.equal(complete, true);
  assert.deepEqual(
    cameras.map((c) => c.did),
    ['1', '2'],
  );
  assert.equal(asked.filter((a) => a.region === 'us').length, 2);
});

test('a camera of the common protocol over CS2: local address, its keys and no account in the address', async () => {
  const { cloud, asked } = stubCloud(() => ({ vendor: { vendor: 4, vendor_params: {} }, public_key: 'dd'.repeat(32), sign: 'signature' }));
  const url = new URL(await cameraStreamUrl(cloud, camera()));

  assert.equal(url.protocol, 'xiaomi:');
  assert.equal(url.host, '192.168.1.50');
  // without an account in the address the engine dials the camera with these keys and asks no cloud of its own
  assert.equal(url.username, '');
  const q = url.searchParams;
  assert.equal(q.get('did'), '1001');
  assert.equal(q.get('model'), 'chuangmi.camera.039a01');
  assert.equal(q.get('vendor'), 'cs2');
  assert.equal(q.get('device_public'), 'dd'.repeat(32));
  assert.equal(q.get('sign'), 'signature');
  assert.equal(q.get('uid'), null);
  assert.match(q.get('client_private') ?? '', /^[0-9a-f]{64}$/);

  // the cloud signed the key that is in the address, asked in the region of the camera
  assert.deepEqual(asked, [
    { region: 'ru', path: '/v2/device/miss_get_vendor', params: { app_pubkey: q.get('client_public'), did: '1001', support_vendors: 'TUTK_CS2_MTP' } },
  ]);
});

test('keys are new for every connection', async () => {
  const { cloud } = stubCloud(() => ({ vendor: { vendor: 4 }, public_key: 'dd', sign: 's' }));
  const a = new URL(await cameraStreamUrl(cloud, camera())).searchParams.get('client_private');
  const b = new URL(await cameraStreamUrl(cloud, camera())).searchParams.get('client_private');
  assert.notEqual(a, b);
});

test('over TUTK the P2P id goes along', async () => {
  const { cloud } = stubCloud(() => ({ vendor: { vendor: 1, vendor_params: { p2p_id: 'TUTKUID123' } }, public_key: 'dd', sign: 's' }));
  const q = new URL(await cameraStreamUrl(cloud, camera())).searchParams;
  assert.equal(q.get('vendor'), 'tutk');
  assert.equal(q.get('uid'), 'TUTKUID123');
  assert.equal(vendorName(3), 'agora');
  assert.equal(vendorName(6), 'mtp');
});

test('a camera of the older protocol: signed keys, or the device password', async () => {
  const signed = stubCloud(() => ({ p2p_id: 'UID1', p2p_dev_public_key: 'ee', signForAppData: 'sig' }));
  const q1 = new URL(await cameraStreamUrl(signed.cloud, camera({ model: 'isa.camera.isc5' }))).searchParams;
  assert.equal(signed.asked[0]?.path, '/device/devicepass');
  assert.equal(signed.asked[0]?.params.toSignAppData, q1.get('client_public'));
  assert.equal(q1.get('uid'), 'UID1');
  assert.equal(q1.get('device_public'), 'ee');
  assert.equal(q1.get('vendor'), null);

  const plain = stubCloud(() => ({ p2p_id: 'UID2', password: 'devpass' }));
  const q2 = new URL(await cameraStreamUrl(plain.cloud, camera({ model: 'chuangmi.camera.xiaobai' }))).searchParams;
  assert.equal(q2.get('password'), 'devpass');
  assert.equal(q2.get('client_private'), null);
});

test('a camera the common protocol does not know is asked the older way', async () => {
  const { cloud, asked } = stubCloud(({ path }) => {
    if (path === '/v2/device/miss_get_vendor') throw new Error('Xiaomi: no available vendor support');
    return { p2p_id: 'UID3', password: 'p' };
  });
  const q = new URL(await cameraStreamUrl(cloud, camera({ model: 'chuangmi.camera.v2' }))).searchParams;
  assert.deepEqual(
    asked.map((a) => a.path),
    ['/v2/device/miss_get_vendor', '/device/devicepass'],
  );
  assert.equal(q.get('uid'), 'UID3');
});

test('other errors of the cloud are not hidden behind the older way', async () => {
  const { cloud } = stubCloud(() => {
    throw new Error('Xiaomi: permission denied');
  });
  await assert.rejects(cameraStreamUrl(cloud, camera()), /permission denied/);
});

test('a door viewer is woken first; quality and lens go into the address', async () => {
  const { cloud, asked } = stubCloud(({ path }) => (path.startsWith('/home/rpc/') ? {} : { vendor: { vendor: 4 }, public_key: 'dd', sign: 's' }));
  const q = new URL(await cameraStreamUrl(cloud, camera({ model: 'loock.cateye.v02' }), 'sd', 2)).searchParams;
  assert.deepEqual(asked[0], { region: 'ru', path: '/home/rpc/1001', params: { id: 1, method: 'wakeup', params: { video: '1' } } });
  assert.equal(q.get('subtype'), 'sd');
  assert.equal(q.get('channel'), '2');

  assert.equal(new URL(await cameraStreamUrl(cloud, camera(), 'max')).searchParams.get('subtype'), '3');
  assert.equal(new URL(await cameraStreamUrl(cloud, camera(), 'default')).searchParams.get('subtype'), null);
});

test('a camera without a local address is explained, not dialled', async () => {
  const { cloud, asked } = stubCloud(() => ({}));
  await assert.rejects(cameraStreamUrl(cloud, camera({ ip: '' })), /same network as the server/);
  assert.equal(asked.length, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n`, error);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
