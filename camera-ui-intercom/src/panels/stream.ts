/**
 * Event streams of panels: one HTTP answer that never ends, cut into parts by a boundary (multipart/x-mixed-replace
 * of Dahua's eventManager, multipart/mixed of Hikvision's alertStream). Parts arrive split anywhere; the splitter
 * keeps what it has not seen whole yet, and gives a part as soon as it is whole: a ring must not wait for the next
 * event.
 */
import { fieldsOf, flatten } from './profile.js';

/** The boundary of a multipart Content-Type. */
export function boundaryOf(contentType: string | null): string | undefined {
  const match = contentType?.match(/boundary\s*=\s*"?([^";]+)"?/i);
  return match?.[1].trim();
}

/**
 * Cuts a multipart stream into the bodies of its parts. A part with a Content-Length (Dahua and Hikvision send one)
 * is given as soon as its bytes are there; one without waits for the next boundary. Bytes, not text: the length
 * counts bytes, and a name in an event may be Cyrillic.
 */
export class MultipartSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly marker: Buffer;

  constructor(boundary: string) {
    this.marker = Buffer.from(boundary.startsWith('--') ? boundary : `--${boundary}`);
  }

  /** The bodies of the parts completed by this chunk. */
  push(chunk: Uint8Array): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const bodies: string[] = [];
    for (;;) {
      const start = this.buffer.indexOf(this.marker);
      if (start < 0) {
        // keep a tail that may be the start of a marker
        if (this.buffer.length > this.marker.length) this.buffer = this.buffer.subarray(-this.marker.length);
        return bodies;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const headersEnd = this.buffer.indexOf('\r\n\r\n', this.marker.length);
      if (headersEnd < 0) return this.waiting(bodies);
      const headers = this.buffer.subarray(this.marker.length, headersEnd).toString('latin1');
      const length = /content-length\s*:\s*(\d+)/i.exec(headers);
      const bodyStart = headersEnd + 4;
      let body: Buffer;
      if (length) {
        const bodyEnd = bodyStart + Number(length[1]);
        if (this.buffer.length < bodyEnd) return this.waiting(bodies);
        body = this.buffer.subarray(bodyStart, bodyEnd);
        this.buffer = this.buffer.subarray(bodyEnd);
      } else {
        const next = this.buffer.indexOf(this.marker, bodyStart);
        if (next < 0) return this.waiting(bodies);
        body = this.buffer.subarray(bodyStart, next);
        this.buffer = this.buffer.subarray(next);
      }
      const text = body.toString('utf8').trim();
      if (text) bodies.push(text);
    }
  }

  private waiting(bodies: string[]): string[] {
    // a part that grows without end is not an event stream
    if (this.buffer.length > 256 * 1024) this.buffer = Buffer.alloc(0);
    return bodies;
  }
}

/** A part of Dahua's event stream: "Code=BackKeyLight;action=Pulse;index=0;data={ "State" : 1 }". Heartbeats give nothing. */
export function dahuaFields(body: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  // several events may share a part, each starting with "Code="
  for (const text of body.split(/\r?\n(?=Code=)/)) {
    const match = /^Code=([^;]*);action=([^;]*);index=([^;]*)(?:;data=([\s\S]*))?$/.exec(text.trim());
    if (!match) continue;
    const fields: Record<string, string> = { Code: match[1], action: match[2], index: match[3] };
    if (match[4]) {
      try {
        flatten(JSON.parse(match[4]), 'data', fields);
      } catch {
        fields.data = match[4].trim();
      }
    }
    out.push(fields);
  }
  return out;
}

/** A part of Hikvision's alertStream: an EventNotificationAlert in XML or JSON. */
export function hikvisionFields(body: string): Record<string, string>[] {
  const fields = fieldsOf(body);
  return Object.keys(fields).length ? [fields] : [];
}
