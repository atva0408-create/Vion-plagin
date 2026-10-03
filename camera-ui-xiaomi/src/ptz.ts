import { PTZCapability, PTZControl } from '@camera.ui/sdk';

import { MotorStep } from './xiaomi/miss.js';
import { errorText } from './xiaomi/text.js';

import type { LoggerService, PTZDirection, PTZPosition, PTZRelativeMove } from '@camera.ui/sdk';
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
}

/** The direction of a move, the larger axis winning: the motor steps along one axis at a time. */
export function stepOf(pan: number, tilt: number): MotorStep | undefined {
  if (pan === 0 && tilt === 0) return undefined;
  if (Math.abs(pan) >= Math.abs(tilt)) return pan > 0 ? MotorStep.Right : MotorStep.Left;
  return tilt > 0 ? MotorStep.Up : MotorStep.Down;
}

/**
 * Pan and tilt of a Xiaomi camera. The stream engine has no motor command, so the plugin opens a P2P session of its
 * own with the camera, the way the Mi Home app turns it, and keeps it while the camera is being moved.
 */
export class XiaomiPtz extends PTZControl {
  private session?: Promise<MissSession>;
  private queue: Promise<void> = Promise.resolve();
  private hold?: { step: MotorStep; until: number; timer: NodeJS.Timeout };
  private idleTimer?: NodeJS.Timeout;
  private movingTimer?: NodeJS.Timeout;
  private refusals = 0;
  private readonly timing: PtzTiming;

  constructor(
    private readonly open: OpenSession,
    private readonly logger: LoggerService,
    timing: Partial<PtzTiming> = {},
  ) {
    super('Xiaomi PTZ');
    this.capabilities = [PTZCapability.Pan, PTZCapability.Tilt, PTZCapability.RelativeMove, PTZCapability.VelocityControl];
    this.timing = { stepMs: STEP_INTERVAL_MS, holdMs: HOLD_LIMIT_MS, idleMs: IDLE_MS, turnMs: STEP_TURN_MS, ...timing };
  }

  /**
   * Held direction: steps until the stop (all speeds 0) or `holdMs`. The player sends the held direction again and
   * again while it is held: that only keeps the hold going, it does not step faster.
   */
  public override async setVelocity(value: PTZDirection | undefined): Promise<void> {
    if (!value) return;
    const step = stepOf(value.panSpeed, value.tiltSpeed);
    if (step !== undefined && this.hold?.step === step) {
      this.hold.until = Date.now() + this.timing.holdMs;
    } else {
      this.endHold();
      if (step !== undefined) {
        const timer = setInterval(() => {
          if (this.hold && Date.now() < this.hold.until) void this.step(step);
          else this.endHold();
        }, this.timing.stepMs);
        this.hold = { step, until: Date.now() + this.timing.holdMs, timer };
        await this.step(step);
      }
    }
    await super.setVelocity(value);
  }

  /** One step in the direction of the move: the camera has no finer or measured moves. */
  public override async setRelativeMove(value: PTZRelativeMove): Promise<void> {
    const step = stepOf(value.panDelta, value.tiltDelta);
    if (step !== undefined) await this.step(step);
    await super.setRelativeMove(value);
  }

  public override async setPosition(_value: PTZPosition): Promise<void> {}

  /** Ends what is running: the held direction and the session. */
  public dispose(): void {
    this.endHold();
    clearTimeout(this.idleTimer);
    clearTimeout(this.movingTimer);
    this.closeSession();
  }

  protected override onStop(): void {
    this.dispose();
  }

  /** Steps one after another over one session: two at once would open two sessions with the camera. */
  private step(step: MotorStep): Promise<void> {
    this.queue = this.queue.then(() => this.send(step));
    return this.queue;
  }

  private async send(step: MotorStep): Promise<void> {
    this.setMoving(true);
    clearTimeout(this.movingTimer);
    // the motor, not the pace of the steps: with steps closer than a turn the camera would count as still between them
    this.movingTimer = setTimeout(() => this.setMoving(false), this.timing.turnMs);

    try {
      const session = await this.openSession();
      await session.move(step);
    } catch (error) {
      // a session the camera ended is opened again at the next step
      this.closeSession();
      this.endHold();
      this.logger.error(`Could not turn the camera ${MotorStep[step].toLowerCase()}:`, errorText(error));
      return;
    }

    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeSession(), this.timing.idleMs);
    this.idleTimer.unref?.();
  }

  private async openSession(): Promise<MissSession> {
    const current = this.session ? await this.session.catch(() => undefined) : undefined;
    if (current && !current.closed) return current;
    this.session = this.open((answer) => this.onAnswer(answer));
    try {
      return await this.session;
    } catch (error) {
      this.session = undefined;
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

  private endHold(): void {
    if (this.hold) clearInterval(this.hold.timer);
    this.hold = undefined;
  }

  private closeSession(): void {
    const session = this.session;
    this.session = undefined;
    // a session that could not be opened has nothing to close; its error was reported by the step that waited for it
    void session?.then((open) => open.close()).catch(() => undefined);
  }
}
