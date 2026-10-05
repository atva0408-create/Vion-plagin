// A stand-in of a board with the ESPectre Native firmware: its Direct HTTP API and event stream (ESPectre docs/API.md,
// protocol 1.0) on a local port, with its resources in the open so a test can move them and push events. Like the board,
// it sends a motion reading every 200 ms while it measures and is ready.
import { createServer } from 'node:http';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface FakeEspectre {
  address: string;
  id: string;
  device: Record<string, any>;
  sensing: Record<string, any>;
  wifi: Record<string, any>;
  ota: Record<string, any> | undefined;
  calls: { method: string; path: string; body?: any }[];
  /** Open event streams. */
  streams: number;
  /** When set, every request is dropped without an answer and open streams are cut (the board is off). */
  down: boolean;
  /** When set, nothing is answered or sent and nothing is closed either: power or Wi-Fi gone, the sockets left hanging. */
  silent: boolean;
  /** What each reading says. */
  motion: { state: 'idle' | 'motion'; score: number };
  /** Stops the readings alone, the stream stays open and answers come. */
  pauseMotion: boolean;
  /** Answers 409 busy to calibration and OTA actions. */
  busy: boolean;
  emit(event: string, data: unknown): void;
  setDown(down: boolean): void;
  close(): Promise<void>;
}

export async function fakeEspectre(id = '3cf79180d3a0aca4'): Promise<FakeEspectre> {
  const clients = new Set<ServerResponse>();
  const board: FakeEspectre = {
    address: '',
    id,
    device: { device_id: id, name: 'Kitchen', label: 'Kitchen', frontend: 'native', firmware: '3.0.0-rc3', chip: 'esp32', csi_profile: 'lltf20' },
    sensing: {
      enabled: true,
      ready: true,
      calibrating: false,
      mode: 'sensing',
      derived_events_paused: false,
      detector: 'lightweight',
      threshold: 0.66,
      motion_on_hits: 2,
      motion_off_hits: 4,
      traffic_generator_mode: 'ping',
      csi_target_pps: 100,
    },
    wifi: { configured: true, connected: true, ssid: 'HomeV', bssid: '', band: '2g', channel: 6, rssi_dbm: -61 },
    ota: {
      state: 'idle',
      timestamp_ms: 1,
      busy: false,
      update_available: false,
      current_version: '3.0.0-rc3',
      target_version: '',
      manifest_url: '',
      image_url: '',
      default_channel: 'release',
      channel: 'release',
      message: '',
    },
    calls: [],
    streams: 0,
    down: false,
    silent: false,
    motion: { state: 'idle', score: 0.1 },
    pauseMotion: false,
    busy: false,
    emit(event, data) {
      if (board.silent) return;
      for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    setDown(down) {
      board.down = down;
      if (down) for (const res of clients) res.socket?.destroy();
    },
    close: async () => {},
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const result = (res: ServerResponse, status: number, code = 'ok', message = 'operation accepted') => send(res, status, { accepted: status < 300, code, message });
  const read = (req: IncomingMessage) =>
    new Promise<any>((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text ? JSON.parse(text) : undefined));
    });

  const readings = setInterval(() => {
    const s = board.sensing;
    if (board.down || board.pauseMotion || !s.enabled || s.mode !== 'sensing' || !s.ready || s.calibrating) return;
    board.emit('motion', { timestamp_ms: Date.now(), ...board.motion });
  }, 200);

  const server: Server = createServer(async (req, res) => {
    if (board.down) {
      req.socket.destroy();
      return;
    }
    if (board.silent) return; // the request hangs, as with a board that lost its power
    const url = new URL(req.url ?? '/', 'http://x');
    // the Native firmware takes only the origins of the ESPectre portals, and none at all is refused
    if (!['https://espectre.dev', 'https://www.espectre.dev', 'https://test.espectre.dev'].includes(String(req.headers.origin))) {
      return send(res, 403, { accepted: false, code: 'forbidden', message: req.headers.origin ? 'Origin rejected' : 'Origin required' });
    }
    const body = req.method === 'GET' ? undefined : await read(req);
    const path = url.pathname.replace(/^\/espectre\/v1/, '');
    board.calls.push({ method: req.method!, path, body });
    if (!url.pathname.startsWith('/espectre/v1/')) return send(res, 404, { accepted: false, code: 'not_found', message: 'not found' });

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': heartbeat\n\n');
      clients.add(res);
      board.streams = clients.size;
      res.on('close', () => {
        clients.delete(res);
        board.streams = clients.size;
      });
      return;
    }
    if (req.method === 'GET' && path === '/device') return send(res, 200, board.device);
    if (req.method === 'GET' && path === '/sensing') return send(res, 200, board.sensing);
    if (req.method === 'GET' && path === '/wifi') return send(res, 200, board.wifi);
    if (req.method === 'GET' && path === '/ota')
      return board.ota ? send(res, 200, board.ota) : send(res, 404, { accepted: false, code: 'not_found', message: 'not found' });
    if (req.method === 'GET' && path === '/diagnostics') {
      const fields = JSON.parse(url.searchParams.get('fields') ?? '[]') as string[];
      return send(res, 200, {
        timestamp_ms: 1,
        uptime: 1,
        ...(fields.includes('csi_accepted_pps') ? { csi_accepted_pps: 97.5 } : {}),
        ...(fields.includes('wifi_rssi_dbm') ? { wifi_rssi_dbm: board.wifi.rssi_dbm } : {}),
      });
    }
    if (req.method === 'PATCH' && path === '/sensing') {
      const allowed = ['enabled', 'detector', 'threshold', 'motion_on_hits', 'motion_off_hits', 'traffic_generator_mode'];
      if (!body || Object.keys(body).some((k) => !allowed.includes(k))) return result(res, 400, 'invalid_params', 'unknown field');
      // the two counts only together, as the firmware wants them
      if ('motion_on_hits' in body !== 'motion_off_hits' in body)
        return result(res, 400, 'invalid_params', 'motion_on_hits and motion_off_hits must be present together');
      if (body.threshold !== undefined && (body.threshold < 0 || body.threshold > 1)) return result(res, 400, 'invalid_params', 'threshold out of range');
      Object.assign(board.sensing, body);
      board.emit('sensing', board.sensing);
      return result(res, 200);
    }
    if (req.method === 'POST' && path === '/sensing/calibrations') return board.busy ? result(res, 409, 'busy', 'operation busy') : result(res, 202);
    if (req.method === 'POST' && (path === '/ota/checks' || path === '/ota/updates')) {
      if (!board.ota) return send(res, 404, { accepted: false, code: 'not_found', message: 'not found' });
      return board.busy ? result(res, 409, 'busy', 'ota busy') : result(res, 202);
    }
    send(res, 404, { accepted: false, code: 'not_found', message: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  board.address = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  board.close = () =>
    new Promise<void>((resolve) => {
      clearInterval(readings);
      for (const res of clients) res.socket?.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return board;
}
