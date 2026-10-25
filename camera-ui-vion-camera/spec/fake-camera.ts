// A stand-in of a VION camera's API (VIONN- camera/device), as the service answers: open info, the first pairing gets
// the token and the RTSP access (409 after), the state and the reset need the token, a reset changes the password.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { AddressInfo } from 'node:net';

export interface FakeCamera {
  port: number;
  id: string;
  pairs: number;
  token?: string;
  password: string;
  /** what the button on the camera does: it forgets its VION and takes a new RTSP password */
  pressReset(): void;
  close(): Promise<void>;
}

export async function fakeCamera(id = '00044BC4D00F'): Promise<FakeCamera> {
  const camera: FakeCamera = {
    port: 0,
    id,
    pairs: 0,
    password: randomBytes(6).toString('hex'),
    pressReset() {
      camera.token = undefined;
      camera.password = randomBytes(6).toString('hex');
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const info = () => ({
    id,
    kind: 'camera',
    model: 'VION Camera (Jetson TX2, development)',
    board: 'jetson-tx2',
    firmware: '0.1.0',
    name: 'VION Camera D00F',
    paired: camera.token !== undefined,
    rtsp_port: 8554,
    streams: {
      main: { path: '/main', codec: 'h265', width: 1920, height: 1080, fps: 30 },
      sub: { path: '/sub', codec: 'h264', width: 640, height: 360, fps: 30 },
    },
  });
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authorized = camera.token !== undefined && req.headers.authorization === `Bearer ${camera.token}`;
    if (req.method === 'GET' && req.url === '/api/info') return send(200, info());
    if (req.method === 'POST' && req.url === '/api/pair') {
      if (camera.token) return send(409, { error: 'the camera is added to another VION' });
      camera.pairs++;
      camera.token = randomBytes(8).toString('hex');
      return send(200, { token: camera.token, info: info(), rtsp: { port: 8554, username: 'vion', password: camera.password } });
    }
    if (!authorized) return send(401, { error: 'the camera is not added to this VION' });
    if (req.method === 'GET' && req.url === '/api/state') {
      return send(200, { info: info(), settings: {}, health: { streams: { main: { up: true, consumers: 1 }, sub: { up: true, consumers: 0 } } } });
    }
    if (req.method === 'POST' && req.url === '/api/reset') {
      camera.pressReset();
      return send(200, { paired: false });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  camera.port = (server.address() as AddressInfo).port;
  return camera;
}
