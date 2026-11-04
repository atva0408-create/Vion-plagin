import type { Readable } from 'node:stream';

/**
 * The largest mail taken, its attachments included (a camera's snapshots, a clip): mail servers take as much. The
 * server listens on every address of the machine, and a mail was read into memory however long it went on.
 */
export const MAX_MAIL_BYTES = 25 * 1024 * 1024;

/**
 * The mail of a DATA command, whole, or nothing when it is larger than `limit`: what goes past the limit is read to
 * its end and dropped, so the client gets its answer and memory holds `limit` bytes at most.
 */
export async function readMail(stream: Readable, limit = MAX_MAIL_BYTES): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  return size <= limit ? Buffer.concat(chunks) : undefined;
}
