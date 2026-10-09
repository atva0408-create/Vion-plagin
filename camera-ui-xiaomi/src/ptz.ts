import { PTZCapability, PTZControl } from '@camera.ui/sdk';

import { MotorStep } from './xiaomi/miss.js';
import { errorText } from './xiaomi/text.js';

import type { LoggerService, PTZDirection, PTZPosition, PTZRelativeMove } from '@camera.ui/sdk';
import type { AxisDriver, Direction } from './optics.js';
import type { MissSession, MotorAnswer } from './xiaomi/miss.js';

/**
 * A held direction steps the motor this often. Measured on a C300: a step turns the camera about 5° in half a second,
 * and a step that comes while it turns carries the turn on instead of adding to it. 500 ms apart the motor stopped
 * before every step (a jerky turn, and the camera dropped some steps); 250 ms apart the steps make one even turn of
 * about 11° a second that stops half a second after the last one, with room for a step late over Wi-Fi.
 */
export const STEP_INTERVAL_MS = 250;
/** How long the motor turns after a step: until then the camera counts as moving. */
export const STEP_TURN_MS = 500;
/** A held zoom steps this often: every step is a request to the Mi Home cloud, the pace the zoom was made for. */
export const ZOOM_STEP_INTERVAL_MS = 500;
/** A held direction ends by itself after this long: a stop that never comes (a closed page) does not turn the camera round. */
export const HOLD_LIMIT_MS = 10_000;
/** The session of the motor is closed after this long without a step. */
export const IDLE_MS = 30_000;

export type OpenSession = (onAnswer: (answer: MotorAnswer) => void) => Promise<MissSession>;

export interface PtzTiming {
  stepMs: number;
  holdMs: number;
  idleMs: number;
  turnMs: number;
  zoomStepMs: number;
}

/** The direction of a move, the larger axis winning: the motor steps along one axis at a time. */
export function stepOf(pan: number, tilt: number): MotorStep | undefined {
  if (pan === 0 && tilt === 0) return undefined;
  if (Math.abs(pan) >= Math.abs(tilt)) return pan > 0 ? MotorStep.Right : MotorStep.Left;
  return tilt > 0 ? MotorStep.Up : MotorStep.Down;
}

/** What a held control does: a step of the motor or of the zoom, repeated while held. */
interface Move {
  key: string;
  run: (current?: () => boolean) => Promise<void>;
  /** ends a move the camera keeps doing by itself */
  end?: () => Promise<void>;
}

/** Whether the zoom is the larger part of a move: the player sends pan, tilt and zoom together, one of them set. */
function zoomWins(pan: number, tilt: number, zoom: number): boolean {
  return zoom !== 0 && Math.abs(zoom) > Math.max(Math.abs(pan), Math.abs(tilt));
}

/**
 * Pan, tilt and zoom of a Xiaomi camera. The stream engine has no motor command, so the plugin opens a P2P session of
 * its own with the camera, the way the Mi Home app turns it, and keeps it while the camera is being moved. A camera
 * with a zoom lens zooms through the Mi Home cloud, as the app does.
 */
export class XiaomiPtz extends PTZControl {
  private disposed = false;
  private stopped = false;
  private epoch = 0;
  private velocityRevision = 0;
  private session?: Promise<MissSession>;
  private queue: Promise<void> = Promise.resolve();
  private hold?: { key: string; until: number; timer: NodeJS.Timeout; busy: boolean; end?: () => Promise<void> };
  private lensQueue: Promise<void> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private movingTimer?: NodeJS.Timeout;
  private refusals = 0;
  private readonly timing: PtzTiming;

  constructor(
    private readonly open: OpenSession,
    private readonly logger: LoggerService,
    timing: Partial<PtzTiming> = {},
    private readonly zoom?: AxisDriver,
  ) {
    super('Xiaomi PTZ');
    this.capabilities = [PTZCapability.Pan, PTZCapability.Tilt, ...(zoom ? [PTZCapability.Zoom] : []), PTZCapability.RelativeMove, PTZCapability.VelocityControl];
    // a pace given for the steps (tests) is the zoom's too, unless the zoom has its own
    this.timing = {
      stepMs: STEP_INTERVAL_MS,
      holdMs: HOLD_LIMIT_MS,
      idleMs: IDLE_MS,
      turnMs: STEP_TURN_MS,
      ...timing,
      zoomStepMs: timing.zoomStepMs ?? timing.stepMs ?? ZOOM_STEP_INTERVAL_MS,
    };
  }

  /**
   * Held direction: steps until the stop (all speeds 0) or `holdMs`. The player sends the held direction again and
   * again while it is held: that only keeps the hold going, it does not step faster.
   */
  public override async setVelocity(value: PTZDirection | undefined): Promise<void> {
    if (!value || !this.canControl()) return;
    const revision = ++this.velocityRevision;
    const move = this.moveOf(value.panSpeed, value.tiltSpeed, value.zoomSpeed ?? 0);
    if (move && this.hold?.key === move.key) {
      this.hold.until = Date.now() + this.timing.holdMs;
    } else {
      this.endHold();
      if (move) {
        // a new zoom gesture reads where the zoom is: the app or a restart of the camera may have moved it
        if (move.key.startsWith('zoom:')) this.zoom?.reset?.();
        const timer = setInterval(
          () => {
            if (this.hold && Date.now() < this.hold.until) void this.run(move);
            else this.endHold();
          },
          move.key.startsWith('zoom:') ? this.timing.zoomStepMs : this.timing.stepMs,
        );
        this.hold = { key: move.key, until: Date.now() + this.timing.holdMs, timer, busy: false, end: move.end };
        await this.run(move);
      }
    }
    if (this.canControl() && revision === this.velocityRevision) await super.setVelocity(value);
  }

  /** One step in the direction of the move: the camera has no finer or measured moves. */
  public override async setRelativeMove(value: PTZRelativeMove): Promise<void> {
    if (!this.canControl()) return;
    const epoch = this.epoch;
    const move = this.moveOf(value.panDelta, value.tiltDelta, value.zoomDelta ?? 0);
    if (move) {
      if (move.key.startsWith('zoom:')) this.zoom?.reset?.();
      await move.run(() => this.isCurrent(epoch));
      await move.end?.();
    }
    if (this.isCurrent(epoch)) await super.setRelativeMove(value);
  }

  /** Only the zoom has a position: the motor of a Xiaomi camera does not say where it points. Home zooms out. */
  public override async setPosition(value: PTZPosition): Promise<void> {
    if (!this.canControl()) return;
    const epoch = this.epoch;
    const set = this.zoom?.set;
    if (!set || typeof value?.zoom !== 'number' || !Number.isFinite(value.zoom)) return;
    const zoom = Math.min(1, Math.max(0, value.zoom));
    // the position is the zoom the camera took, not one it refused
    if ((await this.lens(() => set(zoom), 'set the zoom')) && this.isCurrent(epoch)) await super.setPosition({ ...this.position, zoom });
  }

  /** Ends what is running: the held direction and the session. */
  public dispose(): void {
    this.disposed = true;
    this.stopControl();
  }

  private stopControl(): void {
    this.stopped = true;
    this.epoch++;
    this.velocityRevision++;
    this.endHold();
    clearTimeout(this.idleTimer);
    clearTimeout(this.movingTimer);
    this.closeSession();
    this.setMoving(false);
  }

  protected override onStop(): void {
    this.stopControl();
  }

  protected override onStart(): void {
    if (!this.disposed) {
      this.stopped = false;
      this.epoch++;
    }
  }

  private canControl(): boolean {
    return !this.disposed && !this.stopped;
  }

  private isCurrent(epoch: number): boolean {
    return this.canControl() && epoch === this.epoch;
  }

  private moveOf(pan: number, tilt: number, zoom: number): Move | undefined {
    if (![pan, tilt, zoom].every(Number.isFinite)) return;
    const lens = this.zoom;
    if (lens && zoomWins(pan, tilt, zoom)) {
      const direction: Direction = zoom > 0 ? 1 : -1;
      const stop = lens.stop;
      return {
        key: `zoom:${direction}`,
        run: async (current) => void (await this.lens(() => lens.step(direction), direction > 0 ? 'zoom in' : 'zoom out', `zoom:${direction}`, current)),
        ...(stop ? { end: async () => void (await this.lens(stop, 'stop the zoom', undefined, undefined, true)) } : {}),
      };
    }
    const step = stepOf(pan, tilt);
    return step === undefined ? undefined : { key: `motor:${step}`, run: (current) => this.step(step, current) };
  }

  /** A step of a held move; a step still on its way is not followed by another (the zoom goes through the cloud). */
  private async run(move: Move): Promise<void> {
    const hold = this.hold;
    if (hold?.key === move.key) {
      if (hold.busy) return;
      hold.busy = true;
    }
    try {
      await move.run(() => this.canControl() && (!hold || this.hold === hold));
    } finally {
      if (hold) hold.busy = false;
    }
  }

  /**
   * Lens commands one after another; a failed one is reported and ends the held move it belongs to (`key`), not a
   * move started since. Whether the command went through.
   */
  private lens(command: () => Promise<void>, what: string, key?: string, current?: () => boolean, cleanup = false): Promise<boolean> {
    const epoch = this.epoch;
    const done = this.lensQueue.then(async () => {
      if (!cleanup && (!this.isCurrent(epoch) || current?.() === false)) return false;
      if (!cleanup) {
        this.setMoving(true);
        clearTimeout(this.movingTimer);
        this.movingTimer = setTimeout(() => this.setMoving(false), this.timing.zoomStepMs);
      }
      try {
        await command();
        return true;
      } catch (error) {
        if (key && this.hold?.key === key) this.endHold(false);
        this.logger.error(`Could not ${what}:`, errorText(error));
        return false;
      }
    });
    this.lensQueue = done.then(() => undefined);
    return done;
  }

  /** Steps one after another over one session: two at once would open two sessions with the camera. */
  private step(step: MotorStep, current?: () => boolean): Promise<void> {
    const epoch = this.epoch;
    this.queue = this.queue.then(() => this.send(step, () => this.isCurrent(epoch) && current?.() !== false));
    return this.queue;
  }

  private async send(step: MotorStep, current?: () => boolean): Promise<void> {
    if (!this.canControl() || current?.() === false) return;
    try {
      const session = await this.openSession();
      // A WAN handshake may outlive the held arrow, a direction change or removal of the PTZ control.
      if (!this.canControl() || current?.() === false) return;
      this.setMoving(true);
      clearTimeout(this.movingTimer);
      this.movingTimer = setTimeout(() => this.setMoving(false), this.timing.turnMs);
      await session.move(step);
    } catch (error) {
      if (!this.canControl() || current?.() === false) return;
      // a session the camera ended is opened again at the next step
      this.closeSession();
      this.endHold();
      this.logger.error(`Could not turn the camera ${MotorStep[step].toLowerCase()}:`, errorText(error));
      return;
    }

    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.canControl()) return;
    this.idleTimer = setTimeout(() => this.closeSession(), this.timing.idleMs);
    this.idleTimer.unref?.();
  }

  private async openSession(): Promise<MissSession> {
    const epoch = this.epoch;
    const current = this.session ? await this.session.catch(() => undefined) : undefined;
    if (!this.isCurrent(epoch)) throw new Error('The Xiaomi PTZ control was stopped');
    if (current && !current.closed) return current;
    const pending = this.open((answer) => this.onAnswer(answer));
    this.session = pending;
    try {
      const opened = await pending;
      if (!this.isCurrent(epoch) || this.session !== pending) {
        opened.close();
        throw new Error('The Xiaomi PTZ control was stopped');
      }
      this.scheduleIdle();
      return opened;
    } catch (error) {
      if (this.session === pending) this.session = undefined;
      throw error;
    }
  }

  private onAnswer(answer: MotorAnswer): void {
    if (answer.ret === 0) {
      this.refusals = 0;
      return;
    }
    // at its end of travel the camera refuses every further step: said once until a step passes again
    if (this.refusals++ === 0) this.logger.warn('The camera did not take a step of its motor (at the end of its travel?):', answer.raw ?? JSON.stringify(answer));
  }

  /** Ends the held move; a zoom that keeps moving by itself is stopped. */
  private endHold(stop = true): void {
    const hold = this.hold;
    this.hold = undefined;
    if (!hold) return;
    clearInterval(hold.timer);
    if (stop) void hold.end?.();
  }

  private closeSession(): void {
    const session = this.session;
    this.session = undefined;
    // a session that could not be opened has nothing to close; its error was reported by the step that waited for it
    void session?.then((open) => open.close()).catch(() => undefined);
  }
}
