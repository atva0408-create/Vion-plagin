import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { Camera } from './camera.js';
import { cameraStreamUrl, listCameras } from './xiaomi/cameras.js';
import { LoginChallengeError, XiaomiAuthError, XiaomiCloud } from './xiaomi/cloud.js';

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
import type { XiaomiConfig } from './types.js';

const ID_PREFIX = 'xiaomi:';
/** The device list is read again this often: a camera may get another address in the network. */
const REFRESH_MS = 30 * 60_000;
/** An address older than this is read again before a connection. */
const ADDRESS_MAX_AGE_MS = 5 * 60_000;

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
  private challenges = 0;

  private cameras = new Map<string, XiaomiCamera>();
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
      this.controllers.delete(camera.nativeId);
      const xiaomi = this.cameras.get(camera.nativeId);
      if (xiaomi) await this.api.deviceManager.pushDiscoveredCameras([this.discovered(xiaomi)]);
    }
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    if (this.storage.values.passToken) await this.refreshCameras().catch((error) => this.logger.warn('Could not read the cameras of the account:', error.message));
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
        this.logger.error('Could not sign in to Mi Home with the stored sign-in:', error.message);
      }
    }
    this.refreshTimer = setInterval(() => {
      if (this.storage.values.passToken) this.refreshCameras().catch((error) => this.logger.warn('Could not read the cameras of the account:', error.message));
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  private stop(): void {
    this.started = false;
    clearInterval(this.refreshTimer);
    this.controllers.clear();
    this.cameras.clear();
  }

  /** The signed-in cloud session: from the stored token when there is none yet. */
  private async session(): Promise<XiaomiCloud> {
    if (this.cloud?.signedIn) return this.cloud;
    this.signingIn ??= (async () => {
      const { userId, passToken } = this.storage.values;
      if (!userId || !passToken) throw new XiaomiAuthError('Not signed in to Mi Home: sign in in the settings of the plugin');
      const cloud = new XiaomiCloud();
      await cloud.loginWithToken(userId, passToken);
      await this.remember(cloud);
      return cloud;
    })().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  /** A request with the session, signed in again once when Xiaomi ended it. */
  private async withSession<T>(work: (cloud: XiaomiCloud) => Promise<T>): Promise<T> {
    try {
      return await work(await this.session());
    } catch (error) {
      if (!(error instanceof XiaomiAuthError) || !this.cloud) throw error;
      this.cloud = undefined;
      return work(await this.session());
    }
  }

  private async remember(cloud: XiaomiCloud): Promise<void> {
    this.cloud = cloud;
    const { userId, passToken } = cloud.credentials();
    if (userId !== this.storage.values.userId) await this.storage.setValue('userId', userId);
    if (passToken && passToken !== this.storage.values.passToken) await this.storage.setValue('passToken', passToken);
  }

  private async refreshCameras(): Promise<void> {
    this.refreshing ??= (async () => {
      const { cameras, complete } = await this.withSession((cloud) =>
        listCameras(cloud, (region, error) => this.logger.debug(`Mi Home region ${region} not read:`, error.message)),
      );
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

  private async initializeCamera(device: CameraDevice): Promise<void> {
    const did = device.nativeId;
    if (!did || this.controllers.has(did)) return;
    const camera = new Camera(device, (nativeId) => this.streamUrl(nativeId));
    this.controllers.set(did, camera);
    try {
      await camera.initialize();
    } catch (error: any) {
      this.controllers.delete(did);
      this.logger.error(`Could not set up camera ${device.name}:`, error.message);
    }
  }

  /** The address of one connection to the camera, with keys made for it. */
  private async streamUrl(did: string): Promise<string> {
    if (!this.cameras.has(did)) {
      // a camera not read yet (the first connection after a start): its address is needed now
      await this.refreshCameras();
    } else if (Date.now() - this.camerasReadAt > ADDRESS_MAX_AGE_MS) {
      // the known address is used at once; reading all regions again can take seconds the stream does not wait for
      this.refreshCameras().catch((error) => this.logger.debug('Could not read the device list again:', error.message));
    }
    const camera = this.cameras.get(did);
    if (!camera) throw new Error(`The Mi account has no camera ${did} anymore`);
    const quality = this.storage.values.quality ?? 'default';
    return this.withSession((cloud) => cameraStreamUrl(cloud, camera, quality));
  }

  private discovered(camera: XiaomiCamera): DiscoveredCamera {
    return { id: `${ID_PREFIX}${camera.did}`, name: camera.name, manufacturer: 'Xiaomi', model: camera.model, address: camera.ip || undefined };
  }

  private notAdded(): DiscoveredCamera[] {
    const added = new Set([...this.existing.values()].map((device) => device.nativeId));
    return [...this.cameras.values()].filter((camera) => !added.has(camera.did)).map((camera) => this.discovered(camera));
  }

  /**
   * The sign-in. Xiaomi may want the characters of a picture or a code it sends first: the answer is a form with
   * that field, and its submit comes back here with the value.
   */
  private async onLogin(values: XiaomiConfig & Record<string, unknown>): Promise<FormSubmitResponse | void> {
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
        this.pending = undefined;
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
        this.pending = { cloud: waiting, username: pending?.username ?? username, kind: error.challenge.kind, field };
        return { schema: this.challengeSchema(error.challenge, field) };
      }
      this.pending = undefined;
      this.logger.error('Mi Home sign-in failed:', error.message);
      return { toast: { type: 'error', message: `Sign-in failed: ${error.message}` } };
    }

    this.pending = undefined;
    if (!cloud) return;
    await this.remember(cloud);
    if (username && username !== this.storage.values.username) await this.storage.setValue('username', username);

    try {
      await this.refreshCameras();
    } catch (error: any) {
      return { toast: { type: 'warning', message: `Signed in, but the cameras could not be read: ${error.message}` } };
    }
    return { toast: { type: 'success', message: `Signed in to Mi Home. Cameras in the account: ${this.cameras.size}` } };
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
    this.cloud = undefined;
    this.pending = undefined;
    await this.storage.setValue('passToken', '');
    await this.storage.setValue('userId', '');
    this.logger.log('Signed out of Mi Home');
  }
}
