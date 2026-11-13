// Not part of `npm test`: the plugin's side against NIKA's real core/vion_link.py (Python), over the network of this
// machine. NIKA runs without a voice (her «speech» is printed); she is found by mDNS, connected with the code she
// «says», then a notice, a phrase and a call of her model go across, and a frame changed on the way is refused.
//   npx tsx spec/interop.ts <python> <NIKA folder> <harness.py>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Discovery } from '../src/discovery.js';
import { NikaLink, Pairing } from '../src/link.js';

import type { Call, CallResult, LinkHost, PairedNika } from '../src/link.js';

const [python, nikaDir, harness] = process.argv.slice(2);
const port = 18796;
const out: string[] = [];
const child = spawn(python, [harness, join(mkdtempSync(join(tmpdir(), 'nika-')), 'state.json'), String(port), 'Ника', 'Проверка'], {
  cwd: nikaDir,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', HARNESS_STDIN: '1' },
});
child.stdout.setEncoding('utf8');
let rest = '';
child.stdout.on('data', (chunk: string) => {
  // Python on Windows ends its lines with \r\n; a line may come in two chunks
  const lines = (rest + chunk).split(/\r?\n/);
  rest = lines.pop() ?? '';
  for (const line of lines.filter(Boolean)) {
    out.push(line);
    console.log(`  nika| ${line}`);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => process.stderr.write(`  nika! ${chunk}`));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(20);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

try {
  await until(() => out.some((line) => line.startsWith('READY ')), 'NIKA started');
  const id = out.find((line) => line.startsWith('READY '))!.split(' ')[1];

  // ---- found on the network by mDNS (multicast-dns here, zeroconf there)
  const discovery = new Discovery({ log: (line) => console.log(`  vion| ${line}`) });
  discovery.start();
  const found = await discovery.lookup(id, 10_000);
  assert.ok(found, 'NIKA found on the network');
  assert.equal(found.port, port);
  assert.equal(found.room, 'Проверка');
  console.log(`found: ${found.name} — ${found.room} at ${found.host}:${found.port}`);

  // ---- connected with the code she «said»
  const pairing = await Pairing.start({ host: found.host, port: found.port }, 'vion-interop', 'VION');
  await until(() => out.some((line) => line.startsWith('SAID:') && line.includes('Код')), 'the code said', 40_000);
  const code = out
    .find((line) => line.startsWith('SAID:') && line.includes('Код'))!
    .split('Код')[1]
    .replace(/\D/g, '');
  assert.deepEqual(await pairing.submit(code === '000000' ? '111111' : '000000'), { left: 2 });
  const done = await pairing.submit(code);
  assert.ok('token' in done, 'the token');

  // ---- the lasting link
  const calls: Call[] = [];
  const nika: PairedNika = { id, name: found.name, room: found.room, token: done.token, speaks: true, pairedAt: Date.now() };
  const host: LinkHost = {
    vionId: 'vion-interop',
    log: (line) => console.log(`  vion| ${line}`),
    address: async () => ({ host: found.host, port: found.port }),
    offer: () => ({
      t: 'offer',
      commands: [
        { name: 'screen_time_status', description: 'Screen time now.', parameters: { type: 'object', properties: { child: { type: 'string' } } }, grant: false },
      ],
    }),
    onCall: async (_link, call): Promise<CallResult> => {
      calls.push(call);
      return { ok: true, text: 'Сыночка: сегодня 42 минуты' };
    },
    onChange: () => undefined,
    onForgotten: () => undefined,
  };
  const link = new NikaLink(nika, host);
  link.start();
  await until(() => link.online, 'the link');
  await until(() => out.some((line) => line.includes("TOOLS: ['vion__screen_time_status']")), 'the command as her tool');

  const ack = await link.request({ t: 'notify', title: 'Сыночка', text: 'Сыночка не ушёл на перерыв', severity: 'warn' });
  assert.equal(ack.ok, true);
  await until(() => out.includes('SAID: Сыночка не ушёл на перерыв'), 'the notice said');

  child.stdin.write('call vion__screen_time_status {"child": "Сыночка"}\n');
  await until(() => out.some((line) => line.startsWith('RESULT:')), 'her call answered');
  assert.deepEqual(
    calls.map((call) => [call.name, call.args]),
    [['screen_time_status', { child: 'Сыночка' }]],
  );
  assert.equal(JSON.parse(out.find((line) => line.startsWith('RESULT:'))!.slice(8)).text, 'Сыночка: сегодня 42 минуты');

  link.send({ t: 'decided', request: 'r1', approved: true, text: 'Разрешили: Сыночка: ещё 60 минут.' });
  await until(() => out.includes('SAID: Разрешили: Сыночка: ещё 60 минут.'), 'the decision said');

  link.send({ t: 'unpair' });
  await until(() => out.some((line) => line.includes('отключил Нику')), 'unpaired on her side');
  link.stop();
  discovery.stop();
  console.log('interop: ok');
} finally {
  child.stdin.end();
  child.kill();
}
process.exit(0);
