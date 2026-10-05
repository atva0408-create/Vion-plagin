// A stand-in of the ViON Sensor board: the HTTP API of the firmware (sensor esp VION/src/api.h) on a local port,
// with its state in the open so a test can move it.
import { createServer } from 'node:http';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface FakeBoard {
  address: string;
  id: string;
  token?: string;
  info: Record<string, any>;
  state: Record<string, any>;
  calls: { method: string; path: string; body?: any; auth?: string }[];
  /** When set, every request is dropped without an answer (the board is off). */
  down: boolean;
  manifest?: Record<string, any>;
  close(): Promise<void>;
}

export async function fakeBoard(id = 'AABBCCDDEEFF'): Promise<FakeBoard> {
  const board: FakeBoard = {
    address: '',
    id,
    info: {
      id,
      kind: 'vion-sensor',
      model: 'ESP32-CAM',
      firmware: '1.0.0',
      name: 'ViON Sensor EEFF',
      room: '',
      paired: false,
      ip: '127.0.0.1',
      rssi: -50,
      uptime_s: 100,
      camera: { enabled: false, state: 'off' },
      config: { threshold: 1.4, hold_s: 8 },
    },
    state: {
      motion: false,
      events: 0,
      calibrating: false,
      calibration_left_s: 0,
      blind: false,
      score: 0.12,
      baseline: 0.12,
      threshold: 1.4,
      packets_per_s: 42,
      rssi: -50,
      uptime_s: 100,
      camera: 'off',
      update: { state: 'idle', progress: 0 },
    },
    calls: [],
    down: false,
    close: async () => {},
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const read = (req: IncomingMessage) =>
    new Promise<any>((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text ? JSON.parse(text) : undefined));
    });

  const server: Server = createServer(async (req, res) => {
    if (board.down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const body = req.method === 'POST' ? await read(req) : undefined;
    const auth = req.headers.authorization;
    board.calls.push({ method: req.method!, path: url.pathname, body, auth });
    const authorized = board.token !== undefined && (auth === `Bearer ${board.token}` || url.searchParams.get('token') === board.token);

    if (url.pathname === '/manifest.json' && board.manifest) return send(res, 200, board.manifest);
    if (url.pathname === '/api/info') return send(res, 200, { ...board.info, paired: board.token !== undefined });
    if (url.pathname === '/api/pair') {
      if (board.token) return send(res, 409, { error: 'already paired: reset the sensor to pair it again' });
      board.token = 'token-' + id.toLowerCase();
      return send(res, 200, { token: board.token, ...board.info, paired: true });
    }
    if (!authorized) return send(res, 401, { error: 'token required' });
    if (url.pathname === '/api/state') return send(res, 200, board.state);
    if (url.pathname === '/api/config') {
      const restarting = body.camera !== undefined && body.camera !== board.info.camera.enabled;
      if (body.threshold !== undefined) board.info.config.threshold = board.state.threshold = body.threshold;
      if (body.hold_s !== undefined) board.info.config.hold_s = body.hold_s;
      if (body.presence_sensitivity !== undefined) board.info.config.presence_sensitivity = body.presence_sensitivity;
      if (body.camera !== undefined) board.info.camera = { enabled: body.camera, state: body.camera ? 'on' : 'off' };
      return send(res, 200, { ...board.info, paired: true, restarting });
    }
    if (url.pathname === '/api/recalibrate') return send(res, 200, { ok: true, calibration_s: 30 });
    if (url.pathname === '/api/update') return send(res, 202, { ok: true });
    if (url.pathname === '/api/reset') {
      board.token = undefined;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/snapshot') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    send(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  board.address = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  board.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return board;
}
