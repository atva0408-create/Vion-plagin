// Not a spec of the test run: checks the published bundle the way the host loads it (CommonJS, from dist/), with the
// real speech engine. Needs `npm run build && npx cui bundle` first and a folder laid out like the models mirror.
//   node spec/bundle.check.cjs <unpacked bundle dir> <mirror folder>
const { createServer } = require('node:http');
const { createReadStream, mkdtempSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const [dir, mirror] = process.argv.slice(2);
const server = createServer((req, res) => {
  const path = join(mirror, req.url);
  try {
    res.writeHead(200, { 'content-length': statSync(path).size });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1', async () => {
  process.env.VION_MODELS_HOST = `http://127.0.0.1:${server.address().port}`;
  const Plugin = require(join(dir, 'dist', 'index.js')).default;
  const packets = [];
  const subject = () => ({ subscribe: () => ({ unsubscribe() {} }) });
  const source = {
    backchannelAudioCodec: 'opus',
    createRtpSession: () => ({
      hasBackchannel: true,
      onError: subject(),
      onEnded: subject(),
      startStream: async () => undefined,
      startBackchannel: async () => undefined,
      sendAudioPacket: async (p) => void packets.push(p),
      stop: async () => undefined,
    }),
    snapshot: async () => undefined,
  };
  const storage = (schemas) => {
    const s = { schemas, values: {}, setValue: async (k, v) => { s.values[k] = v; await s.schemas.find((x) => x.key === k)?.onSet?.(v); }, hasSchema: () => true, changeSchema: async () => undefined, setInternalValue: async () => undefined };
    return s;
  };
  const camera = { id: 'kids', name: 'Детская', connected: true, sources: [source], streamSource: source, zones: { object: [] }, onDetectionEvent: subject(), onPropertyChange: () => subject(), createStorage: (schemas) => (camera.storage = storage(schemas)) };
  const logger = { log() {}, warn: console.warn, error: console.error, debug() {}, success() {}, trace() {}, attention() {} };
  const api = { storagePath: mkdtempSync(join(tmpdir(), 'voice-bundle-')), on() {}, coreManager: { assistantAsk: async () => ({ ok: false, reason: 'unconfigured', message: '' }), assistantAccess: async () => ({ allowed: false }) }, notificationManager: { publish: async () => undefined } };
  const plugin = new Plugin(logger, api, storage([]));
  plugin.storage = storage(plugin.storageSchema);
  await plugin.configureCameras([camera]);
  const speakerText = await camera.storage.schemas.find((s) => s.key === 'speaker').onGet();
  console.log('drawer text from i18n/speech:', speakerText);
  const started = Date.now();
  const result = await camera.storage.schemas.find((s) => s.key === 'testPhrase').onClick();
  console.log('test phrase:', JSON.stringify(result), `${Date.now() - started} ms,`, packets.length, 'RTP packets');
  server.close();
  process.exit(result.toast?.type === 'success' && packets.length > 50 && /можно говорить/.test(speakerText) ? 0 : 1);
});
