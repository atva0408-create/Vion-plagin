// Tools the assistant can call on ViON Sensor boards: what a board feels now (motion level against its threshold,
// presence, calibration, signal, firmware), a calibration on the empty room, and the threshold, the hold time and the
// source of motion. Reading runs without asking; the changes declare `approval` and `adminOnly` and answer `__preview`
// (set only by the server, for the confirmation card) with lines that say what they would do, doing nothing. The
// firmware is never installed from here: the board restarts and may not come back, that is for the settings page.
// i18n-skip-file: the descriptions are read by the model; the card lines below carry their own three languages.

import type { AssistantToolContext, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';
import type { VionSensorLive } from './index.js';
import type { MotionSource } from './sensor.js';

/** One board as the tools see it; kept narrow so they are testable without a board. */
export interface AssistantBoard {
  name: string;
  /** vion: the ViON firmware; espectre: an ESPectre board, which keeps its own threshold. */
  kind: 'vion' | 'espectre';
  live: VionSensorLive;
  firmware?: string;
  /** A newer firmware in the list, to install on the settings page. */
  newerFirmware?: string;
  threshold?: number;
  holdS: number;
  /** Which algorithm makes the motion; undefined on a board that has one only. */
  motionSource?: MotionSource;
  /** The board has the Espressif algorithm (firmware 1.1.0 and later). */
  hasPresence: boolean;
  /** How long a calibration takes, seconds; undefined when the board does not say. */
  calibrationS?: number;
  calibrate(): Promise<void>;
  configure(patch: { threshold?: number; holdS?: number; motionSource?: MotionSource }): Promise<void>;
}

export interface SensorAssistantHost {
  boards(): AssistantBoard[];
}

type Input = Record<string, unknown>;
type Lang = 'ru' | 'en' | 'de';

export const THRESHOLD = { min: 1.05, max: 5 };
export const HOLD_S = { min: 1, max: 600 };
const SOURCES: MotionSource[] = ['vion', 'espressif', 'any'];
const ACTING = new Set(['calibrate', 'tune']);

const sensorField = { type: 'string', description: 'Name of the sensor; may be left out when there is one.' } as const;

export const SENSOR_TOOLS: AssistantToolSpec[] = [
  {
    name: 'live',
    description:
      'What ViON Sensor boards feel now: state (quiet, motion, calibrating, blind, offline), motion level against the threshold (motion at 1), ' +
      'presence, Wi-Fi signal, packets per second, the firmware and whether a newer one is out (installed on the settings page only).',
    inputSchema: { type: 'object', properties: { sensor: sensorField } },
    lazy: true,
  },
  {
    name: 'calibrate',
    description:
      'Let a sensor learn the empty room again (false alarms, missed motion after furniture moved). Nobody may be in the room meanwhile. Requires user confirmation.',
    inputSchema: { type: 'object', properties: { sensor: sensorField } },
    approval: true,
    adminOnly: true,
    lazy: true,
  },
  {
    name: 'tune',
    description:
      'Change a sensor: threshold (1.05–5, lower is more sensitive and gives more false alarms), holdSeconds (how long motion lasts after the ' +
      'last movement, 1–600), motionSource (vion: signal changes, espressif: esp-radar, any: either). Requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        sensor: sensorField,
        threshold: { type: 'number', minimum: THRESHOLD.min, maximum: THRESHOLD.max },
        holdSeconds: { type: 'number', minimum: HOLD_S.min, maximum: HOLD_S.max },
        motionSource: { type: 'string', enum: SOURCES },
      },
    },
    approval: true,
    adminOnly: true,
    lazy: true,
  },
];

// prettier-ignore
const T: Record<Lang, Record<string, (v: Record<string, string>) => string>> = {
  ru: {
    calibrate: (v) => `${v.sensor}: калибровка на пустой комнате`,
    calibrateEmpty: (v) => `В комнате никого не должно быть ${v.seconds} секунд, иначе датчик примет человека за пустую комнату`,
    calibrateEmptyAny: () => 'В комнате никого не должно быть, пока идёт калибровка',
    threshold: (v) => `Порог движения: ${v.from} → ${v.to}`,
    hold: (v) => `Движение держится, с: ${v.from} → ${v.to}`,
    source: (v) => `Источник движения: ${v.from} → ${v.to}`,
    nothing: (v) => `${v.sensor}: всё уже так, ничего не меняется`,
    vion: () => 'ViON', espressif: () => 'Espressif', any: () => 'любой из двух',
  },
  de: {
    calibrate: (v) => `${v.sensor}: Kalibrierung auf den leeren Raum`,
    calibrateEmpty: (v) => `Der Raum muss ${v.seconds} Sekunden leer bleiben, sonst hält der Sensor eine Person für den leeren Raum`,
    calibrateEmptyAny: () => 'Der Raum muss leer bleiben, solange die Kalibrierung läuft',
    threshold: (v) => `Bewegungsschwelle: ${v.from} → ${v.to}`,
    hold: (v) => `Bewegung hält, s: ${v.from} → ${v.to}`,
    source: (v) => `Quelle der Bewegung: ${v.from} → ${v.to}`,
    nothing: (v) => `${v.sensor}: alles ist schon so, nichts ändert sich`,
    vion: () => 'ViON', espressif: () => 'Espressif', any: () => 'einer von beiden',
  },
  en: {
    calibrate: (v) => `${v.sensor}: calibrate on the empty room`,
    calibrateEmpty: (v) => `Nobody may be in the room for ${v.seconds} seconds, or the sensor takes a person for the empty room`,
    calibrateEmptyAny: () => 'Nobody may be in the room while it calibrates',
    threshold: (v) => `Motion threshold: ${v.from} → ${v.to}`,
    hold: (v) => `Motion lasts, s: ${v.from} → ${v.to}`,
    source: (v) => `Source of motion: ${v.from} → ${v.to}`,
    nothing: (v) => `${v.sensor}: all is so already, nothing changes`,
    vion: () => 'ViON', espressif: () => 'Espressif', any: () => 'either of them',
  },
};

const langOf = (language: string): Lang => (language.startsWith('ru') ? 'ru' : language.startsWith('de') ? 'de' : 'en');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function oneBoard(host: SensorAssistantHost, value: unknown): AssistantBoard | { error: string } {
  const boards = host.boards();
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!wanted) return boards.length === 1 ? boards[0] : { error: `Name the sensor: ${boards.map((b) => b.name).join(', ') || 'none is added'}` };
  return boards.find((b) => b.name.toLowerCase() === wanted) ?? { error: `No sensor "${String(value)}". The sensors: ${boards.map((b) => b.name).join(', ') || 'none'}` };
}

export async function callSensorTool(host: SensorAssistantHost, name: string, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  try {
    if (name === 'live') return live(host, input);
    if (!ACTING.has(name)) return { error: `Unknown tool ${name}` };
    // the server offers these to admins only; a call that gets here otherwise is refused here too
    if (ctx.role !== 'admin' && ctx.role !== 'master') return { error: 'Only an administrator can do this.' };
    const preview = input.__preview === true;
    const t = T[langOf(ctx.language)];
    return name === 'calibrate' ? await calibrate(host, input, preview, t) : await tune(host, input, preview, t);
  } catch (error) {
    return { error: errorText(error) };
  }
}

function describe(board: AssistantBoard) {
  const { live: l } = board;
  return {
    sensor: board.name,
    state: l.state,
    ...(l.state === 'calibrating' ? { calibrationLeftS: l.calibrationLeftS } : {}),
    level: round(l.level),
    threshold: round(l.threshold),
    motionAt: board.kind === 'vion' ? 'level = threshold' : 'level = 1',
    ...(l.presence ? { presence: l.presence.state } : {}),
    ...(l.radar ? { radarTargets: l.radar.targets.length } : {}),
    rssiDbm: l.rssi,
    packetsPerS: round(l.packetsPerS, 0),
    holdS: board.holdS,
    ...(board.motionSource ? { motionSource: board.motionSource } : {}),
    ...(board.firmware ? { firmware: board.firmware } : {}),
    ...(board.newerFirmware ? { newerFirmware: board.newerFirmware, firmwareNote: 'Installed on the settings page of the sensor, not from the chat.' } : {}),
  };
}

function live(host: SensorAssistantHost, input: Input): AssistantToolResult {
  if (typeof input.sensor === 'string' && input.sensor.trim()) {
    const board = oneBoard(host, input.sensor);
    return 'error' in board ? board : { content: describe(board) };
  }
  const boards = host.boards();
  return { content: boards.length ? boards.map(describe) : { note: 'No ViON Sensor is added.' } };
}

async function calibrate(host: SensorAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const board = oneBoard(host, input.sensor);
  if ('error' in board) return board;
  if (board.live.state === 'offline') return { error: `"${board.name}" does not answer: it cannot calibrate now.` };
  if (preview) {
    const empty = board.calibrationS ? t.calibrateEmpty({ seconds: String(board.calibrationS) }) : t.calibrateEmptyAny({});
    return { content: { preview: { lines: [t.calibrate({ sensor: board.name }), empty] } } };
  }
  await board.calibrate();
  return { content: { done: true, sensor: board.name, note: `Calibrating${board.calibrationS ? ` for ${board.calibrationS} s` : ''}: the room must stay empty.` } };
}

async function tune(host: SensorAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const board = oneBoard(host, input.sensor);
  if ('error' in board) return board;
  const patch: { threshold?: number; holdS?: number; motionSource?: MotionSource } = {};
  if (input.threshold !== undefined) {
    const value = Number(input.threshold);
    if (board.kind !== 'vion')
      return { error: `"${board.name}" is an ESPectre board: its threshold has another scale and is set in the settings of the sensor. Nothing was changed.` };
    if (!Number.isFinite(value) || value < THRESHOLD.min || value > THRESHOLD.max) return { error: `threshold: ${THRESHOLD.min}–${THRESHOLD.max}. Nothing was changed.` };
    patch.threshold = round(value);
  }
  if (input.holdSeconds !== undefined) {
    const value = Number(input.holdSeconds);
    if (!Number.isFinite(value) || value < HOLD_S.min || value > HOLD_S.max) return { error: `holdSeconds: ${HOLD_S.min}–${HOLD_S.max}. Nothing was changed.` };
    patch.holdS = Math.round(value);
  }
  if (input.motionSource !== undefined) {
    const source = input.motionSource as MotionSource;
    if (!SOURCES.includes(source)) return { error: `motionSource: ${SOURCES.join(', ')}. Nothing was changed.` };
    if (board.kind !== 'vion' || (!board.hasPresence && source !== 'vion')) {
      return { error: `"${board.name}" has the ViON algorithm only (the Espressif one comes with firmware 1.1.0). Nothing was changed.` };
    }
    patch.motionSource = source;
  }
  if (!Object.keys(patch).length) return { error: 'Name what to change: threshold, holdSeconds or motionSource.' };

  const changes: string[] = [];
  if (patch.threshold !== undefined && patch.threshold !== board.threshold)
    changes.push(t.threshold({ from: String(board.threshold ?? '?'), to: String(patch.threshold) }));
  if (patch.holdS !== undefined && patch.holdS !== board.holdS) changes.push(t.hold({ from: String(board.holdS), to: String(patch.holdS) }));
  if (patch.motionSource !== undefined && patch.motionSource !== board.motionSource) {
    changes.push(t.source({ from: t[board.motionSource ?? 'vion']({}), to: t[patch.motionSource]({}) }));
  }
  if (preview) {
    return { content: { preview: { lines: changes.length ? [board.name, ...changes] : [t.nothing({ sensor: board.name })] } } };
  }
  if (!changes.length) return { content: { done: false, sensor: board.name, reason: 'Everything is so already.' } };
  await board.configure(patch);
  return { content: { done: true, sensor: board.name, ...patch } };
}
