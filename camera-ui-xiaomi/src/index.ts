import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { Camera } from './camera.js';
import { UnplayableCameraError, cameraStreamUrl, checkPlayable, listCameras, motorKeys } from './xiaomi/cameras.js';
import { LoginChallengeError, TokenRejectedError, XiaomiAuthError, XiaomiCloud } from './xiaomi/cloud.js';
import { MissSession } from './xiaomi/miss.js';
import { errorText } from './xiaomi/text.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { LoginChallenge } from './xiaomi/cloud.js';
import type { XiaomiCamera } from './xiaomi/cameras.js';
import type { MotorAnswer } from './xiaomi/miss.js';
import type { XiaomiConfig } from './types.js';

const ID_PREFIX = 'xiaomi:';
/** The field of the window that reports a finished sign-in. */
const SIGNED_IN_FIELD = 'signedIn';
/** The device list is read again this often: a camera may get another address in the network. */
const REFRESH_MS = 30 * 60_000;
/** An address older than this is read again before a connection. */
const ADDRESS_MAX_AGE_MS = 5 * 60_000;
const NOT_SIGNED_IN = 'Not signed in to Mi Home: sign in in the settings of the plugin';
/** A sign-in that waits this long for the captcha or the code is given up: its cloud session holds the password. */
const PENDING_MS = 10 * 60_000;
/** Fields of the window that carry the answer to a captcha or a code (`<kind>_<n>`, see onLogin). */
const ANSWER_FIELD = /^(captcha|verify)_\d+$/;

/** A sign-in that waits for the user: the cloud session in the middle of it, and the field the answer comes in. */
interface PendingLogin {
  cloud: XiaomiCloud;
  username: string;
  kind: LoginChallenge['kind'];
  field: string;
}

export default class XiaomiPlugin extends BasePlugin<XiaomiConfig> implements DiscoveryProvider {
  private cloud?: XiaomiCloud;
  private signingIn?: Promise<XiaomiCloud>;
  private pending?: PendingLogin;
  private pendingTimer?: NodeJS.Timeout;
  private challenges = 0;
  /** Counts Sign out: work that started before one does not bring back the account or what was read with it. */
  private signOuts = 0;
  /** Why there is no sign-in, when Xiaomi refused the stored one. */
  private refused?: string;

  private cameras = new Map<string, XiaomiCamera>();
  /** Cameras of the account ViON cannot play, by device id: they are not offered. */
  private unplayable = new Map<string, UnplayableCameraError>();
  /** Cameras the cloud connects over a vendor ViON plays: it is not asked about them again. */
  private playable = new Set<string>();
  private camerasReadAt = 0;
  private refreshing?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;

  private existing = new Map<string, CameraDevice>();
  private controllers = new Map<string, Camera>();
  private started = false;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<XiaomiConfig>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'username',
        title: 'Mi account',
        description: 'Email, phone number or Mi ID of the account your cameras are in, as in the Mi Home app.',
        store: true,
        group: 'Account',
      },
      {
        type: 'string',
        key: 'password',
        title: 'Password',
        description: 'Password of the Mi account. It is used for the sign-in only and is not stored.',
        format: 'password',
        group: 'Account',
      },
      {
        type: 'string',
        key: 'userId',
        title: 'Signed-in account',
        description: 'ID of the Mi account the plugin is signed in to. Empty until the sign-in succeeds.',
        readonly: true,
        store: true,
        group: 'Account',
      },
      {
        type: 'string',
        key: 'passToken',
        title: 'Sign-in token',
        description: 'Lets the plugin sign in again without the password.',
        format: 'password',
        hidden: true,
        store: true,
      },
      {
        type: 'submit',
        key: 'login',
        title: 'Sign in',
        description: 'Signs in to Mi Home and finds the cameras of the account.',
        onClick: this.onLogin.bind(this),
      },
      {
        type: 'button',
        key: 'logout',
        title: 'Sign out',
        description: 'Forgets the sign-in. Added cameras stay, they show no video until you sign in again.',
        color: 'danger',
        onSet: this.onLogout.bind(this),
      },
      {
        type: 'string',
        key: 'quality',
        title: 'Picture quality',
        description: 'Quality the cameras are asked for. Maximum suits newer models; on older ones it can break the picture.',
        store: true,
        defaultValue: 'default',
        enum: ['default', 'hd', 'sd', 'max'],
        enumLabels: { default: 'Standard', hd: 'High (HD)', sd: 'Low (SD)', max: 'Maximum' },
        group: 'Video',
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existing.set(camera.id, camera);
      // cameras handed over after the start get their stream now, not at the next reading of the device list
      if (this.started) await this.initializeCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existing.set(camera.id, camera);
    await this.initializeCamera(camera);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const camera = this.existing.get(cameraId);
    this.existing.delete(cameraId);
    if (camera?.nativeId) {
      this.controllers.get(camera.nativeId)?.dispose();
      this.controllers.delete(camera.nativeId);
      const xiaomi = this.cameras.get(camera.nativeId);
      if (xiaomi && !this.unplayable.has(xiaomi.did)) await this.api.deviceManager.pushDiscoveredCameras([this.discovered(xiaomi)]);
    }
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    if (this.storage.values.passToken) await this.refreshCameras().catch((error) => this.logger.warn('Could not read the cameras of the account:', errorText(error)));
    return this.notAdded();
  }

  public async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  public async onAdoptCamera(discovered: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const did = discovered.id.slice(ID_PREFIX.length);
    const camera = this.cameras.get(did);
    if (!camera) throw new Error(`Xiaomi camera ${did} not found, sign in again to read the cameras`);

    this.logger.log(`Adopted camera: ${camera.name} (${camera.model})`);

    return {
      name: camera.name,
      nativeId: camera.did,
      // the cloud only hands out the keys; the video comes over the local network
      isCloud: false,
      info: {
        manufacturer: 'Xiaomi',
        model: camera.model,
        serialNumber: camera.did,
      },
      sources: [
        {
          name: 'P2P',
          role: 'high-resolution',
          useForSnapshot: true,
          hotMode: false,
          preload: false,
        },
      ],
    };
  }

  private async start(): Promise<void> {
    this.started = true;
    // added cameras get their stream at once: the address is asked when a connection opens, not now
    for (const device of this.existing.values()) await this.initializeCamera(device);

    if (this.storage.values.userId && this.storage.values.passToken) {
      try {
        await this.refreshCameras();
      } catch (error: any) {
        this.logger.error('Could not sign in to Mi Home with the stored sign-in:', errorText(error));
      }
    }
    this.refreshTimer = setInterval(() => {
      if (this.storage.values.passToken) this.refreshCameras().catch((error) => this.logger.warn('Could not read the cameras of the account:', errorText(error)));
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  private stop(): void {
    this.started = false;
    clearInterval(this.refreshTimer);
    this.endPending();
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
    this.cameras.clear();
  }

  /** The signed-in cloud session: from the stored token when there is none yet. */
  private async session(): Promise<XiaomiCloud> {
    if (this.cloud?.signedIn) return this.cloud;
    this.signingIn ??= (async () => {
      const { userId, passToken } = this.storage.values;
      if (!userId || !passToken) throw new XiaomiAuthError(this.refused ?? NOT_SIGNED_IN);
      const signOuts = this.signOuts;
      const cloud = new XiaomiCloud();
      try {
        await cloud.loginWithToken(userId, passToken);
      } catch (error) {
        if (error instanceof TokenRejectedError) await this.dropRefusedToken(passToken);
        throw error;
      }
      // Sign out was pressed while this sign-in ran: the token it renewed must not come back into the settings
      if (signOuts !== this.signOuts) throw new XiaomiAuthError(NOT_SIGNED_IN);
      await this.remember(cloud);
      return cloud;
    })().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  /**
   * A request with the session, signed in again once when Xiaomi ended it. Callers that fail on the same ended session
   * share one renewal: dropping the session another caller has just renewed would fail them all but the first.
   */
  private async withSession<T>(work: (cloud: XiaomiCloud) => Promise<T>): Promise<T> {
    const cloud = await this.session();
    try {
      return await work(cloud);
    } catch (error) {
      if (!(error instanceof XiaomiAuthError)) throw error;
      if (this.cloud === cloud) this.cloud = undefined;
      return work(await this.session());
    }
  }

  /**
   * Xiaomi refused the stored token: it is dropped, so Xiaomi does not get it again with every connection and every
   * reading of the list, and the log says once what to do.
   */
  private async dropRefusedToken(passToken: string): Promise<void> {
    // a sign-in in the settings replaced it meanwhile
    if (this.storage.values.passToken !== passToken) return;
    this.cloud = undefined;
    this.refused = 'Xiaomi no longer accepts the stored sign-in: sign in again in the settings of the plugin';
    await this.storage.setValue('passToken', '');
    await this.storage.setValue('userId', '');
    this.logger.error('Xiaomi refused the sign-in of the plugin, as after a change of the Mi password: sign in again in the settings of the plugin');
  }

  private async remember(cloud: XiaomiCloud): Promise<void> {
    this.cloud = cloud;
    this.refused = undefined;
    const { userId, passToken } = cloud.credentials();
    if (userId !== this.storage.values.userId) await this.storage.setValue('userId', userId);
    if (passToken && passToken !== this.storage.values.passToken) await this.storage.setValue('passToken', passToken);
  }

  private async refreshCameras(): Promise<void> {
    this.refreshing ??= (async () => {
      const signOuts = this.signOuts;
      const { cameras, complete } = await this.withSession((cloud) =>
        listCameras(cloud, (region, error) => this.logger.debug(`Mi Home region ${region} not read:`, errorText(error))),
      );
      await this.checkCameras(cameras);
      // signed out while the list was read: its cameras are not offered or adopted any more
      if (signOuts !== this.signOuts) throw new XiaomiAuthError(NOT_SIGNED_IN);
      // a camera removed from the account is no longer offered; when a region could not be read, nothing is dropped
      if (complete) this.cameras.clear();
      for (const camera of cameras) this.cameras.set(camera.did, camera);
      this.camerasReadAt = Date.now();
      this.logger.debug(`Mi Home cameras: ${cameras.length}`);

      for (const device of this.existing.values()) await this.initializeCamera(device);
      const fresh = this.notAdded();
      if (fresh.length) await this.api.deviceManager.pushDiscoveredCameras(fresh);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Asks the cloud once per camera how it connects. One ViON cannot play is not offered and is named once in the log;
   * one that could not be asked is offered as before and asked again at the next reading of the list.
   */
  private async checkCameras(cameras: XiaomiCamera[]): Promise<void> {
    const unknown = cameras.filter((camera) => !this.playable.has(camera.did) && !this.unplayable.has(camera.did));
    await Promise.all(
      unknown.map(async (camera) => {
        try {
          await this.withSession((cloud) => checkPlayable(cloud, camera));
          this.playable.add(camera.did);
        } catch (error: any) {
          if (error instanceof UnplayableCameraError) {
            this.unplayable.set(camera.did, error);
            this.logger.warn(`Not offered for adding: ${error.message}`);
          } else {
            this.logger.debug(`Could not ask Mi Home how ${camera.name} connects:`, errorText(error));
          }
        }
      }),
    );
  }

  private async initializeCamera(device: CameraDevice): Promise<void> {
    const did = device.nativeId;
    if (!did || this.controllers.has(did)) return;
    const camera = new Camera(
      device,
      (nativeId) => this.streamUrl(nativeId),
      (nativeId) => (onAnswer) => this.openMotor(nativeId, onAnswer),
    );
    this.controllers.set(did, camera);
    try {
      await camera.initialize();
    } catch (error: any) {
      this.controllers.delete(did);
      this.logger.error(`Could not set up camera ${device.name}:`, errorText(error));
    }
  }

  /** The address of one connection to the camera, with keys made for it. */
  private async streamUrl(did: string): Promise<string> {
    const camera = await this.knownCamera(did);
    // said at once: the engine tries a camera again and again, and each try would ask the cloud for keys it cannot use
    const unplayable = this.unplayable.get(did);
    if (unplayable) throw unplayable;
    const quality = this.storage.values.quality ?? 'default';
    return this.withSession((cloud) =>
      cameraStreamUrl(cloud, camera, quality, undefined, (error) => this.logger.warn(`Could not wake up ${camera.name}, connecting all the same:`, errorText(error))),
    );
  }

  /** A session of the plugin's own with the camera, to turn it: the stream engine sends no motor commands. */
  private async openMotor(did: string, onAnswer: (answer: MotorAnswer) => void): Promise<MissSession> {
    const camera = await this.knownCamera(did);
    const keys = await this.withSession((cloud) => motorKeys(cloud, camera));
    return MissSession.open(camera.ip, keys, onAnswer);
  }

  /** The camera as the device list last gave it, with an address read at most ADDRESS_MAX_AGE_MS ago. */
  private async knownCamera(did: string): Promise<XiaomiCamera> {
    if (!this.cameras.has(did)) {
      // a camera not read yet (the first connection after a start): its address is needed now
      await this.refreshCameras();
    } else if (Date.now() - this.camerasReadAt > ADDRESS_MAX_AGE_MS) {
      // the known address is used at once; reading all regions again can take seconds the stream does not wait for
      this.refreshCameras().catch((error) => this.logger.debug('Could not read the device list again:', errorText(error)));
    }
    const camera = this.cameras.get(did);
    if (!camera) throw new Error(`The Mi account has no camera ${did} anymore`);
    return camera;
  }

  private discovered(camera: XiaomiCamera): DiscoveredCamera {
    return { id: `${ID_PREFIX}${camera.did}`, name: camera.name, manufacturer: 'Xiaomi', model: camera.model, address: camera.ip || undefined };
  }

  private notAdded(): DiscoveredCamera[] {
    const added = new Set([...this.existing.values()].map((device) => device.nativeId));
    return [...this.cameras.values()].filter((camera) => !added.has(camera.did) && !this.unplayable.has(camera.did)).map((camera) => this.discovered(camera));
  }

  /**
   * The sign-in. Xiaomi may want the characters of a picture or a code it sends first: the answer is a form with
   * that field, and its submit comes back here with the value.
   */
  private async onLogin(values: XiaomiConfig & Record<string, unknown>): Promise<FormSubmitResponse | void> {
    // the button of the window that reports the sign-in closes it
    if (!this.pending && values[SIGNED_IN_FIELD] !== undefined) return;
    // an answer for a sign-in that was given up: starting over here would make Xiaomi send another code unasked
    if (!this.pending && Object.keys(values).some((key) => ANSWER_FIELD.test(key))) {
      return { toast: { type: 'error', message: 'The sign-in waited too long and was cancelled. Click Sign in to start again.' } };
    }

    const pending = this.pending;
    const answer = pending ? values[pending.field] : undefined;
    const username = String(values.username ?? this.storage.values.username ?? '').trim();
    let cloud: XiaomiCloud | undefined;

    try {
      if (pending && typeof answer === 'string' && answer.trim()) {
        cloud = pending.cloud;
        if (pending.kind === 'captcha') await cloud.loginWithCaptcha(answer.trim());
        else await cloud.loginWithVerify(answer.trim());
      } else {
        this.endPending();
        const password = typeof values.password === 'string' ? values.password : '';
        if (!username || !password) return { toast: { type: 'error', message: 'Enter the Mi account and its password' } };
        cloud = new XiaomiCloud();
        await cloud.login(username, password);
      }
    } catch (error: any) {
      if (error instanceof LoginChallengeError) {
        const field = `${error.challenge.kind}_${++this.challenges}`;
        const waiting = cloud ?? pending?.cloud;
        if (!waiting) throw error;
        this.wait({ cloud: waiting, username: pending?.username ?? username, kind: error.challenge.kind, field });
        const schema = this.challengeSchema(error.challenge, field);
        // the window stays open for the code typed again; the message says why the last one did not pass
        if (error.challenge.kind === 'verify' && error.challenge.rejected) return { schema, toast: { type: 'error', message: error.message } };
        return { schema };
      }
      this.endPending();
      this.logger.error('Mi Home sign-in failed:', errorText(error));
      return { toast: { type: 'error', message: `Sign-in failed: ${errorText(error)}` } };
    }

    this.endPending();
    if (!cloud) return;
    await this.remember(cloud);
    if (username && username !== this.storage.values.username) await this.storage.setValue('username', username);

    try {
      await this.refreshCameras();
    } catch (error: any) {
      return { toast: { type: 'warning', message: `Signed in, but the cameras could not be read: ${errorText(error)}` } };
    }
    return { schema: this.signedInSchema() };
  }

  /** Keeps the sign-in waiting for the user, PENDING_MS at most: a window closed without an answer would keep it until a restart. */
  private wait(pending: PendingLogin): void {
    clearTimeout(this.pendingTimer);
    this.pending = pending;
    this.pendingTimer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.logger.warn('The sign-in to Mi Home waited too long for the captcha or the code and was cancelled');
      this.endPending();
    }, PENDING_MS);
    this.pendingTimer.unref?.();
  }

  /** Ends the waiting sign-in, and with it the password its cloud session kept for the next step. */
  private endPending(): void {
    clearTimeout(this.pendingTimer);
    this.pending?.cloud.abandon();
    this.pending = undefined;
  }

  /** What the sign-in found, and where the cameras are added: the window of the sign-in shows it at the end. */
  private signedInSchema(): JsonSchemaWithoutCallbacks[] {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const all = [...this.cameras.values()];
    const names = all
      .filter((camera) => !this.unplayable.has(camera.did))
      .map((camera) => camera.name)
      .sort(byName);
    const leftOut = all.flatMap((camera) => {
      const error = this.unplayable.get(camera.did);
      return error ? [error.message] : [];
    });
    if (!names.length && !leftOut.length) {
      return [
        {
          type: 'string',
          key: SIGNED_IN_FIELD,
          title: 'Signed in to Mi Home, no cameras found',
          description: 'This Mi account has no cameras. Check that the cameras are in this account in the Mi Home app, then sign in again.',
          readonly: true,
          defaultValue: '',
        },
      ];
    }
    const schema: JsonSchemaWithoutCallbacks[] = [
      names.length
        ? {
            type: 'string',
            key: SIGNED_IN_FIELD,
            title: 'Signed in to Mi Home',
            description: 'Cameras found are listed below. To add one, open Cameras in ViON and click it under Discovered.',
            format: 'textarea',
            readonly: true,
            defaultValue: names.join('\n'),
          }
        : {
            type: 'string',
            key: SIGNED_IN_FIELD,
            title: 'Signed in to Mi Home, no camera ViON can play',
            description: 'The cameras of this Mi account are listed below with the reason they cannot be added.',
            readonly: true,
            defaultValue: '',
          },
    ];
    if (leftOut.length) {
      schema.push({
        type: 'string',
        key: 'leftOut',
        title: 'Cameras ViON cannot play',
        description: 'Xiaomi connects these cameras over a protocol ViON does not support yet. They are not offered for adding.',
        format: 'textarea',
        readonly: true,
        defaultValue: leftOut.sort(byName).join('\n'),
      });
    }
    return schema;
  }

  private challengeSchema(challenge: LoginChallenge, field: string): JsonSchemaWithoutCallbacks[] {
    if (challenge.kind === 'captcha') {
      return [
        {
          type: 'string',
          key: `${field}_image`,
          title: 'Picture',
          description: 'Xiaomi wants to make sure a person signs in.',
          format: 'image',
          readonly: true,
          defaultValue: challenge.image,
        },
        {
          type: 'string',
          key: field,
          title: 'Characters from the picture',
          description: 'Type the characters you see, then confirm.',
          required: true,
        },
      ];
    }
    return [
      {
        type: 'string',
        key: field,
        title: 'Confirmation code',
        description: 'Xiaomi sent a code to the phone or the mailbox of the account. Enter it, then confirm.',
        placeholder: [challenge.phone, challenge.email].filter(Boolean).join(', ') || undefined,
        required: true,
      },
    ];
  }

  private async onLogout(): Promise<void> {
    this.signOuts++;
    this.cloud = undefined;
    this.endPending();
    this.refused = undefined;
    // the cameras read with the account are not offered or adopted after it was left
    this.cameras.clear();
    this.camerasReadAt = 0;
    await this.storage.setValue('passToken', '');
    await this.storage.setValue('userId', '');
    this.logger.log('Signed out of Mi Home');
  }
}
