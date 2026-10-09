import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_EVENT, BasePlugin, SensorType, Severity } from '@camera.ui/sdk';
import { CameraSpeaker, FfmpegListener, ModelStore, PROBLEM_TEXT, SherpaEngine, listenToCamera, speakerProblem, speakerProblemCode } from '@vionvision/speech';

import { DoorWatcher } from './door.js';
import { nativeRequire } from './runtime.js';
import { LANGUAGES, LANGUAGE_NAMES, asLanguage, fill, saidText, texts } from './speech.js';
import { DAY_LABELS, PLUGIN_DEFAULTS, SCREEN_TIME_DEFAULTS, checkDoorRule, checkScreenTime, quietHours } from './settings.js';
import { TOOLS, callTool } from './tools.js';
import { DAYS, activeInterval, formatClock, serverTimeZone, systemClock, validTimeZone } from './time.js';
import { Voice } from './voice.js';

import type {
  AssistantToolContext,
  AssistantToolProvider,
  AssistantToolResult,
  AssistantToolSpec,
  CameraDevice,
  DetectionEvent,
  DetectionEventType,
  DeviceStorage,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  Notification,
  NotifierDevice,
  NotifierInterface,
  PluginAPI,
  SensorLike,
} from '@camera.ui/sdk';
import type { SpeechEngine } from '@vionvision/speech';
import type { SeenDetection, Sighting } from './presence.js';
import type { DoorRule, PluginValues, ScreenTimeValues } from './settings.js';
import type { Language } from './speech.js';
import type { ToolCamera, ToolHost } from './tools.js';
import type { CameraPort, SavedState } from './voice.js';

interface CameraValues {
  screenTime?: ScreenTimeValues[];
}

interface CameraEntry {
  device: CameraDevice;
  storage: DeviceStorage<CameraValues>;
  speaker: CameraSpeaker;
  disposers: { unsubscribe(): void }[];
  /** Faces and attributes seen in the camera's events, with when: the object sensor knows boxes, not names. */
  faces: Map<string, number>;
  attributes: Map<string, { yes: boolean; at: number }>;
}

const DEVICE_PREFIX = 'voice:';
const MAX_NOTIFICATION_CHARS = 300;
const INTERCOM_PLUGIN = '@vionvision/camera-ui-intercom';
/** How often VOICE asks the intercom which cameras are its panels. */
const PANELS_EVERY_MS = 60_000;

type Field = Record<string, unknown> & { type: string; title: string; description: string };
// the SDK types array items as Omit<union, 'key'>, which keeps only the keys common to all field kinds (no enum,
// minimum or properties); the fields are checked by the shapes above and handed over as the SDK expects them
const asItems = (schema: Field) => schema as unknown as Omit<JsonSchemaWithoutCallbacks, 'key'>;
const field = (key: string, schema: Field) => ({ key, ...schema }) as unknown as JsonSchemaWithoutCallbacks;
const LOOK_EVERY_MS = 5_000;
/** A name or an attribute from an event counts for presence this long. */
const SEEN_FOR_MS = 2 * 60_000;

export default class VoicePlugin extends BasePlugin<PluginValues> implements NotifierInterface, AssistantToolProvider {
  private cameras = new Map<string, CameraEntry>();
  private sensors = new Map<string, SensorLike>();
  private voice: Voice;
  private door: DoorWatcher;
  private store: ModelStore;
  private engine: SpeechEngine;
  private listener: FfmpegListener;
  private stateFile: string;
  private lookTimer: NodeJS.Timeout | undefined;
  private panelsTimer: NodeJS.Timeout | undefined;
  /** Cameras of the intercom's panels: the door agent speaks there, VOICE does not. */
  private panelCameras = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private started = false;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginValues>) {
    super(logger, api, storage);
    const log = (message: string) => this.logger.log(message);
    this.stateFile = join(api.storagePath, 'voice-state.json');
    this.store = new ModelStore(join(api.storagePath, 'voice-models'), undefined, log);
    this.engine = this.createEngine(this.store);
    this.listener = new FfmpegListener(() => this.api.coreManager.getFFmpegPath(), this.engine, log);
    this.voice = new Voice(
      {
        clock: systemClock,
        engine: this.engine,
        ask: (request) => this.api.coreManager.assistantAsk(request),
        publish: (notification) => this.api.notificationManager.publish(notification),
        timeZone: () => this.timeZone(),
        language: () => this.language(),
        speed: () => this.values().speed ?? PLUGIN_DEFAULTS.speed,
        listenSeconds: () => this.values().listenSeconds ?? PLUGIN_DEFAULTS.listenSeconds,
        maxPerMinute: () => this.values().maxPerMinute ?? PLUGIN_DEFAULTS.maxPerMinute,
        quiet: () => quietHours(this.values().quietFrom, this.values().quietTo),
        saveState: (state) => this.saveState(state),
        log,
      },
      this.loadState(),
    );
    this.door = new DoorWatcher({
      clock: systemClock,
      timeZone: () => this.timeZone(),
      language: () => this.language(),
      people: () => this.values().people ?? [],
      rules: () => this.doorRules(),
      quiet: () => quietHours(this.values().quietFrom, this.values().quietTo),
      say: (speakerId, text) => this.voice.say(speakerId, text, 'template'),
      describe: (cameraId, language, timeoutMs) => this.describe(cameraId, language, timeoutMs),
      log,
    });
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => this.start());
    this.api.on(API_EVENT.SHUTDOWN, () => this.stop());
  }

  /** The speech engine; the specs put a fake one here. */
  protected createEngine(store: ModelStore): SpeechEngine {
    return new SherpaEngine(
      store,
      (message) => this.logger.debug(message),
      () => nativeRequire('sherpa-onnx-node'),
    );
  }

  // ---- plugin settings ----

  get storageSchema(): JsonSchema[] {
    const speakers = this.speakerOptions();
    const cameras = this.cameraOptions();
    return [
      {
        type: 'string',
        key: 'timeZone',
        title: 'Time zone',
        description: 'The time zone of the household, e.g. Europe/Moscow: bedtimes and quiet hours follow it. Empty: the time zone of the server.',
        store: true,
        placeholder: serverTimeZone(),
        group: 'Voice',
      },
      {
        type: 'string',
        key: 'language',
        title: 'Language of the phrases',
        description: 'VOICE speaks and listens in this language.',
        store: true,
        defaultValue: PLUGIN_DEFAULTS.language,
        enum: [...LANGUAGES],
        enumLabels: { ru: 'Russian', en: 'English', de: 'German' },
        group: 'Voice',
      },
      {
        type: 'number',
        key: 'speed',
        title: 'Speech speed',
        description: '1 is normal, less is slower.',
        store: true,
        defaultValue: PLUGIN_DEFAULTS.speed,
        minimum: 0.7,
        maximum: 1.5,
        step: 0.1,
        group: 'Voice',
      },
      {
        type: 'number',
        key: 'listenSeconds',
        title: 'Waiting for an answer, seconds',
        description: 'After a phrase VOICE listens this long for the child to answer. Speech is recognized on this server and the sound is not kept.',
        store: true,
        defaultValue: PLUGIN_DEFAULTS.listenSeconds,
        minimum: 3,
        maximum: 30,
        group: 'Voice',
      },
      {
        type: 'number',
        key: 'maxPerMinute',
        title: 'Phrases a minute on one camera, at most',
        description: 'Further phrases in that minute are not said.',
        store: true,
        defaultValue: PLUGIN_DEFAULTS.maxPerMinute,
        minimum: 1,
        maximum: 30,
        group: 'Voice',
      },
      {
        type: 'string',
        key: 'quietFrom',
        title: 'Quiet hours from',
        description: 'VOICE says nothing in the quiet hours, except that it is bedtime. Empty for no quiet hours.',
        store: true,
        placeholder: '23:00',
        group: 'Voice',
      },
      {
        type: 'string',
        key: 'quietTo',
        title: 'Quiet hours until',
        description: 'The end of the quiet hours, e.g. 07:00.',
        store: true,
        placeholder: '07:00',
        group: 'Voice',
      },
      {
        type: 'string',
        key: 'models',
        title: 'Speech models',
        description: 'Downloaded from the ViON models server the first time VOICE speaks or listens.',
        readonly: true,
        store: false,
        onGet: async () => (await this.store.installed()).join(', ') || 'not downloaded yet',
        group: 'Voice',
      },
      {
        type: 'array',
        key: 'doorRules',
        title: 'Who is at the door',
        description: 'When a door camera sees a person, VOICE says who came through the cameras with a speaker.',
        store: true,
        defaultValue: [],
        items: asItems({
          type: 'object',
          title: 'Rule',
          description: 'Door cameras and where to speak.',
          properties: [
            { type: 'boolean', key: 'enabled', title: 'On', description: 'The rule works.', defaultValue: true },
            {
              type: 'string',
              key: 'doorCameras',
              title: 'Door cameras',
              description: 'Cameras that see the door. VOICE must be turned on for them in the Plugins tab of the camera.',
              enum: cameras.map((c) => c.id),
              enumLabels: Object.fromEntries(cameras.map((c) => [c.id, c.name])),
              multiple: true,
              defaultValue: [],
            },
            {
              type: 'string',
              key: 'speakers',
              title: 'Speak through',
              description: 'Cameras with a speaker where VOICE says who came.',
              enum: speakers.map((c) => c.id),
              enumLabels: Object.fromEntries(speakers.map((c) => [c.id, c.name])),
              multiple: true,
              defaultValue: [],
            },
            {
              type: 'boolean',
              key: 'describe',
              title: 'Describe strangers',
              description: 'The assistant looks at a snapshot: "a courier with a box". Needs a model that sees pictures.',
              defaultValue: false,
            },
            {
              type: 'number',
              key: 'cooldownSeconds',
              title: 'Do not repeat for, seconds',
              description: 'The same person is not announced again sooner.',
              defaultValue: 120,
              minimum: 0,
              maximum: 3600,
            },
            {
              type: 'string',
              key: 'quietFrom',
              title: 'Silent from',
              description: 'This rule says nothing from this time, e.g. 22:00. Empty for always on.',
              placeholder: '22:00',
            },
            { type: 'string', key: 'quietTo', title: 'Silent until', description: 'The end of the silent time, e.g. 07:00.', placeholder: '07:00' },
          ],
        }),
        onSet: async () => this.refreshSchemas(),
        group: 'Who is at the door',
      },
      {
        type: 'array',
        key: 'people',
        title: 'How to announce people',
        description: 'For "came home" phrases: the face name and whether to say he or she. Others are announced as "<name> is at the door".',
        store: true,
        defaultValue: [],
        items: asItems({
          type: 'object',
          title: 'Person',
          description: 'A known face.',
          properties: [
            { type: 'string', key: 'name', title: 'Face name', description: 'As in the faces of ViON.' },
            {
              type: 'string',
              key: 'gender',
              title: 'Say',
              description: 'He came, she came, or neutral.',
              enum: ['male', 'female', 'neutral'],
              enumLabels: { male: 'He came', female: 'She came', neutral: 'At the door' },
              defaultValue: 'neutral',
            },
          ],
        }),
        group: 'Who is at the door',
      },
      {
        type: 'string',
        key: 'channelSpeakers',
        title: 'Speakers for notifications',
        description:
          'These cameras say notifications addressed to them: in an automation choose the action "Notification" and the speaker "<camera> (VOICE)". ' +
          'Other notifications are never said.',
        store: true,
        enum: speakers.map((c) => c.id),
        enumLabels: Object.fromEntries(speakers.map((c) => [c.id, c.name])),
        multiple: true,
        defaultValue: [],
        group: 'Notifications',
      },
      {
        type: 'string',
        key: 'channelRewrite',
        title: 'Retell in natural speech',
        description: 'For these speakers the assistant turns the notification into a short spoken phrase instead of reading title and text.',
        store: true,
        enum: speakers.map((c) => c.id),
        enumLabels: Object.fromEntries(speakers.map((c) => [c.id, c.name])),
        multiple: true,
        defaultValue: [],
        group: 'Notifications',
      },
      {
        type: 'string',
        key: 'recent',
        title: 'Recent phrases',
        description: 'The last 20 phrases of VOICE and what children answered, for the parents. The sound is not kept.',
        format: 'textarea',
        readonly: true,
        store: false,
        onGet: async () => this.recentText(),
        group: 'Voice',
      },
      {
        type: 'string',
        key: 'assistant',
        title: 'Assistant',
        description: 'VOICE asks the assistant to write phrases and answers. Without it VOICE uses ready phrases.',
        readonly: true,
        store: false,
        onGet: async () => this.assistantState(),
        group: 'Assistant',
      },
    ];
  }

  // ---- cameras ----

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.onCameraAdded(camera);
  }

  async onCameraAdded(device: CameraDevice): Promise<void> {
    if (this.cameras.has(device.id)) await this.onCameraReleased(device.id);
    const log = (message: string) => this.logger.log(message);
    const speaker = new CameraSpeaker(device, systemClock, log);
    const entry: CameraEntry = {
      device,
      speaker,
      storage: undefined as never,
      disposers: [],
      faces: new Map(),
      attributes: new Map(),
    };
    entry.storage = device.createStorage<CameraValues>(this.cameraSchema(entry));
    this.cameras.set(device.id, entry);

    const port: CameraPort = {
      id: device.id,
      name: device.name,
      speaker: { problem: () => speakerProblem(device), speak: (samples, rate, signal) => speaker.speak(samples, rate, signal) },
      zone: (name) => device.zones?.object?.find((z) => z.name === name)?.points,
      snapshot: async () => {
        const data = await (device.snapshotSource ?? device.streamSource).snapshot();
        return data ? new Uint8Array(data) : undefined;
      },
      listen: (windowMs, signal) => this.listener.listen(device, windowMs, signal),
      hear: () => listenToCamera(() => this.api.coreManager.getFFmpegPath(), this.engine, device, systemClock),
    };
    this.voice.addCamera(port);
    entry.disposers.push(device.onDetectionEvent.subscribe(({ type, event }) => this.onDetection(entry, type, event)));
    // the talk channel of a stream is known only once the server has probed it (after a restart, a while after start)
    const changed = () => {
      this.applyScreenTime(entry);
      void this.refreshSchemas();
    };
    entry.disposers.push(device.onPropertyChange(['zones', 'sources']).subscribe(changed));
    this.applyScreenTime(entry);
    await this.refreshSchemas();
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    const entry = this.cameras.get(cameraId);
    if (!entry) return;
    // Remove it before awaiting network cleanup: no new work may capture the released camera.
    this.cameras.delete(cameraId);
    this.voice.removeCamera(cameraId);
    for (const disposer of entry.disposers) disposer.unsubscribe();
    await entry.speaker.dispose();
    await this.refreshSchemas();
  }

  async configureSensors(sensors: SensorLike[]): Promise<void> {
    for (const sensor of sensors) await this.onSensorAdded(sensor);
  }

  async onSensorAdded(sensor: SensorLike): Promise<void> {
    if (sensor.type === SensorType.Object || sensor.type === SensorType.Face) this.sensors.set(sensor.id, sensor);
  }

  async onSensorReleased(sensorId: string): Promise<void> {
    this.sensors.delete(sensorId);
  }

  private cameraSchema(entry: CameraEntry): JsonSchema[] {
    const device = entry.device;
    const zones = (device.zones?.object ?? []).map((z) => z.name);
    const labels = [...new Set(['person', ...(device.zones?.object ?? []).flatMap((z) => z.labels as string[])])];
    const item = field;
    const d = SCREEN_TIME_DEFAULTS;
    return [
      {
        type: 'string',
        key: 'speaker',
        title: 'Speaker',
        description: 'Whether VOICE can speak through this camera: it needs a speaker and a talk channel in the stream.',
        readonly: true,
        store: false,
        onGet: async () => this.speakerText(device),
      },
      {
        type: 'array',
        key: 'screenTime',
        title: 'Screen time',
        description: 'Children at the computer in view of this camera: breaks, a daily limit and bedtime. VOICE reminds them aloud and tells the parents.',
        store: true,
        defaultValue: [],
        items: asItems({
          type: 'object',
          title: 'Child',
          description: 'One child at this computer.',
          properties: [
            item('childName', { type: 'string', title: "Child's name", description: 'VOICE calls the child by this name.', placeholder: 'Artem' }),
            item('zone', {
              type: 'string',
              title: 'Computer zone',
              description:
                'Optional: an object zone of this camera around the computer. An object zone also limits where the camera detects at all, ' +
                'so do not draw one only for VOICE: use the area below, or leave both empty for the whole picture.',
              enum: zones,
            }),
            item('area', {
              type: 'string',
              title: 'Computer area, %',
              description:
                'Optional: the part of the picture with the computer, "x, y, width, height" in percent from the top left, e.g. 0, 30, 50, 60. Empty: the whole picture.',
              placeholder: '0, 30, 50, 60',
            }),
            item('sessionMinutes', {
              type: 'number',
              title: 'Break every, minutes',
              description: 'Time at the computer before a break.',
              defaultValue: d.sessionMinutes,
              minimum: 5,
              maximum: 240,
            }),
            item('breakMinutes', {
              type: 'number',
              title: 'Break length, minutes',
              description: 'Time away from the computer adds up until the whole break is taken.',
              defaultValue: d.breakMinutes,
              minimum: 3,
              maximum: 120,
            }),
            item('dailyMinutes', {
              type: 'number',
              title: 'Daily limit, minutes',
              description: '0 for no daily limit.',
              defaultValue: d.dailyMinutes,
              minimum: 0,
              maximum: 1440,
            }),
            item('schoolFrom', {
              type: 'string',
              title: 'Bedtime on school nights',
              description: 'Evenings before a school day (by default Sunday to Thursday), HH:MM. Empty for none.',
              defaultValue: d.schoolFrom,
              placeholder: '21:30',
            }),
            item('schoolTo', {
              type: 'string',
              title: 'Wake-up on school days',
              description: 'The end of the school-night bedtime, HH:MM.',
              defaultValue: d.schoolTo,
              placeholder: '07:30',
            }),
            item('freeFrom', {
              type: 'string',
              title: 'Bedtime on weekend nights',
              description: 'The other evenings (by default Friday and Saturday), HH:MM. Empty for none.',
              defaultValue: d.freeFrom,
              placeholder: '22:30',
            }),
            item('freeTo', {
              type: 'string',
              title: 'Wake-up on weekend days',
              description: 'The end of the weekend bedtime, HH:MM.',
              defaultValue: d.freeTo,
              placeholder: '08:30',
            }),
            item('answerQuestions', {
              type: 'boolean',
              title: 'Answer the child',
              description: 'After a phrase VOICE listens and answers questions like "when can I play?".',
              defaultValue: d.answerQuestions,
            }),
            item('answerOnCall', {
              type: 'boolean',
              title: 'Answer when called',
              description:
                'The child says «ВиОН» and a question («ВиОН, сколько мне ещё отдыхать?»), and VOICE answers in minutes. ' +
                'The microphone of this camera stays open while this is on: speech is recognized on this server, nothing is recorded or kept. Russian only for now.',
              defaultValue: d.answerOnCall,
            }),
            item('breakReminder', {
              type: 'boolean',
              title: 'Say how long the break still lasts',
              description: 'When the child comes back too early.',
              defaultValue: d.breakReminder,
            }),
            item('enabled', { type: 'boolean', title: 'On', description: 'The scenario works.', defaultValue: d.enabled }),
            item('schoolEvenings', {
              type: 'string',
              title: 'More: school evenings',
              description: 'Evenings before a school day; the other evenings use the weekend bedtime.',
              enum: [...DAYS],
              enumLabels: DAY_LABELS,
              multiple: true,
              defaultValue: d.schoolEvenings,
            }),
            item('labels', {
              type: 'string',
              title: 'More: who counts',
              description: 'What the detector must see in the zone. A trained module adds its own label here.',
              enum: labels,
              multiple: true,
              defaultValue: d.labels,
            }),
            item('face', { type: 'string', title: 'More: only this face', description: 'When several people use the computer. Empty for anyone.' }),
            item('attribute', {
              type: 'string',
              title: 'More: only with this attribute',
              description: 'A trained attribute that must be "yes", e.g. "at the computer". Empty for none.',
            }),
            item('repeatMinutes', {
              type: 'number',
              title: 'More: repeat after, minutes',
              description: 'Between the soft phrase, the firm one and the notice to the parents.',
              defaultValue: d.repeatMinutes,
              minimum: 1,
              maximum: 60,
            }),
            item('maxRepeats', {
              type: 'number',
              title: 'More: repeats after the notice',
              description: 'How many more times VOICE repeats.',
              defaultValue: d.maxRepeats,
              minimum: 0,
              maximum: 20,
            }),
            item('minPresenceSeconds', {
              type: 'number',
              title: 'More: seconds before counting',
              description: 'A person passing by is not counted.',
              defaultValue: d.minPresenceSeconds,
              minimum: 5,
              maximum: 300,
            }),
            item('gapSeconds', {
              type: 'number',
              title: 'More: short absence, seconds',
              description: 'Leaving for less does not end the session.',
              defaultValue: d.gapSeconds,
              minimum: 10,
              maximum: 1800,
            }),
            item('id', { type: 'string', title: 'Id', description: 'Internal.', hidden: true }),
          ],
        }),
        onSet: async () => {
          this.applyScreenTime(entry);
        },
      },
      {
        type: 'string',
        key: 'status',
        title: 'Now',
        description: 'Time at the computer today and what VOICE is waiting for.',
        format: 'textarea',
        readonly: true,
        store: false,
        onGet: async () => this.statusText(entry),
      },
      {
        type: 'submit',
        key: 'giveTime',
        title: 'Give more time',
        description: 'More minutes from now, or skip the next break.',
        onClick: (values: unknown) => this.onGiveTime(entry, values),
      },
      {
        type: 'submit',
        key: 'sayPhrase',
        title: 'Say a phrase',
        description: 'VOICE says your text through this camera.',
        onClick: (values: unknown) => this.onSayPhrase(entry, values),
      },
      { type: 'submit', key: 'testPhrase', title: 'Say a test phrase', description: 'Checks the speaker of this camera.', onClick: () => this.onTestPhrase(entry) },
    ];
  }

  // ---- lifecycle ----

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.voice.start();
    this.lookTimer = setInterval(() => void this.lookAll(), LOOK_EVERY_MS);
    this.panelsTimer = setInterval(() => void this.refreshPanels(), PANELS_EVERY_MS);
    void this.refreshPanels();
  }

  private stop(): void {
    this.started = false;
    clearInterval(this.lookTimer);
    this.lookTimer = undefined;
    clearInterval(this.panelsTimer);
    this.panelsTimer = undefined;
    this.door.stop();
    this.voice.stop();
    for (const entry of this.cameras.values()) void entry.speaker.close();
  }

  private values(): PluginValues {
    return this.storage.values ?? {};
  }

  /**
   * The zone of the household's clock: the setting, else the server process's. In Docker the process runs on UTC unless
   * TZ is set, and a bedtime of 21:30 would then begin at 00:30 in Moscow.
   */
  private timeZone(): string {
    const wanted = this.values().timeZone?.trim();
    if (wanted && validTimeZone(wanted)) return wanted;
    return serverTimeZone();
  }

  private language(): Language {
    return asLanguage(this.values().language, 'ru');
  }

  // ---- presence ----

  private onDetection(entry: CameraEntry, type: DetectionEventType, event: DetectionEvent): void {
    const now = Date.now();
    for (const segment of event.segments ?? []) {
      for (const attribute of segment.attributes ?? []) {
        if (attribute.type === 'face' && attribute.label) entry.faces.set(attribute.label, now);
        else if (attribute.type && typeof attribute.label === 'string') {
          const answer = attribute.label
            .slice(attribute.label.lastIndexOf(':') + 1)
            .trim()
            .toLowerCase();
          if (['да', 'yes', 'нет', 'no'].includes(answer)) entry.attributes.set(attribute.type, { yes: answer === 'да' || answer === 'yes', at: now });
        }
      }
    }
    this.door.onEvent(type, event);
  }

  /**
   * What the camera sees now; undefined when VOICE cannot know: the camera is offline, snoozed, its analysis stopped or
   * its object detection is not there. The sensor keeps the last boxes of a still child when the camera or the detector
   * drops, and those counted as a whole night at the computer. A video that stalls while the camera stays "connected"
   * the server clears itself after 30 s: the boxes are gone, the child is not seen.
   */
  private sighting(entry: CameraEntry): Sighting | undefined {
    const now = Date.now();
    const device = entry.device;
    if (!device.connected || device.snooze || !device.frameWorkerConnected) return undefined;
    const objects = [...this.sensors.values()].filter((s) => s.type === SensorType.Object && s.assignedCameraIds.includes(entry.device.id));
    if (!objects.some((sensor) => sensor.connected)) return undefined;
    const detections: SeenDetection[] = [];
    const faces = new Set<string>();
    for (const sensor of this.sensors.values()) {
      if (!sensor.assignedCameraIds.includes(entry.device.id) || !sensor.connected) continue;
      if (sensor.type === SensorType.Object) {
        // a still child is "static": it is in staticDetections, not in detections
        for (const key of ['detections', 'staticDetections']) {
          const list = sensor.getValue(key);
          if (Array.isArray(list)) for (const d of list) if (d?.box && d.label) detections.push({ label: String(d.label), box: d.box });
        }
      } else if (sensor.type === SensorType.Face) {
        const names = sensor.getValue('identities');
        if (Array.isArray(names)) for (const name of names) if (typeof name === 'string') faces.add(name);
      }
    }
    for (const [name, at] of entry.faces) if (now - at < SEEN_FOR_MS) faces.add(name);
    const attributes: Record<string, boolean> = {};
    for (const [type, seen] of entry.attributes) if (now - seen.at < SEEN_FOR_MS) attributes[type] = seen.yes;
    return { detections, faces: [...faces], attributes };
  }

  private async lookAll(): Promise<void> {
    if (!this.started) return;
    for (const entry of this.cameras.values()) {
      if (!this.started) break;
      if (!this.voice.scenariosOf(entry.device.id).length) continue;
      try {
        await this.voice.look(entry.device.id, this.sighting(entry));
      } catch (error) {
        this.logger.error(`${entry.device.name}: ${(error as Error).message}`);
      }
    }
  }

  private applyScreenTime(entry: CameraEntry): void {
    const zones = (entry.device.zones?.object ?? []).map((z) => z.name);
    const configs = [];
    for (const values of entry.storage.values?.screenTime ?? []) {
      const checked = checkScreenTime(values, zones);
      if (checked.value) configs.push(checked.value);
      else this.logger.warn(`${entry.device.name}: screen time of ${values.childName ?? 'a child'} is not used: ${checked.errors.join('; ')}`);
    }
    // a camera without a talk channel gets no scenario: nobody would hear the reminders. One that is offline keeps it,
    // a camera that reconnects speaks again without the owner touching anything
    const problem = speakerProblemCode(entry.device);
    const mute = problem === 'no_channel' || problem === 'channel_off';
    if (configs.length && mute) this.logger.warn(`${entry.device.name}: screen time is not used, VOICE cannot speak here: ${PROBLEM_TEXT[problem]}`);
    this.voice.setScreenTime(entry.device.id, mute ? [] : configs);
  }

  // ---- texts of the settings ----

  private speakerText(device: CameraDevice): string {
    const t = texts(this.language());
    const problem = speakerProblemCode(device);
    return problem ? fill(t.speakerNo, { reason: t.problems[problem] }) : t.speakerYes;
  }

  private statusText(entry: CameraEntry): string {
    const lines = this.voice.scenariosOf(entry.device.id).map(({ key }) => this.voice.statusOf(key));
    const call = this.voice.callStatusOf(entry.device.id);
    if (call) lines.push(call);
    return lines.join('\n') || '—';
  }

  private recentText(): string {
    const timeZone = this.timeZone();
    const lines = this.voice.recent
      .slice()
      .reverse()
      .map((e) => {
        const time = formatClock(e.at, timeZone);
        const where = this.cameras.get(e.cameraId)?.device.name ?? e.cameraId;
        const heard = e.heard ? `${e.child ?? '?'}: «${e.heard}» → ` : '';
        return `${time} ${where}: ${heard}«${e.said}»${e.result === 'spoken' ? '' : ` (${e.result})`}`;
      });
    return lines.join('\n') || '—';
  }

  private async assistantState(): Promise<string> {
    try {
      const access = await this.api.coreManager.assistantAccess();
      if (!access.allowed) return 'Not allowed: turn VOICE on in Settings → Assistant. Until then VOICE uses ready phrases.';
      const cloud =
        access.model && !/ollama|lm ?studio|local/i.test(access.model)
          ? " If this model runs in the cloud, the text of the child's question goes there; the sound never does."
          : '';
      return `Allowed, model: ${access.model ?? 'default'}.${cloud}`;
    } catch (error) {
      return `Unknown: ${(error as Error).message}`;
    }
  }

  // ---- buttons ----

  private async onGiveTime(entry: CameraEntry, raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const scenarios = this.voice.scenariosOf(entry.device.id);
    if (!scenarios.length) return { toast: { type: 'error', message: 'No screen time is set up on this camera' } };
    if (values.minutes === undefined && values.skipBreak === undefined) {
      return {
        schema: [
          {
            type: 'string',
            key: 'child',
            title: 'Child',
            description: 'Who gets more time.',
            enum: scenarios.map((s) => s.key),
            enumLabels: Object.fromEntries(scenarios.map((s) => [s.key, s.engine.config.childName])),
            defaultValue: scenarios[0].key,
          },
          { type: 'number', key: 'minutes', title: 'Minutes', description: 'From now; 0 for none.', defaultValue: 30, minimum: 0, maximum: 240 },
          { type: 'boolean', key: 'skipBreak', title: 'Skip the next break', description: 'The time since the last break starts over.', defaultValue: false },
        ],
      };
    }
    const key = typeof values.child === 'string' ? values.child : scenarios[0].key;
    if (!scenarios.some((scenario) => scenario.key === key)) return { toast: { type: 'error', message: 'Choose a child on this camera' } };
    const minutes = Number(values.minutes) || 0;
    if (!minutes && values.skipBreak !== true) return { toast: { type: 'error', message: 'Give minutes or skip the break' } };
    try {
      this.voice.extend(key, minutes || undefined, values.skipBreak === true);
      return { toast: { type: 'success', message: this.voice.statusOf(key) } };
    } catch (error) {
      return { toast: { type: 'error', message: (error as Error).message } };
    }
  }

  private async onSayPhrase(entry: CameraEntry, raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    if (values.phrase === undefined) {
      return {
        schema: [
          { type: 'string', key: 'phrase', title: 'Phrase', description: 'What VOICE says.', required: true },
          {
            type: 'boolean',
            key: 'instruction',
            title: 'Let the assistant phrase it',
            description: 'Write what to say, e.g. "tell Artem dinner is ready", and the assistant turns it into a phrase.',
            defaultValue: false,
          },
        ],
      };
    }
    const phrase = typeof values.phrase === 'string' ? values.phrase.trim() : '';
    if (!phrase) return { toast: { type: 'error', message: 'Enter a phrase' } };
    if (values.instruction === true) {
      const result = await this.voice.sayInstructed(entry.device.id, phrase);
      return result.status === 'spoken' ? { toast: { type: 'success', message: `Said: ${result.text}` } } : this.toast(result);
    }
    return this.toast(await this.voice.say(entry.device.id, phrase));
  }

  private async onTestPhrase(entry: CameraEntry): Promise<FormSubmitResponse> {
    return this.toast(await this.voice.say(entry.device.id, texts(this.language()).test));
  }

  private toast(result: { status: string; reason?: string }): FormSubmitResponse {
    if (result.status === 'spoken') return { toast: { type: 'success', message: 'Said' } };
    return { toast: { type: 'error', message: `Not said: ${result.status}${result.reason ? ` (${result.reason})` : ''}` } };
  }

  private async refreshSchemas(): Promise<void> {
    for (const entry of this.cameras.values()) {
      const fresh = this.cameraSchema(entry);
      for (const key of ['screenTime']) {
        const schema = fresh.find((s) => s.key === key);
        if (schema && entry.storage.hasSchema?.(key)) await entry.storage.changeSchema(key, schema).catch(() => undefined);
      }
    }
    const fresh = this.storageSchema;
    for (const key of ['doorRules', 'channelSpeakers', 'channelRewrite']) {
      const schema = fresh.find((s) => s.key === key);
      if (schema && this.storage.hasSchema?.(key)) await this.storage.changeSchema(key, schema).catch(() => undefined);
    }
  }

  private cameraOptions(): { id: string; name: string }[] {
    return [...this.cameras.values()].map((e) => ({ id: e.device.id, name: e.device.name }));
  }

  private speakerOptions(): { id: string; name: string }[] {
    return [...this.cameras.values()]
      .filter((e) => !speakerProblem(e.device) && !this.panelCameras.has(e.device.id))
      .map((e) => ({ id: e.device.id, name: e.device.name }));
  }

  /** The intercom's panels, when it is installed: their cameras are not VOICE's speakers. */
  private async refreshPanels(): Promise<void> {
    try {
      const intercom = (await this.api.coreManager.connectToPlugin(INTERCOM_PLUGIN)) as { panelCameraIds?: () => Promise<string[]> } | undefined;
      const ids = typeof intercom?.panelCameraIds === 'function' ? await intercom.panelCameraIds() : [];
      const changed = ids.length !== this.panelCameras.size || ids.some((id) => !this.panelCameras.has(id));
      this.panelCameras = new Set(ids);
      if (changed) await this.refreshSchemas();
    } catch {
      // no intercom, or it is not running: every camera with a speaker is VOICE's
      this.panelCameras.clear();
    }
  }

  /**
   * For the intercom (ТЗ 4.8): a phrase on the house's speakers, "a ring at the gate". It goes through the speakers for
   * notifications, VOICE's queue, limits and quiet hours, and never through the panels' cameras.
   */
  public async announce(text: string, options: { exceptCameraIds?: string[] } = {}): Promise<{ said: string[]; skipped: string[] }> {
    const phrase = typeof text === 'string' ? text.trim() : '';
    const except = new Set([...(options?.exceptCameraIds ?? []), ...this.panelCameras]);
    const targets = (this.values().channelSpeakers ?? []).filter((id) => !except.has(id) && this.cameras.has(id));
    if (!phrase || phrase.length > MAX_NOTIFICATION_CHARS || this.inQuietHours()) return { said: [], skipped: targets };
    const results = await Promise.all(targets.map(async (id) => ({ id, result: await this.voice.say(id, phrase, 'owner') })));
    return { said: results.filter((r) => r.result.status === 'spoken').map((r) => r.id), skipped: results.filter((r) => r.result.status !== 'spoken').map((r) => r.id) };
  }

  // ---- door ----

  private doorRules(): DoorRule[] {
    const cameras = this.cameraOptions().map((c) => c.id);
    // a speaker that is offline for now stays in its rule: dropping the rule silenced every other room as well, and
    // saying into an offline camera only fails for that camera
    const speakers = [...this.cameras.values()]
      .filter((e) => speakerProblemCode(e.device) !== 'no_channel' && speakerProblemCode(e.device) !== 'channel_off')
      .map((e) => e.device.id);
    const rules: DoorRule[] = [];
    for (const values of this.values().doorRules ?? []) {
      if (values.enabled === false) continue;
      const checked = checkDoorRule(values, cameras, speakers);
      if (checked.value) rules.push(checked.value);
    }
    return rules;
  }

  private async describe(cameraId: string, language: Language, timeoutMs: number): Promise<string | undefined> {
    const entry = this.cameras.get(cameraId);
    if (!entry) return undefined;
    const data = await (entry.device.snapshotSource ?? entry.device.streamSource).snapshot();
    if (!data) return undefined;
    const result = await this.api.coreManager.assistantAsk({
      system:
        `Describe in ${LANGUAGE_NAMES[language]} who is at the door in this picture, in one short phrase said aloud at home, at most 10 words, e.g. ` +
        '"У двери курьер с коробкой". Only what is clearly visible; no guesses about identity. Answer as JSON {"say": "..."}.',
      prompt: 'Who is at the door?',
      images: [{ data: new Uint8Array(data), mimeType: 'image/jpeg' }],
      outputSchema: { type: 'object', properties: { say: { type: 'string', maxLength: 120 } }, required: ['say'] },
      timeoutMs,
    });
    if (!result.ok) return undefined;
    const say = saidText(result);
    return say && say.length <= 120 ? say : undefined;
  }

  // ---- notification channel ----

  /**
   * Speakers are listed as inactive on purpose: the server sends every general notification to all active devices of
   * all channels, and a camera that says every detection aloud at night is the opposite of what VOICE is for. An
   * automation that picks the speaker still reaches it (the server delivers addressed notifications to any device);
   * whether it speaks is the "Speakers for notifications" setting.
   *
   * The speakers belong to nobody: they are the household's, and only admins see and switch them (the server lets an
   * admin change any device). Owned by whoever the last fan-out named, they were the target of the assistant's "send
   * me a notification" and readable by any user, who could then make the camera say anything.
   */
  async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    if (ownerUserIds.length) return [];
    return this.speakerOptions().map((c) => this.device(c.id, c.name));
  }

  async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    if (!deviceId.startsWith(DEVICE_PREFIX)) return null;
    const entry = this.cameras.get(deviceId.slice(DEVICE_PREFIX.length));
    return entry && !speakerProblem(entry.device) ? this.device(entry.device.id, entry.device.name) : null;
  }

  async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    if (n.silent) return;
    const values = this.values();
    const enabled = new Set(values.channelSpeakers ?? []);
    const rewrite = new Set(values.channelRewrite ?? []);
    const text = [n.title, n.subtitle, n.body].filter((part) => part?.trim()).join('. ');
    if (!text) return;
    // a speaker is no reader of long texts: a page would hold the camera for minutes
    if (text.length > MAX_NOTIFICATION_CHARS) {
      this.logger.warn(`notification not said: ${text.length} characters, more than ${MAX_NOTIFICATION_CHARS}`);
      return;
    }
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        const cameraId = deviceId.slice(DEVICE_PREFIX.length);
        if (!deviceId.startsWith(DEVICE_PREFIX) || !enabled.has(cameraId)) return;
        if (n.severity !== Severity.Critical && this.inQuietHours()) return;
        const result = rewrite.has(cameraId)
          ? await this.voice.sayInstructed(cameraId, `Read this notification aloud as a short natural phrase: ${text}`)
          : await this.voice.say(cameraId, text, 'owner');
        if (result.status !== 'spoken') this.logger.warn(`notification on ${cameraId}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      }),
    );
  }

  async registerDevice(): Promise<NotifierDevice> {
    throw new Error('VOICE speakers are the cameras with a speaker; there is nothing to register');
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.setChannel(deviceId, false);
  }

  async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    if (typeof patch.active === 'boolean') await this.setChannel(deviceId, patch.active);
    return this.getDevice(deviceId);
  }

  private device(cameraId: string, name: string): NotifierDevice {
    const speaks = (this.values().channelSpeakers ?? []).includes(cameraId);
    return { id: `${DEVICE_PREFIX}${cameraId}`, ownerUserId: '', name: `${name} (VOICE)`, active: false, metadata: { speaks } };
  }

  private async setChannel(deviceId: string, on: boolean): Promise<void> {
    if (!deviceId.startsWith(DEVICE_PREFIX)) return;
    const cameraId = deviceId.slice(DEVICE_PREFIX.length);
    const current = new Set(this.values().channelSpeakers ?? []);
    if (on) current.add(cameraId);
    else current.delete(cameraId);
    await this.storage.setValue('channelSpeakers', [...current]);
  }

  private inQuietHours(): boolean {
    const v = this.values();
    return Boolean(activeInterval(quietHours(v.quietFrom, v.quietTo), Date.now(), this.timeZone()));
  }

  // ---- assistant tools ----

  assistantTools(): AssistantToolSpec[] {
    return TOOLS;
  }

  async callAssistantTool(name: string, input: Record<string, unknown>, _ctx: AssistantToolContext): Promise<AssistantToolResult> {
    return callTool(this.toolHost(), name, input ?? {});
  }

  toolHost(): ToolHost {
    return {
      voice: this.voice,
      cameras: (): ToolCamera[] =>
        [...this.cameras.values()].map((e) => ({
          id: e.device.id,
          name: e.device.name,
          zones: (e.device.zones?.object ?? []).map((z) => z.name),
          ...(speakerProblem(e.device) ? { problem: speakerProblem(e.device) } : {}),
        })),
      readScreenTime: (cameraId) => this.cameras.get(cameraId)?.storage.values?.screenTime ?? [],
      writeScreenTime: async (cameraId, values) => {
        const entry = this.cameras.get(cameraId);
        if (!entry) throw new Error(`unknown camera ${cameraId}`);
        // through the stored setting: the camera drawer shows exactly this, and its onSet applies it
        await entry.storage.setValue('screenTime', values);
      },
      pluginValues: () => this.values(),
      writePluginValue: async (key, value) => {
        await this.storage.setValue(key, value);
      },
    };
  }

  // ---- state ----

  private loadState(): SavedState {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as SavedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`VOICE state not read, starting fresh: ${(error as Error).message}`);
      return { screenTime: {} };
    }
  }

  /**
   * One write after the other, in the order asked: a parent's "more time" and a look wrote the same .tmp at once, one
   * rename found it gone and that state was lost, or an older state landed last. The chain only waits: a failed write
   * is the caller's, and the next one still runs.
   */
  private saveState(state: SavedState): Promise<void> {
    const data = JSON.stringify(state);
    const write = this.writing.then(async () => {
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.stateFile);
    });
    this.writing = write.catch(() => undefined);
    return write;
  }
}
