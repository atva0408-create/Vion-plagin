// Not a spec: measures the real speech path of the plugin for the report. Serves a folder laid out like the models
// mirror (v1/voice/*.tar.gz), lets ModelStore fetch and check the packs, and times SherpaEngine.
//   npx tsx spec/measure.ts <mirror folder> <work folder>
import { createReadStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { ModelStore, SherpaEngine } from '@vionvision/speech';

import type { AddressInfo } from 'node:net';
import type { Language } from '../src/speech.js';

const [mirror, work] = process.argv.slice(2);
const server = createServer((req, res) => {
  const path = join(mirror, req.url ?? '/');
  try {
    res.writeHead(200, { 'content-length': statSync(path).size });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.VION_MODELS_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const ms = (start: bigint) => Number((process.hrtime.bigint() - start) / 1_000_000n);
const engine = new SherpaEngine(new ModelStore(join(work, 'voice-models'), undefined, (m) => console.log(`  ${m}`)), (m) => console.log(`  ${m}`), () =>
  createRequire(import.meta.url)('sherpa-onnx-node'),
);
const PHRASES: Record<Language, string> = {
  ru: 'Артём, пора оставить компьютер и отдохнуть десять минут, глаза устают, а потом можно снова играть.',
  en: 'Artem, it is time to leave the computer and rest for ten minutes, your eyes are getting tired now.',
  de: 'Artem, es ist Zeit, den Computer zu verlassen und zehn Minuten zu ruhen, die Augen werden müde.',
};

console.log(`idle: ${mb()} MB`);
for (const language of ['ru', 'en', 'de'] as Language[]) {
  let start = process.hrtime.bigint();
  const first = await engine.synthesize(PHRASES[language], language, 1);
  console.log(`${language}: first phrase (download + load + synthesis) ${ms(start)} ms`);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    start = process.hrtime.bigint();
    await engine.synthesize(PHRASES[language], language, 1);
    runs.push(ms(start));
  }
  console.log(
    `${language}: ${PHRASES[language].split(/\s+/).length} words → ${(first.samples.length / first.sampleRate).toFixed(1)} s of speech, synthesis ${runs.join(' / ')} ms, ${mb()} MB`,
  );

  // the phrase back through recognition: 5 s at 16 kHz
  const rate = first.sampleRate;
  const samples = new Float32Array(16_000 * 5);
  for (let i = 0; i < samples.length; i++) {
    const position = (i * rate) / 16_000;
    samples[i] = first.samples[Math.floor(position)] ?? 0;
  }
  start = process.hrtime.bigint();
  await engine.transcribe(samples, language);
  console.log(`${language}: recognizer load + first 5 s ${ms(start)} ms`);
  const sttRuns: number[] = [];
  let heard = '';
  for (let i = 0; i < 3; i++) {
    start = process.hrtime.bigint();
    heard = await engine.transcribe(samples, language);
    sttRuns.push(ms(start));
  }
  console.log(`${language}: recognition of 5 s ${sttRuns.join(' / ')} ms, ${mb()} MB: "${heard}"`);
}
const vad = await engine.voiceActivity();
const start = process.hrtime.bigint();
vad.accept(new Float32Array(16_000 * 5));
vad.flush();
console.log(`voice activity over 5 s: ${ms(start)} ms`);
server.close();
