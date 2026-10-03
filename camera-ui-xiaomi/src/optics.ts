// The lens of a camera driven from ViON: zoom from the player's PTZ control, focus from the camera settings.
import type { MiotDevice } from './xiaomi/miot.js';
import type { Axis, Optics } from './xiaomi/spec.js';

/** A number zoom or focus goes this share of its range per step: ten steps from one end to the other. */
export const STEPS_PER_RANGE = 10;

export type Direction = 1 | -1;

/** One optical axis: a step each way, a value where the camera takes one, a stop where it moves until stopped. */
export interface AxisDriver {
  step: (direction: Direction) => Promise<void>;
  /** To a share of the range, 0 (wide, near) to 1 (tele, far); only for an axis with a range. */
  set?: (fraction: number) => Promise<void>;
  /** Ends a move the camera keeps doing by itself (an axis of values in, out and stop). */
  stop?: () => Promise<void>;
  /** Forgets the value it followed: read again at the next step (the app or a restart may have changed it). */
  reset?: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function axisDriver(axis: Axis, device: MiotDevice): AxisDriver {
  if (axis.kind === 'actions') {
    return { step: (direction) => device.action(direction > 0 ? axis.plus : axis.minus) };
  }

  if (axis.kind === 'values') {
    const stop = axis.stop;
    return {
      step: (direction) => device.set(axis.prop, direction > 0 ? axis.plus : axis.minus),
      ...(stop !== undefined ? { stop: () => device.set(axis.prop, stop) } : {}),
    };
  }

  const { min, max, step } = axis;
  const span = Math.max(step, Math.round((max - min) / STEPS_PER_RANGE / step) * step);
  const snap = (value: number) => clamp(min + Math.round((value - min) / step) * step, min, max);
  // the value is read once and then followed: a read before every step would double the time a step takes
  let current: number | undefined;
  const known = async (): Promise<number> => {
    if (current === undefined) {
      const value = Number(await device.get(axis.prop).catch(() => min));
      current = Number.isFinite(value) ? clamp(value, min, max) : min;
    }
    return current;
  };
  const write = async (value: number) => {
    await device.set(axis.prop, value);
    current = value;
  };
  // one after another: two quick presses are two steps, not the same one twice
  let queue: Promise<void> = Promise.resolve();
  const queued = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    step: (direction) =>
      queued(async () => {
        const next = snap((await known()) + direction * span);
        if (next !== current) await write(next);
      }),
    set: (fraction) => queued(() => write(snap(min + clamp(fraction, 0, 1) * (max - min)))),
    reset: () => {
      current = undefined;
    },
  };
}

/** What the lens of one camera does from ViON; empty for a fixed lens. */
export interface Lens {
  zoom?: AxisDriver;
  focus?: AxisDriver;
  autoFocus?: { kind: 'action'; run: () => Promise<void> } | { kind: 'switch'; set: (on: boolean) => Promise<void> };
}

export function lensOf(optics: Optics, device: MiotDevice): Lens {
  const lens: Lens = {};
  if (optics.zoom) lens.zoom = axisDriver(optics.zoom, device);
  if (optics.focus) lens.focus = axisDriver(optics.focus, device);
  const auto = optics.autoFocus;
  if (auto?.kind === 'action') lens.autoFocus = { kind: 'action', run: () => device.action(auto.action) };
  else if (auto?.kind === 'switch') lens.autoFocus = { kind: 'switch', set: (on) => device.set(auto.prop, on) };
  return lens;
}
