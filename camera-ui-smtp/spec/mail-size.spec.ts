// The SMTP server of the plugin, as a camera talks to it over TCP (review 2026-11-04): it listens on every address of
// the machine and read a mail into memory however long it went on. It says its SIZE in EHLO, refuses a client that
// names a larger one, answers 552 to a mail past the limit without keeping it, and goes on with the next mail.
// Run: npx --yes tsx spec/mail-size.spec.ts
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { Readable } from 'node:stream';

import SMTPPlugin from '../src/index.js';
import { MAX_MAIL_BYTES, readMail } from '../src/mail.js';

import type { ParsedMail } from 'mailparser';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** An SMTP client: sends a command, waits for the whole reply (its last line has a space after the code). */
async function client(port: number) {
  const socket = connect(port, '127.0.0.1');
  let buffer = '';
  const waiting: ((reply: string) => void)[] = [];
  socket.on('data', (data) => {
    buffer += data.toString('latin1');
    const end = buffer.match(/^\d{3} .*\r\n/m);
    if (end && waiting.length) {
      const at = buffer.indexOf(end[0]) + end[0].length;
      const reply = buffer.slice(0, at);
      buffer = buffer.slice(at);
      waiting.shift()!(reply);
    }
  });
  const reply = () => new Promise<string>((resolve) => waiting.push(resolve));
  await new Promise((resolve) => socket.once('connect', resolve));
  const send = async (line: string | Buffer) => {
    const answer = reply();
    socket.write(line);
    return answer;
  };
  return { greeting: await reply(), send, close: () => socket.destroy() };
}

const port = await freePort();
const logger = { log: () => undefined, debug: () => undefined, warn: (...a: unknown[]) => warnings.push(a.join(' ')), error: () => undefined };
const warnings: string[] = [];
const api = { on: () => undefined };
const storage = { values: { port, tls: true } };
const plugin = new SMTPPlugin(logger as never, api as never, storage as never);
const mails: ParsedMail[] = [];
(plugin as unknown as { handleMail: (mail: ParsedMail) => void }).handleMail = (mail) => mails.push(mail);
await new Promise((resolve) => setTimeout(resolve, 100));

const mail = (body: string) => `From: cam@yard\r\nTo: motion@vion\r\nSubject: Motion\r\n\r\n${body}\r\n.\r\n`;

try {
  const c = await client(port);
  assert.match(c.greeting, /^220 /);
  assert.match(await c.send('EHLO camera\r\n'), new RegExp(`250[ -]SIZE ${MAX_MAIL_BYTES}\\r\\n`), 'EHLO says the limit');

  // a client that names a larger size is refused before it sends
  assert.match(await c.send(`MAIL FROM:<cam@yard> SIZE=${MAX_MAIL_BYTES + 1}\r\n`), /^552 /);

  // a mail past the limit: 552, nothing parsed, the session goes on
  assert.match(await c.send('MAIL FROM:<cam@yard>\r\n'), /^250 /);
  assert.match(await c.send('RCPT TO:<motion@vion>\r\n'), /^250 /);
  assert.match(await c.send('DATA\r\n'), /^354 /);
  const big = Buffer.from(mail(`${'x'.repeat(76)}\r\n`.repeat(Math.ceil(MAX_MAIL_BYTES / 78) + 10)));
  assert.match(await c.send(big), /^552 /, 'past the limit: 552');
  assert.equal(mails.length, 0, 'the mail past the limit is not parsed');
  assert.match(warnings.join('\n'), /larger than 26214400 bytes was refused/);

  // the next mail of the same camera is taken
  assert.match(await c.send('MAIL FROM:<cam@yard>\r\n'), /^250 /);
  assert.match(await c.send('RCPT TO:<motion@vion>\r\n'), /^250 /);
  assert.match(await c.send('DATA\r\n'), /^354 /);
  assert.match(await c.send(mail('Motion detected')), /^250 /);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text ?? '', /Motion detected/);
  c.close();

  // readMail: the limit itself is taken, a byte more is not; nothing more than the limit is held
  assert.equal((await readMail(Readable.from([Buffer.alloc(6), Buffer.alloc(4)]), 10))?.length, 10);
  assert.equal(await readMail(Readable.from([Buffer.alloc(6), Buffer.alloc(5)]), 10), undefined);
  assert.equal((await readMail(Readable.from([]), 10))?.length, 0);
} finally {
  await (plugin as unknown as { stop: () => Promise<void> }).stop?.();
  (plugin as unknown as { server?: { close: () => void } }).server?.close();
}

console.log('mail-size.spec: SIZE in EHLO, a larger SIZE refused, 552 past the limit without parsing, the next mail taken — ok');
