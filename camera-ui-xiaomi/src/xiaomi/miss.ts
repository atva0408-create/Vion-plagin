import { decode, encode, sharedKey } from './crypto.js';
import { Cs2Connection } from './cs2.js';

import type { Transport } from './cs2.js';

// Commands of the Mi Home camera protocol (miss) over a CS2 session, as go2rtc sends them (pkg/xiaomi/miss/client.go):
// the sign-in with our public key and the signature the cloud made for it, then commands encrypted with the shared key.

const CMD_AUTH_REQ = 0x100;
const CMD_MOTOR_REQ = 0x112;
const CMD_MOTOR_RES = 0x113;
const CMD_ENCODED = 0x1001;

const AUTH_MS = 5000;

/**
 * A step of the motor, as the Mi Home app asks for it (`{"operation": n}` with MISS_CMD_MOTOR_REQ). Checked on a
 * Xiaomi Smart Camera C300 (xiaomi.camera.c01a01): left raises the reported angle, up the elevation.
 */
export enum MotorStep {
  Left = 1,
  Right = 2,
  Up = 3,
  Down = 4,
}

/** What the camera reports about its motor: `ret` 0 when it took the step, and where it points. */
export interface MotorAnswer {
  ret?: number;
  angle?: number;
  elevation?: number;
  /** the text of an answer that is no JSON */
  raw?: string;
}

/** Keys of one session, as the cloud gives them for a connection (see cameraStreamUrl). */
export interface SessionKeys {
  client_public: string;
  client_private: string;
  device_public: string;
  sign: string;
  vendor?: string;
  relay_uid?: string;
  relay_init?: string;
}

export class MissSession {
  private constructor(
    private readonly connection: Cs2Connection,
    private readonly key: Buffer,
    private readonly onAnswer: (answer: MotorAnswer) => void,
  ) {
    void this.readAnswers();
  }

  /**
   * Opens a session of its own with the camera. The camera answers every step several times as the motor turns, and
   * the answers lag behind the steps: they are read here as they come and handed to `onAnswer`.
   */
  public static async open(host: string, keys: SessionKeys, onAnswer: (answer: MotorAnswer) => void, transport?: Transport): Promise<MissSession> {
    if (keys.vendor && keys.vendor !== 'cs2') throw new Error(`The camera connects over ${keys.vendor}: the plugin turns cameras over CS2 only`);
    const key = sharedKey(keys.device_public, keys.client_private);
    const connection = await Cs2Connection.dial(host, transport);
    try {
      const auth = JSON.stringify({ public_key: keys.client_public, sign: keys.sign, uuid: '', support_encrypt: 0 });
      await connection.writeCommand(CMD_AUTH_REQ, Buffer.from(auth));
      const answer = await connection.readCommand(AUTH_MS);
      if (!answer.data.includes('"result":"success"')) throw new Error(`The camera refused the session: ${answer.data.toString().slice(0, 200)}`);
    } catch (error) {
      connection.close();
      throw error;
    }
    return new MissSession(connection, key, onAnswer);
  }

  public get closed(): boolean {
    return this.connection.closed;
  }

  public get transport(): Transport {
    return this.connection.transport;
  }

  /** One step of the motor; the camera's answer comes to `onAnswer`. */
  public async move(step: MotorStep): Promise<void> {
    const plain = Buffer.concat([Buffer.alloc(4), Buffer.from(JSON.stringify({ operation: step }))]);
    plain.writeUInt32BE(CMD_MOTOR_REQ, 0);
    await this.connection.writeCommand(CMD_ENCODED, encode(plain, this.key));
  }

  public close(): void {
    this.connection.close();
  }

  private async readAnswers(): Promise<void> {
    while (!this.connection.closed) {
      let command;
      try {
        // no time limit of its own: the session is closed when it is no longer used, and that ends the wait
        command = await this.connection.readCommand(2 ** 31 - 1);
      } catch {
        return; // closed: the next step opens a new session and reports why this one could not be used
      }
      if (command.cmd !== CMD_ENCODED) continue;
      try {
        const plain = decode(command.data, this.key);
        if (plain.length < 4 || plain.readUInt32BE(0) !== CMD_MOTOR_RES) continue;
        this.onAnswer(parseAnswer(plain.subarray(4).toString()));
      } catch {
        // A damaged response must not reject the detached reader and take down the plugin process.
        this.connection.close();
        return;
      }
    }
  }
}

/** The camera's JSON, which ends with a NUL; an answer that is no JSON counts as a refusal, with its text. */
export function parseAnswer(text: string): MotorAnswer {
  const json = text.replace(/\0+$/, '');
  try {
    const answer: unknown = JSON.parse(json);
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) return answer;
    return { ret: -1, raw: json.slice(0, 200) };
  } catch {
    return { ret: -1, raw: json.slice(0, 200) };
  }
}
