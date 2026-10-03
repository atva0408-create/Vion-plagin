import { API_EVENT, BasePlugin, SwitchProperty } from '@camera.ui/sdk';
import QRCode from 'qrcode';

import { Camera } from './camera.js';
import { extraSchema } from './extras.js';
import { SCENARIO_DEVICE, scenarioSlot, slotFromRecord, slotsOf, splitNativeId } from './mapping.js';
import { SCENARIO_RESET_MS, applyDevice, commandFor, createSensor } from './sensors.js';
import { StationVoice } from './voice.js';
import { YandexAuthError, errorText } from './yandex/http.js';
import { isCamera, isStation, mergeDevice } from './yandex/home.js';
import { AuthorizationPending, YandexIot, exchangeDeviceCode, refreshOAuthToken, requestDeviceCode, tokenPageUrl } from './yandex/iot.js';
import { QuasarUpdates, YandexQuasar } from './yandex/quasar.js';
import { YandexSession } from './yandex/session.js';

import type {
  AdoptedSensor,
  AssistantToolContext,
  AssistantToolProvider,
  AssistantToolResult,
  AssistantToolSpec,
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveredSensor,
  DiscoveryProvider,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  Notification,
  NotifierDevice,
  NotifierInterface,
  PluginAPI,
  Sensor,
  SensorDiscoveryProvider,
} from '@camera.ui/sdk';
import type { Slot } from './mapping.js';
import type { Bound, YandexSwitch } from './sensors.js';
import type { Source, YandexConfig } from './types.js';
import type { YDevice, YScenario } from './yandex/home.js';
import type { DeviceCode, OAuthTokens, YAction } from './yandex/iot.js';

const CAMERA_PREFIX = 'yandex:';
const STATION_PREFIX = 'station:';
const DONE_FIELD = 'done';
const DEFAULT_POLL_SECONDS = 10;
const MIN_POLL_SECONDS = 3;
/** The devices of the app are read again this often for the voice when the official API reads the rest. */
const APP_LIST_MS = 10 * 60_000;
/** A token of Yandex ID is renewed this long before it ends. */
const TOKEN_MARGIN_MS = 24 * 60 * 60_000;
/** A renewal that failed on the way (not refused) is tried again after this, not at every reading. */
const RENEW_RETRY_MS = 60 * 60_000;
/** Scenarios that could not be read in the app mode are read again after this: until then their switches are unavailable. */
const SCENARIO_RETRY_MS = 60_000;
/** How long the window of the QR code waits for the confirmation after its button is pressed. */
const QR_WAIT_MS = 20_000;
const QR_POLL_MS = 2_000;
const NOT_SIGNED_IN = 'Not signed in to Yandex: sign in in the settings of the plugin';
const SIGNED_OUT = 'Signed out of Yandex while this sign-in ran: sign in again';
/**
 * The owner of a station for everyone but a notification on its way: a station belongs to the house, not to a user
 * of ViON, so no user matches it and only an admin may turn it on or rename it.
 */
const HOUSEHOLD = '';

type ReadSource = 'official' | 'app';

export default class YandexPlugin extends BasePlugin<YandexConfig> implements SensorDiscoveryProvider, NotifierInterface, DiscoveryProvider, AssistantToolProvider {
  private session?: YandexSession;
  private quasar?: YandexQuasar;
  private iot?: YandexIot;
  private updates?: QuasarUpdates;
  private pollTimer?: NodeJS.Timeout;
  private reading?: Promise<void>;
  /** The last reading succeeded: only a reading right after a good one is live, see applyDevice. */
  private readOk = false;
  private renewing?: Promise<string>;
  private renewFailedAt = 0;
  private started = false;
  /** Counts Sign out: work that started before one does not bring back the account or what was read with it. */
  private signOuts = 0;
  /** Sign-ins being dropped because Yandex refused them: another failure meanwhile is the same news, see dropRefused. */
  private dropping = new Set<ReadSource>();
  /** The live updates could not read the Smart Home, and the log said so: it is said again after they worked. */
  private updatesDown = false;

  private devices = new Map<string, YDevice>();
  private scenarioList: YScenario[] = [];
  private complete = false;
  /** The list of the scenarios is known: a scenario missing from it was removed, not just unread. */
  private scenariosRead = false;
  private readingScenarios?: Promise<void>;
  private scenarioTimer?: NodeJS.Timeout;
  private appDevices?: { at: number; devices: YDevice[] };
  /** The ids of the cameras last offered for adding: the same set is not offered again at every reading. */
  private offeredCameras?: string;

  private bound = new Map<string, Bound>();
  private existing = new Map<string, CameraDevice>();
  private cameras = new Map<string, Camera>();

  private deviceCode?: DeviceCode;
  /** The QR sign-in waiting for the confirmation in the app; the running session stays until it ends. */
  private qrSession?: YandexSession;
  /** The x_token the plugin stored itself: storing it calls the hook of the field, which must not sign in again. */
  private storedXToken?: string;
  private voice = new StationVoice(
    () => this.quasar,
    () => ({ mode: this.storage.values.voiceMode ?? 'auto', hosts: this.storage.values.stationHosts }),
    (message, error) => this.logger.debug(message, error === undefined ? '' : errorText(error)),
  );

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<YandexConfig>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'clientId',
        title: 'App ID',
        description: 'ClientID of your app in Yandex ID with the rights iot:view and iot:control. The official API of the Smart Home works with it.',
        store: true,
        group: 'Official API',
      },
      {
        type: 'string',
        key: 'clientSecret',
        title: 'App secret',
        description: 'Client secret of the same app. With it the sign-in is a code entered on ya.ru/device; without it you paste the token.',
        format: 'password',
        store: true,
        group: 'Official API',
      },
      {
        type: 'string',
        key: 'oauthToken',
        title: 'Smart Home token',
        description: 'Filled in by the sign-in. You can also paste a token of Yandex ID with the rights iot:view and iot:control here.',
        format: 'password',
        store: true,
        group: 'Official API',
        onSet: async () => this.restartSoon(),
      },
      {
        type: 'submit',
        key: 'officialLogin',
        title: 'Sign in with Yandex ID',
        description: 'Gives ViON access to the devices and scenarios of your Smart Home through the official API.',
        onClick: this.onOfficialLogin.bind(this),
        group: 'Official API',
      },
      {
        type: 'string',
        key: 'account',
        title: 'Signed-in account',
        description: 'Account of the sign-in as the Yandex app. Empty until it succeeds.',
        readonly: true,
        store: true,
        group: 'Yandex app',
      },
      {
        type: 'submit',
        key: 'qrLogin',
        title: 'Sign in with QR code',
        description: 'Scan the code with the Yandex app and confirm. Needed for speech on the stations and live updates of the sensors.',
        onClick: this.onQrLogin.bind(this),
        group: 'Yandex app',
      },
      {
        type: 'string',
        key: 'xToken',
        title: 'x_token',
        description: 'Instead of the QR code: an x_token of the Yandex account, if you have one.',
        format: 'password',
        store: true,
        group: 'Yandex app',
        onSet: async (value: unknown) => this.onXToken(value),
      },
      {
        type: 'string',
        key: 'cookies',
        title: 'Session',
        description: 'Cookies of the sign-in as the Yandex app.',
        format: 'password',
        hidden: true,
        store: true,
      },
      {
        type: 'string',
        key: 'stationToken',
        title: 'Station token',
        description: 'Token for the local connection to the stations.',
        format: 'password',
        hidden: true,
        store: true,
      },
      {
        type: 'button',
        key: 'logout',
        title: 'Sign out',
        description: 'Forgets every sign-in of the plugin. Adopted sensors and cameras stay and wait for a new sign-in.',
        color: 'danger',
        onSet: this.onLogout.bind(this),
        group: 'Yandex app',
      },
      {
        type: 'string',
        key: 'source',
        title: 'Read devices through',
        description:
          'Automatic takes the official API when its token is there, the Yandex app otherwise. The app reports changes at once, the official API is read at intervals.',
        store: true,
        defaultValue: 'auto',
        enum: ['auto', 'official', 'app'],
        enumLabels: { auto: 'Automatic', official: 'Official API', app: 'Yandex app' },
        group: 'Devices',
        onSet: async () => this.restartSoon(),
      },
      {
        type: 'number',
        key: 'pollSeconds',
        title: 'Reading interval, seconds',
        description: 'How often the official API is read. It has no push, so a sensor changes in ViON at most this much later.',
        store: true,
        defaultValue: DEFAULT_POLL_SECONDS,
        minimum: MIN_POLL_SECONDS,
        maximum: 300,
        group: 'Devices',
        onSet: async () => this.restartSoon(),
      },
      {
        type: 'boolean',
        key: 'scenarios',
        title: 'Offer scenarios',
        description: 'Scenarios of the Smart Home are offered as switches: turning one on runs the scenario, also from automations of ViON.',
        store: true,
        defaultValue: true,
        group: 'Devices',
      },
      {
        type: 'string',
        key: 'voiceMode',
        title: 'Speech on the stations',
        description:
          'Local: straight to the station in the home network, any length. Cloud: through a scenario of the account, up to 100 characters, works anywhere. ' +
          'Automatic tries local first.',
        store: true,
        defaultValue: 'auto',
        enum: ['auto', 'local', 'cloud'],
        enumLabels: { auto: 'Automatic', local: 'Local', cloud: 'Cloud' },
        group: 'Stations',
      },
      {
        type: 'string',
        key: 'stationHosts',
        title: 'Station addresses',
        description: 'Only if a station is not found in the network: one per line, as Kitchen = 192.168.1.20.',
        format: 'textarea',
        store: true,
        group: 'Stations',
      },
      {
        type: 'submit',
        key: 'speak',
        title: 'Say on a station',
        description: 'Checks the speech: pick a station and a phrase.',
        onClick: this.onSpeak.bind(this),
        group: 'Stations',
      },
      {
        type: 'boolean',
        key: 'debug',
        title: 'Debug',
        description: 'Enable debug mode',
        store: true,
        defaultValue: false,
      },
    ];
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  private async start(): Promise<void> {
    this.started = true;
    for (const device of this.existing.values()) await this.initializeCamera(device);
    this.connect();
  }

  private stop(): void {
    this.started = false;
    this.disconnect();
    this.cameras.clear();
  }

  private connect(): void {
    const values = this.storage.values;
    this.storedXToken = values.xToken;
    if (values.xToken) {
      this.session = new YandexSession({ xToken: values.xToken, cookies: values.cookies, musicToken: values.stationToken });
      this.quasar = new YandexQuasar(this.session);
    }
    if (values.oauthToken) this.iot = new YandexIot(() => this.oauthToken());

    const source = this.readSource();
    if (!source) {
      this.logger.warn(NOT_SIGNED_IN);
      return;
    }
    this.logger.log(`Reading the Smart Home through the ${source === 'app' ? 'Yandex app' : 'official API'}`);
    if (source === 'app' && this.quasar) {
      this.updates = new QuasarUpdates(
        this.quasar,
        {
          // the list read at an opening of the socket is not live: a press made while it was closed is not a new one
          devices: (devices) => this.onAppDevices(devices),
          update: (update) => this.applyUpdate(update),
          scenarios: () => void this.readScenarios(),
          lost: (error) => this.onUpdatesLost(error),
        },
        (message, error) => this.logger.debug(message, error === undefined ? '' : errorText(error)),
      );
      this.updates.start();
    } else {
      void this.read();
      const seconds = Math.max(MIN_POLL_SECONDS, Number(this.storage.values.pollSeconds) || DEFAULT_POLL_SECONDS);
      this.pollTimer = setInterval(() => void this.read(), seconds * 1000);
      this.pollTimer.unref?.();
    }
  }

  private disconnect(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    clearTimeout(this.scenarioTimer);
    this.updates?.stop();
    this.updates = undefined;
    this.voice.close();
    this.session = undefined;
    this.quasar = undefined;
    this.iot = undefined;
    this.appDevices = undefined;
    this.readOk = false;
    this.updatesDown = false;
  }

  private restartTimer?: NodeJS.Timeout;
  private restartSoon(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.started) return;
      this.disconnect();
      this.connect();
    }, 500);
  }

  private readSource(): ReadSource | undefined {
    const wanted: Source = this.storage.values.source ?? 'auto';
    if (wanted === 'official') return this.iot ? 'official' : undefined;
    if (wanted === 'app') return this.quasar ? 'app' : undefined;
    if (this.iot) return 'official';
    return this.quasar ? 'app' : undefined;
  }

  /** The token of the official API; renewed with the refresh token before it ends. */
  private async oauthToken(): Promise<string> {
    const { oauthToken, refreshToken, tokenExpiresAt, clientId, clientSecret } = this.storage.values;
    if (!oauthToken) throw new YandexAuthError('No token of the official API');
    if (!refreshToken || !clientId || !clientSecret || !tokenExpiresAt || tokenExpiresAt - Date.now() > TOKEN_MARGIN_MS) return oauthToken;
    // the token works until it ends: a renewal that failed is not tried at every reading
    if (Date.now() - this.renewFailedAt < RENEW_RETRY_MS) return oauthToken;
    const signOuts = this.signOuts;
    this.renewing ??= (async () => {
      let tokens: OAuthTokens;
      try {
        tokens = await refreshOAuthToken(clientId, clientSecret, refreshToken);
      } catch (error) {
        if (signOuts !== this.signOuts) throw new YandexAuthError(NOT_SIGNED_IN);
        if (error instanceof YandexAuthError) {
          // Yandex ID refused the refresh token: asking again gets the same answer, the token works until it ends
          await this.storage.setInternalValue('refreshToken', '');
          this.logger.warn('Yandex ID no longer renews the token of the official API: it works until it ends, then sign in again:', errorText(error));
        } else {
          this.renewFailedAt = Date.now();
          this.logger.warn('Could not renew the token of the official API, trying again in an hour:', errorText(error));
        }
        return oauthToken;
      }
      // Sign out was pressed while Yandex ID answered: the new token must not bring the sign-in back
      if (signOuts !== this.signOuts) throw new YandexAuthError(NOT_SIGNED_IN);
      await this.storage.setValue('oauthToken', tokens.accessToken);
      if (tokens.refreshToken) await this.storage.setInternalValue('refreshToken', tokens.refreshToken);
      await this.storage.setInternalValue('tokenExpiresAt', tokens.expiresAt ?? 0);
      return tokens.accessToken;
    })().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /**
   * Yandex refused a stored sign-in: it is dropped, so Yandex does not get it again at every reading, and the log says
   * once what to do. The other sign-in, when there is one, takes over after the restart.
   */
  private async dropRefused(kind: ReadSource, token: string | undefined, error: unknown): Promise<void> {
    const values = this.storage.values;
    // a sign-in in the settings replaced the refused token meanwhile, or another failure is dropping it right now
    if (!token || token !== (kind === 'app' ? values.xToken : values.oauthToken) || this.dropping.has(kind)) return;
    this.dropping.add(kind);
    try {
      // the sensors read through the other sign-in stay as they are
      if (kind === this.readSource()) {
        clearInterval(this.pollTimer);
        this.markUnavailable();
      }
      if (kind === 'app') {
        this.logger.error('Yandex no longer accepts the sign-in as the Yandex app: sign in again by QR code or x_token in the settings of the plugin:', errorText(error));
        this.storedXToken = undefined;
        for (const key of ['xToken', 'cookies', 'stationToken', 'account'] as const) await this.storage.setValue(key, '');
      } else {
        this.logger.error('Yandex no longer accepts the token of the official API: sign in again in the settings of the plugin:', errorText(error));
        await this.storage.setValue('oauthToken', '');
        await this.storage.setInternalValue('refreshToken', '');
        await this.storage.setInternalValue('tokenExpiresAt', 0);
      }
    } finally {
      this.dropping.delete(kind);
    }
    this.restartSoon();
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  private async read(): Promise<void> {
    this.reading ??= (async () => {
      const source = this.readSource();
      const { iot, quasar, session } = this;
      const signOuts = this.signOuts;
      const token = source === 'official' ? this.storage.values.oauthToken : session?.xToken;
      // after a failed reading a change seen now may have happened any time during the outage
      const live = this.readOk;
      try {
        let home: { devices: YDevice[]; scenarios: YScenario[] };
        if (source === 'official' && iot) home = await iot.home();
        else if (source === 'app' && quasar) home = { devices: (await quasar.devices()).devices, scenarios: await quasar.scenarios() };
        else return;
        // signed out or restarted while Yandex answered: what was read belongs to a sign-in that is gone
        if (signOuts !== this.signOuts || iot !== this.iot || quasar !== this.quasar) return;
        this.readOk = true;
        await this.applyList(home.devices, home.scenarios, live);
      } catch (error: any) {
        if (signOuts !== this.signOuts || iot !== this.iot || quasar !== this.quasar) {
          this.logger.debug('A reading of the Smart Home ended after a sign-out or restart:', errorText(error));
          return;
        }
        this.readOk = false;
        this.markUnavailable();
        if (error instanceof YandexAuthError && source) await this.dropRefused(source, token, error);
        else this.logger.warn('Could not read the Smart Home:', errorText(error));
      }
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** The scenarios in the app mode: read at every opening of the live updates and when Yandex says they changed. */
  private async readScenarios(): Promise<void> {
    const quasar = this.quasar;
    if (!quasar) return;
    this.readingScenarios ??= (async () => {
      clearTimeout(this.scenarioTimer);
      try {
        const scenarios = await quasar.scenarios();
        if (quasar !== this.quasar) return;
        this.scenarioList = scenarios;
        this.scenariosRead = true;
      } catch (error: any) {
        if (quasar !== this.quasar) return;
        this.logger.warn('Could not read the scenarios of the Smart Home, trying again in a minute:', errorText(error));
        this.scenarioTimer = setTimeout(() => void this.readScenarios(), SCENARIO_RETRY_MS);
        this.scenarioTimer.unref?.();
      }
      this.applyScenarios();
    })().finally(() => {
      this.readingScenarios = undefined;
    });
    return this.readingScenarios;
  }

  private onAppDevices(devices: YDevice[]): void {
    if (this.updatesDown) this.logger.log('The Smart Home answers again');
    this.updatesDown = false;
    void this.applyList(devices, undefined, false);
  }

  /** The live updates lost the state: the sensors show it until the list is read again. */
  private onUpdatesLost(error?: unknown): void {
    this.markUnavailable();
    if (error === undefined) {
      this.logger.debug('The live updates of the Smart Home closed, reading the devices again');
    } else if (error instanceof YandexAuthError) {
      void this.dropRefused('app', this.session?.xToken, error);
    } else {
      // said once per outage: the updates try again every 30 seconds
      if (!this.updatesDown) this.logger.warn('Could not read the Smart Home through the Yandex app, trying again every 30 seconds:', errorText(error));
      this.updatesDown = true;
    }
  }

  private async applyList(devices: YDevice[], scenarios: YScenario[] | undefined, live: boolean): Promise<void> {
    this.devices = new Map(devices.map((device) => [device.id, device]));
    this.complete = true;
    if (scenarios) {
      this.scenarioList = scenarios;
      this.scenariosRead = true;
    }
    if (this.readSource() === 'app') this.appDevices = { at: Date.now(), devices };

    for (const bound of this.bound.values()) {
      if (bound.slot.deviceId === SCENARIO_DEVICE) continue;
      const device = this.devices.get(bound.slot.deviceId);
      if (!device) {
        bound.sensor.setSourceState('removed');
        continue;
      }
      this.applyBound(bound, device, live);
    }
    this.applyScenarios();
    if (this.storage.values.debug) this.logger.log(`Smart Home: ${devices.length} devices, ${this.scenarioList.length} scenarios`);
    await this.offerCameras();
  }

  /** Cameras not added yet are offered when they change, not at every reading: ViON logs each offer. */
  private async offerCameras(): Promise<void> {
    const fresh = this.notAddedCameras();
    const ids = fresh
      .map((camera) => camera.id)
      .sort()
      .join('\n');
    if (ids === this.offeredCameras) return;
    if (!fresh.length) {
      this.offeredCameras = ids;
      return;
    }
    try {
      await this.api.deviceManager.pushDiscoveredCameras(fresh);
      this.offeredCameras = ids;
    } catch (error: any) {
      // not remembered: the next reading offers them again
      this.logger.warn('Could not offer the cameras of the Smart Home for adding:', errorText(error));
    }
  }

  private applyUpdate(update: any): void {
    const known = this.devices.get(String(update?.id));
    if (!known) return;
    const device = mergeDevice(known, update);
    this.devices.set(device.id, device);
    for (const bound of this.bound.values()) {
      if (bound.slot.deviceId === device.id) this.applyBound(bound, device, true);
    }
  }

  private applyBound(bound: Bound, device: YDevice, live: boolean): void {
    if (!device.online) {
      bound.sensor.setSourceState('unavailable');
      return;
    }
    applyDevice(bound, device, live);
    const b = bound.slot.binding;
    if (b.kind === 'onoff' || b.kind === 'panel') {
      const light = b.kind === 'onoff' && b.light;
      (bound.sensor as YandexSwitch).setExtras(extraSchema(device, light, (action, readBack) => this.extraCommand(bound, action, readBack)));
    }
    bound.sensor.setSourceState('connected');
  }

  /** A field of the extra controls was set (extras.ts): the command goes to the device at once. */
  private async extraCommand(bound: Bound, action: YAction, readBack: boolean): Promise<void> {
    const sensor = bound.sensor as YandexSwitch;
    try {
      await this.commandApi().action(bound.slot.deviceId, [action]);
      // an IR remote is never read back: the field shows nothing again, so the same choice can be sent again
      if (!readBack) sensor.resetExtras();
    } catch (error: any) {
      // the settings show what the device has, not the value it refused; said here, once
      this.logger.error(`Command for ${bound.slot.name} failed:`, errorText(error));
      sensor.resetExtras();
    }
  }

  private applyScenarios(): void {
    const ids = new Set(this.scenarioList.map((s) => s.id));
    for (const bound of this.bound.values()) {
      if (bound.slot.binding.kind !== 'scenario') continue;
      bound.sensor.setSourceState(ids.has(bound.slot.binding.scenarioId) ? 'connected' : this.scenariosRead ? 'removed' : 'unavailable');
    }
  }

  private markUnavailable(): void {
    for (const bound of this.bound.values()) bound.sensor.setSourceState('unavailable');
  }

  /** The API commands and scenarios go through: the one the devices are read from. */
  private commandApi(): YandexIot | YandexQuasar {
    const source = this.readSource();
    const api = source === 'official' ? this.iot : source === 'app' ? this.quasar : undefined;
    if (!api) throw new YandexAuthError(NOT_SIGNED_IN);
    return api;
  }

  // ---- sensors -----------------------------------------------------------------------------------------------------

  async onDiscoverSensors(): Promise<DiscoveredSensor[]> {
    if (!this.complete) await this.read();
    const result: DiscoveredSensor[] = [];
    for (const device of this.devices.values()) {
      for (const slot of slotsOf(device)) result.push(this.discoveredSensor(slot, device));
    }
    if (this.storage.values.scenarios !== false) {
      for (const scenario of this.scenarioList) result.push(this.discoveredSensor(scenarioSlot(scenario)));
    }
    return result;
  }

  private discoveredSensor(slot: Slot, device?: YDevice): DiscoveredSensor {
    return {
      id: slot.nativeId,
      address: slot.deviceId,
      name: slot.name,
      type: slot.type,
      room: slot.room,
      manufacturer: 'Yandex',
      model: device?.type.replace('devices.types.', ''),
    };
  }

  async configureAdoptedSensors(records: AdoptedSensor[]): Promise<Sensor<any, any, any>[]> {
    const sensors: Sensor<any, any, any>[] = [];
    for (const record of records) {
      const bound = this.bind(record);
      if (bound) sensors.push(bound.sensor);
    }
    return sensors;
  }

  async onSensorAdopted(record: AdoptedSensor): Promise<Sensor<any, any, any>> {
    const bound = this.bind(record);
    if (!bound) throw new Error(`No sensor type for "${record.name}" (${record.type})`);
    return bound.sensor;
  }

  async onSensorUnadopted(nativeId: string): Promise<void> {
    const bound = this.bound.get(nativeId);
    if (bound) clearTimeout(bound.pulseTimer);
    this.bound.delete(nativeId);
  }

  private bind(record: AdoptedSensor): Bound | undefined {
    const device = this.devices.get(splitNativeId(record.nativeId).deviceId);
    const slot = (device ? slotsOf(device).find((s) => s.nativeId === record.nativeId) : undefined) ?? slotFromRecord(record.nativeId, record.name, record.type);
    if (!slot) {
      this.logger.warn(`No sensor type for adopted "${record.name}" (${record.type}), it stays disconnected`);
      return undefined;
    }
    const named = { ...slot, name: record.name };
    const bound: Bound = { slot: named, sensor: createSensor(named, (property, value) => this.command(bound, property, value)) };
    bound.sensor.setSourceState('unavailable');
    this.bound.set(record.nativeId, bound);
    if (device) this.applyBound(bound, device, false);
    else if (slot.binding.kind === 'scenario') this.applyScenarios();
    return bound;
  }

  /** A write to a control, sent to Yandex. A failure reaches the caller, so an automation sees the step failed. */
  private async command(bound: Bound, property: string, value: unknown): Promise<void> {
    const slot = bound.slot;
    try {
      if (slot.binding.kind === 'scenario') {
        if (property !== String(SwitchProperty.On) || !value) return;
        await this.commandApi().runScenario(slot.binding.scenarioId);
        const sensor = bound.sensor as YandexSwitch;
        setTimeout(() => sensor.write({ [SwitchProperty.On]: false }), SCENARIO_RESET_MS).unref?.();
        return;
      }
      // a panel has nothing to turn on: its controls are its settings
      if (slot.binding.kind === 'panel') {
        (bound.sensor as YandexSwitch).write({ [SwitchProperty.On]: false });
        return;
      }
      const action = commandFor(slot, property, value);
      if (!action) return;
      // brightness above zero turns the light on in the Smart Home as well (zero is the command to turn it off)
      const actions = action.type === 'devices.capabilities.range' ? [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }, action] : [action];
      await this.commandApi().action(slot.deviceId, actions);
    } catch (error: any) {
      this.logger.error(`Command for ${slot.name} failed:`, errorText(error));
      // the state the sensor shows goes back to what the device reports; a scenario that did not run is off
      if (slot.binding.kind === 'scenario') {
        (bound.sensor as YandexSwitch).write({ [SwitchProperty.On]: false });
      } else {
        const device = this.devices.get(slot.deviceId);
        if (device) applyDevice(bound, device, false);
      }
      throw error;
    }
  }

  // ---- stations: speech as a notifier ---------------------------------------------------------------------------

  /**
   * Stations with what the voice needs, from the app. Without the sign-in as the app there are none: a station can
   * speak only through it, and one offered as a target would fail every notification chosen for it.
   */
  private async stations(): Promise<YDevice[]> {
    const { quasar, session } = this;
    if (!quasar) return [];
    if (this.readSource() === 'app' && this.complete) return [...this.devices.values()].filter(isStation);
    if (!this.appDevices || Date.now() - this.appDevices.at > APP_LIST_MS) {
      try {
        const { devices } = await quasar.devices();
        // signed out or restarted while Yandex answered: the list belongs to a sign-in that is gone
        if (quasar !== this.quasar) return [];
        this.appDevices = { at: Date.now(), devices };
      } catch (error: any) {
        if (quasar !== this.quasar) return [];
        if (error instanceof YandexAuthError) {
          await this.dropRefused('app', session?.xToken, error);
          return [];
        }
        this.logger.warn('Could not read the stations:', errorText(error));
        if (!this.appDevices) return [];
      }
    }
    return this.appDevices.devices.filter(isStation);
  }

  private async findStation(name?: string): Promise<YDevice> {
    if (!this.quasar) throw new Error('The stations speak after the sign-in by QR code or x_token in the settings of the plugin');
    const stations = await this.stations();
    if (!stations.length) throw new Error('No Yandex station in the account');
    if (!name) return stations[0];
    const wanted = name.trim().toLowerCase();
    const found =
      stations.find((s) => s.id === name || s.quasar?.deviceId === name) ??
      stations.find((s) => s.name.toLowerCase() === wanted || this.stationName(s).toLowerCase() === wanted) ??
      stations.find((s) => s.name.toLowerCase().includes(wanted) || (s.room ?? '').toLowerCase().includes(wanted));
    if (!found) throw new Error(`No station "${name}"; the stations are: ${stations.map((s) => s.name).join(', ')}`);
    return found;
  }

  private stationName(station: YDevice): string {
    return this.storage.values.stationNames?.[station.id] ?? (station.room ? `${station.name} (${station.room})` : station.name);
  }

  /** A station speaks notifications only once the user turned it on: otherwise a sign-in makes every one speak them all. */
  private speaks(id: string): boolean {
    return (this.storage.values.speakingStations ?? []).includes(id);
  }

  private toNotifierDevice(station: YDevice, owner: string): NotifierDevice {
    return {
      id: `${STATION_PREFIX}${station.id}`,
      ownerUserId: owner,
      name: this.stationName(station),
      active: this.speaks(station.id),
      metadata: { type: station.type },
    };
  }

  async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    // the fan-out of a notification delivers only to devices of the users it names, so here a station counts as the
    // first one's; who may change a station is asked through getDevice, which names no user
    const owner = ownerUserIds[0] ?? HOUSEHOLD;
    return (await this.stations()).map((station) => this.toNotifierDevice(station, owner));
  }

  async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    if (!deviceId.startsWith(STATION_PREFIX)) return null;
    const station = (await this.stations()).find((s) => s.id === deviceId.slice(STATION_PREFIX.length));
    return station ? this.toNotifierDevice(station, HOUSEHOLD) : null;
  }

  /** A notification is said aloud: its title, then its text. */
  async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    if (n.silent) return;
    const text = [n.title, n.subtitle, n.body]
      .filter(Boolean)
      .map((part) => String(part).replace(/[.!?…]+$/, ''))
      .join('. ');
    if (!text) return;
    const stations = await this.stations();
    const targets = deviceIds.flatMap((deviceId) => {
      const id = deviceId.startsWith(STATION_PREFIX) ? deviceId.slice(STATION_PREFIX.length) : undefined;
      const station = id ? stations.find((s) => s.id === id) : undefined;
      return station && this.speaks(station.id) ? [station] : [];
    });
    // all at once: a station that does not answer must not hold back the others
    await Promise.all(
      targets.map(async (station) => {
        try {
          const route = await this.voice.say(station, text);
          if (this.storage.values.debug) this.logger.log(`${station.name} said the notification (${route})`);
        } catch (error: any) {
          this.logger.error(`${station.name} could not say the notification:`, errorText(error));
        }
      }),
    );
  }

  async registerDevice(): Promise<NotifierDevice> {
    throw new Error('Yandex stations are added automatically after the sign-in');
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.setSpeaking(deviceId.slice(STATION_PREFIX.length), false);
  }

  async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const id = deviceId.slice(STATION_PREFIX.length);
    const station = (await this.stations()).find((s) => s.id === id);
    if (!station) return null;
    if (typeof patch.active === 'boolean') await this.setSpeaking(id, patch.active);
    if (typeof patch.name === 'string' && patch.name.trim()) {
      await this.storage.setInternalValue('stationNames', { ...this.storage.values.stationNames, [id]: patch.name.trim() });
    }
    return this.toNotifierDevice(station, HOUSEHOLD);
  }

  async notificationSettings(): Promise<JsonSchema[] | undefined> {
    return undefined;
  }

  private async setSpeaking(id: string, speaking: boolean): Promise<void> {
    const current = new Set(this.storage.values.speakingStations ?? []);
    if (speaking) current.add(id);
    else current.delete(id);
    await this.storage.setInternalValue('speakingStations', [...current]);
  }

  // ---- assistant ---------------------------------------------------------------------------------------------------

  assistantTools(): AssistantToolSpec[] {
    return [
      {
        name: 'yandex_say',
        description: 'Say a phrase aloud on a Yandex station (Alice). Without a station the first one is used. The cloud way says at most 100 characters.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to say, in the language of the listener.' },
            station: { type: 'string', description: 'Name, room or id of the station.' },
          },
          required: ['text'],
        },
        timeoutMs: 20_000,
      },
      {
        name: 'yandex_command',
        description: 'Give Alice on a Yandex station a command as if it were spoken, e.g. "включи музыку" or "какая погода".',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The command, as said to Alice.' },
            station: { type: 'string', description: 'Name, room or id of the station.' },
          },
          required: ['text'],
        },
        approval: true,
        timeoutMs: 20_000,
      },
      {
        name: 'yandex_run_scenario',
        description: 'Run a scenario of the Yandex Smart Home by its name.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name of the scenario.' } }, required: ['name'] },
        approval: true,
      },
      {
        name: 'yandex_devices',
        description: 'List the devices of the Yandex Smart Home with their rooms and current state, and its scenarios.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async callAssistantTool(name: string, input: Record<string, unknown>, _ctx: AssistantToolContext): Promise<AssistantToolResult> {
    try {
      switch (name) {
        case 'yandex_say':
        case 'yandex_command': {
          const text = typeof input.text === 'string' ? input.text : '';
          if (!text.trim()) return { error: 'text is required' };
          const station = await this.findStation(typeof input.station === 'string' ? input.station : undefined);
          const route = name === 'yandex_say' ? await this.voice.say(station, text) : await this.voice.command(station, text);
          return { content: `${station.name}: done (${route})` };
        }
        case 'yandex_run_scenario': {
          const asked = typeof input.name === 'string' ? input.name : '';
          const wanted = asked.trim().toLowerCase();
          if (!this.complete) await this.read();
          const scenario = this.scenarioList.find((s) => s.name.toLowerCase() === wanted) ?? this.scenarioList.find((s) => s.name.toLowerCase().includes(wanted));
          if (!wanted || !scenario) return { error: `No scenario "${asked}"; the scenarios are: ${this.scenarioList.map((s) => s.name).join(', ')}` };
          await this.commandApi().runScenario(scenario.id);
          return { content: `Scenario "${scenario.name}" started` };
        }
        case 'yandex_devices': {
          if (!this.complete) await this.read();
          return {
            content: {
              devices: [...this.devices.values()].map((d) => ({
                name: d.name,
                room: d.room,
                type: d.type.replace('devices.types.', ''),
                online: d.online,
                state: Object.fromEntries(
                  [...d.capabilities, ...d.properties].filter((i) => i.value !== undefined && typeof i.value !== 'object').map((i) => [i.instance, i.value]),
                ),
              })),
              scenarios: this.scenarioList.map((s) => s.name),
            },
          };
        }
      }
      return { error: `Unknown tool ${name}` };
    } catch (error: any) {
      return { error: errorText(error) };
    }
  }

  // ---- cameras of the Smart Home -------------------------------------------------------------------------------

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existing.set(camera.id, camera);
      if (this.started) await this.initializeCamera(camera);
    }
  }

  async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existing.set(camera.id, camera);
    await this.initializeCamera(camera);
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    const camera = this.existing.get(cameraId);
    this.existing.delete(cameraId);
    if (camera?.nativeId) this.cameras.delete(camera.nativeId);
  }

  async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    if (!this.complete) await this.read();
    return this.notAddedCameras();
  }

  async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  async onAdoptCamera(discovered: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const id = discovered.id.slice(CAMERA_PREFIX.length);
    const device = this.devices.get(id);
    if (!device) throw new Error(`Yandex camera ${id} not found, sign in again to read the devices`);
    this.logger.log(`Adopted camera: ${device.name}`);
    return {
      name: device.name,
      nativeId: device.id,
      // the video comes from the cloud of Yandex as HLS
      isCloud: true,
      info: { manufacturer: 'Yandex', model: device.type.replace('devices.types.', ''), serialNumber: device.id },
      sources: [{ name: 'HLS', role: 'high-resolution', useForSnapshot: true, hotMode: false, preload: false }],
    };
  }

  private notAddedCameras(): DiscoveredCamera[] {
    const added = new Set([...this.existing.values()].map((device) => device.nativeId));
    return [...this.devices.values()]
      .filter((device) => isCamera(device) && !added.has(device.id))
      .map((device) => ({
        id: `${CAMERA_PREFIX}${device.id}`,
        name: device.name,
        manufacturer: 'Yandex',
        model: device.type.replace('devices.types.', ''),
        address: device.room,
      }));
  }

  private async initializeCamera(device: CameraDevice): Promise<void> {
    const id = device.nativeId;
    if (!id || this.cameras.has(id)) return;
    const camera = new Camera(device, (nativeId) => this.cameraStreamUrl(nativeId));
    this.cameras.set(id, camera);
    try {
      await camera.initialize();
    } catch (error: any) {
      this.cameras.delete(id);
      this.logger.error(`Could not set up camera ${device.name}:`, errorText(error));
    }
  }

  /** An HLS address for one connection: Yandex makes it on request and it does not live long. */
  private async cameraStreamUrl(id: string): Promise<string> {
    if (this.readSource() === 'official' && this.iot) {
      try {
        const url = await this.iot.streamUrl(id);
        if (url) return url;
      } catch (error: any) {
        if (!this.quasar) throw error;
        this.logger.debug('The official API gave no stream, asking the Yandex app:', errorText(error));
      }
    }
    if (!this.quasar) throw new Error('The camera stream needs the sign-in by QR code or x_token');
    return this.quasar.streamUrl(id);
  }

  // ---- sign-in ----------------------------------------------------------------------------------------------------

  private async onOfficialLogin(values: YandexConfig & Record<string, unknown>): Promise<FormSubmitResponse | void> {
    if (values[DONE_FIELD] !== undefined) return;
    const signOuts = this.signOuts;
    const clientId = String(values.clientId ?? this.storage.values.clientId ?? '').trim();
    const clientSecret = String(values.clientSecret ?? this.storage.values.clientSecret ?? '').trim();
    if (!clientId) return { toast: { type: 'error', message: 'Enter the App ID of your app in Yandex ID first' } };
    if (clientId !== this.storage.values.clientId) await this.storage.setValue('clientId', clientId);
    if (clientSecret && clientSecret !== this.storage.values.clientSecret) await this.storage.setValue('clientSecret', clientSecret);

    // without a secret the user gets the token on the page of Yandex ID and pastes it
    if (!clientSecret) {
      const pasted = typeof values.pastedToken === 'string' ? values.pastedToken.trim() : '';
      if (pasted) return this.finishOfficial({ accessToken: pasted }, signOuts);
      return {
        schema: [
          {
            type: 'string',
            key: 'tokenPage',
            title: 'Open this page, allow access, copy the token',
            description:
              'The page of Yandex ID shows the token after you allow access, if the app in Yandex ID has the Redirect URI https://oauth.yandex.ru/verification_code.',
            format: 'textarea',
            readonly: true,
            defaultValue: tokenPageUrl(clientId),
          },
          { type: 'string', key: 'pastedToken', title: 'Token', description: 'Paste the token here, then press the button below.', format: 'password', required: true },
        ],
      };
    }

    const pending = this.deviceCode;
    if (pending && Date.now() < pending.expiresAt && values.userCode !== undefined) {
      try {
        const tokens = await exchangeDeviceCode(clientId, clientSecret, pending.deviceCode);
        this.deviceCode = undefined;
        return this.finishOfficial(tokens, signOuts);
      } catch (error: any) {
        if (error instanceof AuthorizationPending)
          return {
            toast: { type: 'warning', message: 'The code is not confirmed yet: enter it on the page, then press the button again' },
            schema: this.codeSchema(pending),
          };
        this.deviceCode = undefined;
        return { toast: { type: 'error', message: errorText(error) } };
      }
    }

    try {
      this.deviceCode = await requestDeviceCode(clientId, `vion${(this.storage.values.account ?? '').replace(/\W/g, '')}`.slice(0, 32).padEnd(8, '0'));
    } catch (error: any) {
      return { toast: { type: 'error', message: errorText(error) } };
    }
    return { schema: this.codeSchema(this.deviceCode) };
  }

  private codeSchema(code: DeviceCode): JsonSchemaWithoutCallbacks[] {
    return [
      {
        type: 'string',
        key: 'verificationUrl',
        title: 'Open this page on any device signed in to Yandex',
        description: 'A phone or a computer will do.',
        readonly: true,
        defaultValue: code.verificationUrl,
      },
      { type: 'string', key: 'userCode', title: 'and enter the code', description: 'Then press the button below.', readonly: true, defaultValue: code.userCode },
    ];
  }

  private async finishOfficial(tokens: OAuthTokens, signOuts: number): Promise<FormSubmitResponse> {
    const iot = new YandexIot(async () => tokens.accessToken);
    let count: number;
    try {
      count = (await iot.home()).devices.length;
    } catch (error: any) {
      return { toast: { type: 'error', message: `Yandex did not accept the token: ${errorText(error)}` } };
    }
    // Sign out was pressed while Yandex answered: this sign-in must not come back into the settings
    if (signOuts !== this.signOuts) return { toast: { type: 'error', message: SIGNED_OUT } };
    await this.storage.setValue('oauthToken', tokens.accessToken);
    await this.storage.setInternalValue('refreshToken', tokens.refreshToken ?? '');
    await this.storage.setInternalValue('tokenExpiresAt', tokens.expiresAt ?? 0);
    this.restartSoon();
    return { schema: [this.doneField('official', String(count))] };
  }

  private async onQrLogin(values: Record<string, unknown>): Promise<FormSubmitResponse | void> {
    if (values[DONE_FIELD] !== undefined) return;
    const signOuts = this.signOuts;
    const pending = this.qrSession?.qrPending && values.qrLink !== undefined ? this.qrSession : undefined;

    if (pending) {
      const until = Date.now() + QR_WAIT_MS;
      try {
        while (!(await pending.checkQr())) {
          // signed out while the window waited: the confirmation that may still come is not taken
          if (signOuts !== this.signOuts) return { toast: { type: 'error', message: SIGNED_OUT } };
          if (Date.now() > until)
            return {
              toast: { type: 'warning', message: 'Not confirmed yet: confirm in the Yandex app, then press the button again' },
              schema: await this.qrSchema(String(values.qrLink)),
            };
          await new Promise((resolve) => setTimeout(resolve, QR_POLL_MS));
        }
        return await this.finishApp(pending, signOuts);
      } catch (error: any) {
        return { toast: { type: 'error', message: `Sign-in failed: ${errorText(error)}` } };
      }
    }

    try {
      const session = new YandexSession();
      const link = await session.startQr();
      if (signOuts !== this.signOuts) return { toast: { type: 'error', message: SIGNED_OUT } };
      this.qrSession = session;
      return { schema: await this.qrSchema(link) };
    } catch (error: any) {
      return { toast: { type: 'error', message: `Could not start the QR sign-in: ${errorText(error)}` } };
    }
  }

  private async qrSchema(link: string): Promise<JsonSchemaWithoutCallbacks[]> {
    const image = await QRCode.toDataURL(link, { margin: 1, width: 280 });
    return [
      {
        type: 'string',
        key: 'qrImage',
        title: 'Scan with the Yandex app',
        description: 'Or open the link below on the phone where you are signed in to Yandex.',
        format: 'image',
        readonly: true,
        defaultValue: image,
      },
      {
        type: 'string',
        key: 'qrLink',
        title: 'Link',
        description: 'After you confirm in the app, press the button below.',
        format: 'textarea',
        readonly: true,
        defaultValue: link,
      },
    ];
  }

  /**
   * An x_token typed into its field. ViON stores the field before this runs, so one Yandex does not take is put back
   * to the sign-in that worked (or emptied): kept, it would be what the next start signs in with.
   */
  private async onXToken(value: unknown): Promise<void> {
    const xToken = typeof value === 'string' ? value.trim() : '';
    if (!xToken || xToken === this.storedXToken) return;
    const signOuts = this.signOuts;
    try {
      const session = new YandexSession();
      await session.useXToken(xToken);
      await this.finishApp(session, signOuts);
    } catch (error: any) {
      this.logger.error('The x_token typed in the settings did not sign in to Yandex and is not kept:', errorText(error));
      if (signOuts === this.signOuts && this.storage.values.xToken === value) await this.storage.setValue('xToken', this.storedXToken ?? '');
    }
  }

  private async finishApp(session: YandexSession, signOuts: number): Promise<FormSubmitResponse> {
    const account = await session.account();
    if (!session.jar.size) await session.cookiesFromXToken();
    // Sign out was pressed while Yandex answered: this sign-in must not come back into the settings
    if (signOuts !== this.signOuts) throw new YandexAuthError(SIGNED_OUT);
    const state = session.state();
    this.storedXToken = state.xToken;
    this.qrSession = undefined;
    await this.storage.setValue('xToken', state.xToken ?? '');
    await this.storage.setValue('cookies', state.cookies ?? '');
    await this.storage.setValue('stationToken', state.musicToken ?? '');
    await this.storage.setValue('account', account.login);
    this.logger.log(`Signed in to Yandex as ${account.login}`);
    this.restartSoon();
    return { schema: [this.doneField('app', account.login)] };
  }

  private doneField(kind: 'official' | 'app', value: string): JsonSchemaWithoutCallbacks {
    if (kind === 'official') {
      return {
        type: 'string',
        key: DONE_FIELD,
        title: 'Signed in to the Smart Home API, devices found:',
        description: 'Sensors are added under Sensors in ViON, cameras under Cameras. For speech on the stations, also sign in with QR code.',
        readonly: true,
        defaultValue: value,
      };
    }
    return {
      type: 'string',
      key: DONE_FIELD,
      title: 'Signed in to Yandex as:',
      description:
        'Sensors are added under Sensors in ViON, cameras under Cameras. A station speaks notifications once you turn it on in the notification settings of ViON.',
      readonly: true,
      defaultValue: value,
    };
  }

  private async onSpeak(values: Record<string, unknown>): Promise<FormSubmitResponse | void> {
    const text = typeof values.phrase === 'string' ? values.phrase.trim() : '';
    if (values.phrase === undefined) {
      const stations = await this.stations();
      if (!stations.length) return { toast: { type: 'error', message: 'No stations: sign in with QR code or x_token first' } };
      return {
        schema: [
          {
            type: 'string',
            key: 'station',
            title: 'Station',
            description: 'The station that speaks.',
            enum: stations.map((s) => s.id),
            enumLabels: Object.fromEntries(stations.map((s) => [s.id, this.stationName(s)])),
            defaultValue: stations[0].id,
          },
          { type: 'string', key: 'phrase', title: 'Phrase', description: 'What the station says.', defaultValue: 'Привет! Это ViON.', required: true },
        ],
      };
    }
    if (!text) return { toast: { type: 'error', message: 'Enter a phrase' } };
    try {
      const station = await this.findStation(typeof values.station === 'string' ? values.station : undefined);
      const route = await this.voice.say(station, text);
      return { toast: { type: 'success', message: route === 'local' ? 'Said through the home network' : 'Said through the cloud' } };
    } catch (error: any) {
      return { toast: { type: 'error', message: errorText(error) } };
    }
  }

  private async onLogout(): Promise<void> {
    // what runs now (a reading, a renewal, a sign-in) checks this when Yandex answers, and keeps nothing
    this.signOuts++;
    this.disconnect();
    this.deviceCode = undefined;
    this.qrSession = undefined;
    this.storedXToken = undefined;
    this.renewFailedAt = 0;
    this.devices.clear();
    this.scenarioList = [];
    this.scenariosRead = false;
    this.complete = false;
    this.offeredCameras = undefined;
    this.markUnavailable();
    for (const key of ['xToken', 'cookies', 'stationToken', 'account', 'oauthToken'] as const) await this.storage.setValue(key, '');
    await this.storage.setInternalValue('refreshToken', '');
    await this.storage.setInternalValue('tokenExpiresAt', 0);
    // the stations of the next sign-in speak only once chosen again
    await this.storage.setInternalValue('speakingStations', []);
    this.logger.log('Signed out of Yandex');
  }
}
