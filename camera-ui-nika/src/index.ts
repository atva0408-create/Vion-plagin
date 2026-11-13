import { randomUUID } from 'node:crypto';

import { API_EVENT, ServicePlugin } from '@camera.ui/sdk';

import { COMMANDS, COMMAND_NAMES, checkArgs, commandOf, runCommand } from './commands.js';
import { Discovery } from './discovery.js';
import { GRANT_MODES, Grants } from './grants.js';
import { NikaLink, Pairing } from './link.js';
import { journalText, nikaLabel, pageTexts, pendingLabel, pendingText, statusText } from './page.js';
import { DEFAULT_PORT, str } from './protocol.js';
import { langOf, texts } from './texts.js';
import { ASSISTANT_TOOLS } from './tools.js';

import type {
  AssistantToolContext,
  AssistantToolProvider,
  AssistantToolResult,
  AssistantToolSpec,
  DeviceStorage,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  Notification,
  NotifierDevice,
  NotifierInterface,
  PluginAPI,
} from '@camera.ui/sdk';
import type { VoicePort } from './commands.js';
import type { GrantMode, JournalEntry, PendingGrant } from './grants.js';
import type { Address, Call, CallResult, LinkHost, PairedNika } from './link.js';
import type { Message } from './protocol.js';
import type { Lang } from './texts.js';

// NIKA, the voice assistant of the home, and VION as one: VION finds every NIKA on the home network, connects her with a
// code she says aloud, and she says VION's notifications (a child who does not leave the computer); she asks VION for
// what she was told (more time) and VION asks the parents first. Everything about the link is on this page; NIKA's side
// is core/vion_link.py in her repository, the wire is described in protocol.ts.

export interface StorageValues {
  grants?: GrantMode;
  commands?: string[];
  _vionId?: string;
  _paired?: PairedNika[];
  _pending?: PendingGrant[];
  _journal?: JournalEntry[];
}

const VOICE_PLUGIN = '@vionvision/camera-ui-voice';
const DEVICE_PREFIX = 'nika:';
const EXPIRE_EVERY_MS = 30_000;
const SAY_TIMEOUT_MS = 20_000;
const NOTIFY_TIMEOUT_MS = 15_000;
const MAX_SAY_CHARS = 400;

/** Whether NIKA said a notification, and why not: VION keeps it and sends the notification another way. */
interface NikaDelivery {
  deviceId: string;
  ok: boolean;
  error?: string;
}

/** The SDK says sendNotification answers nothing; VION reads an answer per device (server manager/channels.ts). */
function answered(deliveries: NikaDelivery[]): void {
  return deliveries as unknown as void;
}

const asField = (schema: Record<string, unknown>) => schema as unknown as JsonSchemaWithoutCallbacks;

export default class NikaPlugin extends ServicePlugin<StorageValues> implements NotifierInterface, AssistantToolProvider {
  private discovery: Discovery;
  private links = new Map<string, NikaLink>();
  private grants: Grants;
  private pairing?: Pairing;
  private expireTimer?: NodeJS.Timeout;
  private started = false;
  /** the NIKA being connected was given by her address: she is looked for there, not on the network */
  private pairingManual = false;
  /** where each NIKA was last heard, for the log */
  private heardAt = new Map<string, string>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);
    this.discovery = this.createDiscovery();
    this.grants = new Grants({
      mode: () => this.grantMode(),
      run: (command, args, lang) => runCommand({ voice: () => this.voice() }, command, args, lang),
      publish: (notification) => this.api.notificationManager.publish(notification),
      tell: (nikaId, message) => this.tell(nikaId, message),
      save: async (pending, journal) => {
        await this.storage.setInternalValue('_pending', pending);
        await this.storage.setInternalValue('_journal', journal);
      },
      log: (message) => this.logger.log(message),
      now: () => Date.now(),
    });
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => void this.start());
    this.api.on(API_EVENT.SHUTDOWN, () => this.stop());
  }

  /** The network search; the specs give one without a socket. */
  protected createDiscovery(): Discovery {
    return new Discovery({ log: (message) => this.logger.log(message), onChange: () => this.heard() });
  }

  /** VOICE, which keeps the screen time; undefined when it is not installed or not running. */
  protected async voice(): Promise<VoicePort | undefined> {
    const voice = (await this.api.coreManager.connectToPlugin(VOICE_PLUGIN).catch(() => undefined)) as Partial<VoicePort> | undefined;
    return typeof voice?.callAssistantTool === 'function' ? (voice as VoicePort) : undefined;
  }

  // ---- settings page ------------------------------------------------------------------------------------------------

  public get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'status',
        title: 'NIKA in the home',
        description: 'Connected and found on the home network.',
        format: 'textarea',
        readonly: true,
        store: false,
        onGet: async () => this.statusText(),
      },
      {
        type: 'submit',
        key: 'connect',
        title: 'Connect NIKA',
        description: 'Choose a NIKA found on the network, or give her address. She says a code of 6 digits aloud: enter it here.',
        color: 'success',
        onClick: (values: unknown) => this.onConnect(values),
      },
      {
        type: 'submit',
        key: 'disconnect',
        title: 'Disconnect NIKA',
        description: 'VION and this NIKA forget each other; to link them again, connect her again.',
        color: 'danger',
        onClick: (values: unknown) => this.onDisconnect(values),
      },
      {
        type: 'string',
        key: 'grants',
        title: 'Permissions asked by voice',
        description: 'When someone tells NIKA to give a child more time. NIKA cannot tell a parent from a child by voice alone.',
        enum: GRANT_MODES,
        enumLabels: { confirm: 'A parent confirms (notification on the phone)', direct: 'Give at once and tell the parents' },
        defaultValue: 'confirm',
        store: true,
      },
      {
        type: 'string',
        key: 'commands',
        title: 'What NIKA may ask VION',
        description: 'NIKA learns these when she connects; unchecked ones she cannot ask for.',
        enum: COMMAND_NAMES,
        enumLabels: {
          screen_time_status: 'Screen time now',
          screen_time_report: 'Screen time report',
          screen_time_extend: 'Give more time (minutes, skip a break)',
          screen_time_until: 'Allow until a time',
        },
        multiple: true,
        defaultValue: COMMAND_NAMES,
        store: true,
        onSet: async () => this.offerAll(),
      },
      {
        type: 'string',
        key: 'pending',
        title: 'Requests waiting for a parent',
        description: 'What NIKA was asked to give. A request not answered in 10 minutes is refused.',
        format: 'textarea',
        readonly: true,
        store: false,
        onGet: async () => pendingText(this.pageLang(), this.grants.pending, Date.now(), this.pageZone()),
      },
      {
        type: 'submit',
        key: 'answer',
        title: 'Answer a request',
        description: 'Allow or refuse what NIKA was asked for; she tells the room.',
        onClick: (values: unknown) => this.onAnswer(values),
      },
      {
        type: 'string',
        key: 'journal',
        title: 'Journal',
        description: 'What NIKA was asked to give and what came of it, newest first.',
        format: 'textarea',
        readonly: true,
        store: false,
        onGet: async () => journalText(this.pageLang(), this.grants.journal, this.pageZone()),
      },
      {
        type: 'submit',
        key: 'sayPhrase',
        title: 'Say a phrase on NIKA',
        description: 'Checks the link: NIKA says your text aloud.',
        onClick: (values: unknown) => this.onSay(values),
      },
    ];
  }

  private grantMode(): GrantMode {
    const mode = this.storage.values.grants;
    return mode && (GRANT_MODES as string[]).includes(mode) ? mode : 'confirm';
  }

  private enabledCommands(): string[] {
    const chosen = this.storage.values.commands;
    return Array.isArray(chosen) ? chosen.filter((name) => COMMAND_NAMES.includes(name)) : COMMAND_NAMES;
  }

  private paired(): PairedNika[] {
    return [...(this.storage.values._paired ?? [])];
  }

  private async savePaired(paired: PairedNika[]): Promise<void> {
    await this.storage.setInternalValue('_paired', paired);
  }

  /** The language of the page's lines: the one of the first NIKA, Russian before any. */
  private pageLang(): Lang {
    const first = this.paired()[0];
    return langOf(this.links.get(first?.id ?? '')?.hello?.lang ?? first?.lang);
  }

  private page(): ReturnType<typeof pageTexts> {
    return pageTexts(this.pageLang());
  }

  private pageZone(): string | undefined {
    for (const link of this.links.values()) if (link.hello?.tz) return link.hello.tz;
    return undefined;
  }

  private statusText(): string {
    const views = this.paired().map((nika) => {
      const link = this.links.get(nika.id);
      return { nika, state: link?.state ?? 'offline', since: link?.onlineSince, error: link?.lastError };
    });
    return statusText(this.pageLang(), views, this.discovery.list(), this.pageZone());
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------

  /** Public for the specs. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.storage.values._vionId) await this.storage.setInternalValue('_vionId', randomUUID());
    this.grants.pending = [...(this.storage.values._pending ?? [])];
    this.grants.journal = [...(this.storage.values._journal ?? [])];
    this.discovery.start();
    for (const nika of this.paired()) this.link(nika);
    this.expireTimer = setInterval(() => void this.grants.expire(), EXPIRE_EVERY_MS);
    const count = this.paired().length;
    this.logger.log(`NIKA: ${count ? `${count} NIKA connected before, linking` : 'no NIKA connected yet: Plugins → NIKA → «Connect NIKA»'}`);
  }

  public stop(): void {
    this.started = false;
    clearInterval(this.expireTimer);
    this.expireTimer = undefined;
    this.pairing?.close();
    this.pairing = undefined;
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    this.discovery.stop();
  }

  private link(nika: PairedNika): NikaLink {
    this.links.get(nika.id)?.stop();
    const link = new NikaLink(nika, this.linkHost());
    this.links.set(nika.id, link);
    link.start();
    return link;
  }

  private linkHost(): LinkHost {
    return {
      vionId: this.storage.values._vionId ?? '',
      log: (message) => this.logger.log(message),
      address: (nika) => this.addressOf(nika),
      offer: () => this.offer(),
      onCall: (link, call) => this.onCall(link.nika, langOf(link.hello?.lang ?? link.nika.lang), call),
      onChange: (link) => void this.remember(link),
      onForgotten: (link) => void this.forgotten(link.nika),
    };
  }

  /** Where a paired NIKA is now: her address by hand, else what the network says, else where she was. */
  private async addressOf(nika: PairedNika): Promise<Address | undefined> {
    if (nika.manual && nika.host && nika.port) return { host: nika.host, port: nika.port };
    const found = await this.discovery.lookup(nika.id);
    if (found) return { host: found.host, port: found.port };
    return nika.host && nika.port ? { host: nika.host, port: nika.port } : undefined;
  }

  /** The network heard a NIKA: one of ours that is not connected may be at a new address. */
  private heard(): void {
    // once per NIKA and address: «is she seen at all» is the first question when she does not connect
    for (const nika of this.discovery.list()) {
      const where = `${nika.host}:${nika.port}`;
      if (this.heardAt.get(nika.id) === where) continue;
      this.heardAt.set(nika.id, where);
      this.logger.log(`NIKA: ${nikaLabel(nika)} heard on the network at ${where}${this.paired().some((one) => one.id === nika.id) ? '' : ' (not connected)'}`);
    }
    for (const link of this.links.values()) {
      if (link.online) continue;
      const found = this.discovery.get(link.nika.id);
      if (found && (found.host !== link.nika.host || found.port !== link.nika.port)) link.retryNow();
    }
  }

  /** What she says of herself and where she answered, kept for the next start. */
  private async remember(link: NikaLink): Promise<void> {
    const hello = link.hello;
    const paired = this.paired();
    const nika = paired.find((candidate) => candidate.id === link.nika.id);
    if (!nika || !hello || !link.online) return;
    const before = JSON.stringify(nika);
    nika.name = hello.name;
    nika.room = hello.room;
    nika.lang = hello.lang;
    nika.host = link.nika.host;
    nika.port = link.nika.port;
    link.nika = nika;
    if (JSON.stringify(nika) !== before) await this.savePaired(paired);
  }

  private async forgotten(nika: PairedNika): Promise<void> {
    this.links.get(nika.id)?.stop();
    this.links.delete(nika.id);
    await this.savePaired(this.paired().filter((candidate) => candidate.id !== nika.id));
    await this.grants.forget(nika.id);
    this.logger.warn(`NIKA ${nikaLabel(nika)} no longer knows this VION (she was reset or disconnected on her side): connect her again`);
  }

  private offer(): Message {
    const enabled = new Set(this.enabledCommands());
    return {
      t: 'offer',
      commands: COMMANDS.filter((command) => enabled.has(command.name)).map(({ name, description, parameters, grant }) => ({ name, description, parameters, grant })),
      grants: this.grantMode(),
    };
  }

  private async offerAll(): Promise<void> {
    for (const link of this.links.values()) {
      if (!link.online) continue;
      try {
        link.send(this.offer());
      } catch (error) {
        this.logger.warn(`NIKA ${link.nika.name}: the new list of commands was not sent: ${(error as Error).message}`);
      }
    }
  }

  private tell(nikaId: string, message: Message): boolean {
    const link = this.links.get(nikaId);
    if (!link?.online) return false;
    try {
      link.send(message);
      return true;
    } catch {
      return false;
    }
  }

  /** What NIKA asked for. Public for the specs. */
  public async onCall(nika: PairedNika, lang: Lang, call: Call): Promise<CallResult> {
    const t = texts(lang);
    const command = commandOf(call.name);
    if (!command) return { ok: false, error: t.unknownCommand(call.name) };
    if (!this.enabledCommands().includes(command.name)) return { ok: false, error: t.commandOff };
    const checked = checkArgs(command.name, call.args, lang);
    if ('error' in checked) return { ok: false, error: checked.error };
    if (command.grant) return this.grants.request({ id: nika.id, name: nikaLabel(nika), lang }, command.name, checked.args, call.speaker);
    return runCommand({ voice: () => this.voice() }, command.name, checked.args, lang);
  }

  // ---- connecting ---------------------------------------------------------------------------------------------------

  private async onConnect(raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const lang = this.pageLang();
    if (typeof values.code === 'string' && values.code.trim()) return this.finishPairing(values.code, lang);
    if (typeof values.nika === 'string' && values.nika) return this.startPairing(values.nika, str(values.address));
    const paired = new Map(this.paired().map((nika) => [nika.id, nika]));
    // a NIKA connected now is not offered again; one that lost the link may be connected anew
    const offered = this.discovery.list().filter((nika) => !this.links.get(nika.id)?.online || !paired.has(nika.id));
    return {
      schema: [
        asField({
          type: 'string',
          key: 'nika',
          title: 'NIKA',
          description: 'Found on the home network, or by her address when she is not in the list.',
          enum: [...offered.map((nika) => nika.id), 'address'],
          enumLabels: { address: 'By address', ...Object.fromEntries(offered.map((nika) => [nika.id, `${nikaLabel(nika)} (${nika.host})`])) },
          defaultValue: offered[0]?.id ?? 'address',
          required: true,
        }),
        asField({
          type: 'string',
          key: 'address',
          title: 'Address of NIKA',
          description: 'For example 192.168.1.50, or 192.168.1.50:8796 with her port.',
          placeholder: '192.168.1.50',
          condition: { key: 'nika', value: 'address' },
        }),
      ],
    };
  }

  private async startPairing(choice: string, addressText: string): Promise<FormSubmitResponse> {
    let address: Address;
    let manual = false;
    if (choice === 'address') {
      const parsed = parseAddress(addressText);
      if (!parsed) return { toast: { type: 'error', message: this.page().addressNeeded } };
      address = parsed;
      manual = true;
    } else {
      const found = this.discovery.get(choice) ?? (await this.discovery.lookup(choice));
      if (!found) return { toast: { type: 'error', message: this.page().notHeard } };
      address = { host: found.host, port: found.port };
    }
    this.pairing?.close();
    this.pairing = undefined;
    try {
      this.pairing = await Pairing.start(address, this.storage.values._vionId ?? '', 'VION');
    } catch (error) {
      return { toast: { type: 'error', message: `NIKA: ${(error as Error).message}` } };
    }
    this.pairingManual = manual;
    return {
      toast: { type: 'info', message: this.page().sayingCode },
      schema: [
        asField({
          type: 'string',
          key: 'code',
          title: 'Code',
          description: 'The 6 digits NIKA said. She waits 5 minutes.',
          required: true,
          minLength: 6,
          maxLength: 6,
        }),
      ],
    };
  }

  private async finishPairing(code: string, lang: Lang): Promise<FormSubmitResponse | void> {
    const t = pageTexts(lang);
    const pairing = this.pairing;
    if (!pairing?.open) return { toast: { type: 'error', message: this.page().pairingOver } };
    let answer: { token: string } | { left: number };
    try {
      answer = await pairing.submit(code);
    } catch (error) {
      this.pairing = undefined;
      return { toast: { type: 'error', message: `NIKA: ${(error as Error).message}` } };
    }
    if ('left' in answer) {
      if (!answer.left) {
        this.pairing = undefined;
        return { toast: { type: 'error', message: t.codeWrongLast } };
      }
      return {
        toast: { type: 'error', message: t.codeWrong(answer.left) },
        schema: [
          asField({
            type: 'string',
            key: 'code',
            title: 'Code',
            description: 'The 6 digits NIKA said. She waits 5 minutes.',
            required: true,
            minLength: 6,
            maxLength: 6,
          }),
        ],
      };
    }
    this.pairing = undefined;
    const hello = pairing.hello;
    const nika: PairedNika = {
      id: hello.id,
      name: hello.name,
      room: hello.room,
      token: answer.token,
      host: pairing.address.host,
      port: pairing.address.port,
      ...(this.pairingManual ? { manual: true } : {}),
      speaks: true,
      pairedAt: Date.now(),
      lang: hello.lang,
    };
    await this.savePaired([...this.paired().filter((other) => other.id !== nika.id), nika]);
    this.link(nika);
    this.logger.log(`NIKA ${nikaLabel(nika)}: connected to this VION`);
    return { toast: { type: 'success', message: t.connected(nikaLabel(nika)) } };
  }

  private async onDisconnect(raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const paired = this.paired();
    if (!paired.length) return { toast: { type: 'error', message: this.page().noneConnected } };
    if (typeof values.nika !== 'string' || !values.nika) {
      return {
        schema: [
          asField({
            type: 'string',
            key: 'nika',
            title: 'NIKA',
            description: 'Which NIKA to disconnect.',
            enum: paired.map((nika) => nika.id),
            enumLabels: Object.fromEntries(paired.map((nika) => [nika.id, nikaLabel(nika)])),
            defaultValue: paired[0].id,
            required: true,
          }),
        ],
      };
    }
    const nika = paired.find((candidate) => candidate.id === values.nika);
    if (!nika) return { toast: { type: 'error', message: this.page().noSuch } };
    await this.unpair(nika);
    return { toast: { type: 'success', message: pageTexts(this.pageLang()).unpaired(nikaLabel(nika)) } };
  }

  private async unpair(nika: PairedNika): Promise<void> {
    const link = this.links.get(nika.id);
    // she forgets the key too, when she hears it; otherwise she keeps a key nobody holds any more
    if (link?.online) {
      try {
        link.send({ t: 'unpair' });
      } catch {
        this.logger.warn(`NIKA ${nikaLabel(nika)}: was not told she is disconnected`);
      }
    }
    link?.stop();
    this.links.delete(nika.id);
    await this.savePaired(this.paired().filter((candidate) => candidate.id !== nika.id));
    await this.grants.forget(nika.id);
    this.logger.log(`NIKA ${nikaLabel(nika)}: disconnected from this VION`);
  }

  // ---- answering, saying --------------------------------------------------------------------------------------------

  private async onAnswer(raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const pending = this.grants.pending;
    if (!pending.length) return { toast: { type: 'info', message: this.page().noRequests } };
    if (typeof values.request !== 'string' || !values.request) {
      return {
        schema: [
          asField({
            type: 'string',
            key: 'request',
            title: 'Request',
            description: 'What NIKA was asked for.',
            enum: pending.map((grant) => grant.id),
            enumLabels: Object.fromEntries(pending.map((grant) => [grant.id, pendingLabel(grant, this.pageZone())])),
            defaultValue: pending[pending.length - 1].id,
            required: true,
          }),
          asField({
            type: 'string',
            key: 'decision',
            title: 'Answer',
            description: 'NIKA tells the room.',
            enum: ['allow', 'refuse'],
            enumLabels: { allow: 'Allow', refuse: 'Refuse' },
            defaultValue: 'allow',
            required: true,
          }),
        ],
      };
    }
    const result = await this.grants.decide(values.request, values.decision !== 'refuse', 'page');
    return result.ok ? { toast: { type: 'success', message: result.text } } : { toast: { type: 'error', message: this.page().noRequest } };
  }

  private async onSay(raw: unknown): Promise<FormSubmitResponse | void> {
    const values = (raw ?? {}) as Record<string, unknown>;
    const online = [...this.links.values()].filter((link) => link.online);
    if (!online.length) return { toast: { type: 'error', message: this.page().noneOnline } };
    if (typeof values.phrase !== 'string' || !values.phrase.trim()) {
      return {
        schema: [
          asField({
            type: 'string',
            key: 'nika',
            title: 'NIKA',
            description: 'Who says it.',
            enum: online.map((link) => link.nika.id),
            enumLabels: Object.fromEntries(online.map((link) => [link.nika.id, nikaLabel(link.nika)])),
            defaultValue: online[0].nika.id,
            required: true,
          }),
          asField({ type: 'string', key: 'phrase', title: 'Phrase', description: 'What NIKA says.', required: true, maxLength: MAX_SAY_CHARS }),
        ],
      };
    }
    const link = this.links.get(str(values.nika)) ?? online[0];
    const t = pageTexts(this.pageLang());
    const result = await this.say(link, values.phrase);
    return result.ok
      ? { toast: { type: 'success', message: t.said(nikaLabel(link.nika)) } }
      : { toast: { type: 'error', message: t.notSaid(nikaLabel(link.nika), result.error ?? '') } };
  }

  private async say(link: NikaLink, phrase: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ack = await link.request({ t: 'say', text: phrase.trim().slice(0, MAX_SAY_CHARS) }, SAY_TIMEOUT_MS);
      return { ok: ack.ok === true, ...(ack.ok === true ? {} : { error: str(ack.error) || 'she did not say why' }) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  // ---- notifier -----------------------------------------------------------------------------------------------------

  private deviceOf(nika: PairedNika, owner: string): NotifierDevice {
    const link = this.links.get(nika.id);
    return {
      id: `${DEVICE_PREFIX}${nika.id}`,
      ownerUserId: owner,
      name: nika.label ?? nikaLabel(nika),
      active: nika.speaks,
      metadata: { online: link?.online ?? false, room: nika.room },
    };
  }

  async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    // a NIKA is the home's, no one's own (as a station of Alice): the fan-out delivers only to devices of the people it
    // names, so she counts as the first one's
    const owner = ownerUserIds[0] ?? '';
    return this.paired().map((nika) => this.deviceOf(nika, owner));
  }

  async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    const nika = this.paired().find((candidate) => `${DEVICE_PREFIX}${candidate.id}` === deviceId);
    return nika ? this.deviceOf(nika, '') : null;
  }

  /**
   * NIKA says the notification aloud: its title, then its words. Whether each NIKA took it goes back to VION, which
   * sends the notification another way when no device got it.
   */
  async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    const text = [n.title, n.subtitle, n.body]
      .filter(Boolean)
      .map((part) => String(part).replace(/[.!?…]+$/, ''))
      .join('. ');
    // a silent notification is for a phone's screen; NIKA's own requests to the parents are for the parents' phones,
    // not for the room she asks in: neither is a word to say, and nothing failed
    if (n.silent || !text || (n.tag ?? '').startsWith('nika:')) return answered(deviceIds.map((deviceId) => ({ deviceId, ok: true })));
    const deliveries = await Promise.all(
      deviceIds.map(async (deviceId): Promise<NikaDelivery> => {
        const id = deviceId.startsWith(DEVICE_PREFIX) ? deviceId.slice(DEVICE_PREFIX.length) : '';
        const nika = this.paired().find((candidate) => candidate.id === id);
        if (!nika) return { deviceId, ok: false, error: 'no such NIKA' };
        if (!nika.speaks) return { deviceId, ok: false, error: 'saying notifications is off for this NIKA' };
        const link = this.links.get(id);
        if (!link?.online) return { deviceId, ok: false, error: `NIKA is not connected${link?.lastError ? `: ${link.lastError}` : ''}` };
        try {
          const ack = await link.request(
            { t: 'notify', title: n.title, ...(n.body ? { body: n.body } : {}), text, severity: n.severity ?? 'info', ...(n.tag ? { tag: n.tag } : {}) },
            NOTIFY_TIMEOUT_MS,
          );
          return ack.ok === true ? { deviceId, ok: true } : { deviceId, ok: false, error: str(ack.error) || 'NIKA did not say why' };
        } catch (error) {
          return { deviceId, ok: false, error: (error as Error).message };
        }
      }),
    );
    return answered(deliveries);
  }

  async registerDevice(): Promise<NotifierDevice> {
    throw new Error('NIKA is connected on the page of the NIKA plugin: Plugins → NIKA → «Connect NIKA»');
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.updateDevice(deviceId, { active: false });
  }

  async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const paired = this.paired();
    const nika = paired.find((candidate) => `${DEVICE_PREFIX}${candidate.id}` === deviceId);
    if (!nika) return null;
    if (typeof patch.active === 'boolean') nika.speaks = patch.active;
    if (typeof patch.name === 'string' && patch.name.trim()) nika.label = patch.name.trim().slice(0, 64);
    await this.savePaired(paired);
    const link = this.links.get(nika.id);
    if (link) link.nika = nika;
    return this.deviceOf(nika, '');
  }

  // ---- assistant ----------------------------------------------------------------------------------------------------

  assistantTools(): AssistantToolSpec[] {
    return ASSISTANT_TOOLS;
  }

  async callAssistantTool(name: string, input: Record<string, unknown>, _ctx: AssistantToolContext): Promise<AssistantToolResult> {
    try {
      switch (name) {
        case 'nika_status':
          return { content: this.statusOf() };
        case 'nika_connect':
          return await this.toolConnect(input);
        case 'nika_disconnect': {
          const nika = this.findPaired(input.nika);
          if ('error' in nika) return nika;
          await this.unpair(nika);
          return { content: { disconnected: nikaLabel(nika) } };
        }
        case 'nika_settings':
          return await this.toolSettings(input);
        case 'nika_answer': {
          if (typeof input.request !== 'string') return { error: `request: one of ${this.grants.pending.map((grant) => grant.id).join(', ') || 'none (nothing waits)'}` };
          if (typeof input.allow !== 'boolean') return { error: 'allow: true or false' };
          const result = await this.grants.decide(input.request, input.allow, 'chat');
          return result.ok ? { content: { told: result.text } } : { error: result.error };
        }
        case 'nika_say': {
          const phrase = typeof input.text === 'string' ? input.text.trim() : '';
          if (!phrase) return { error: 'text is required' };
          const online = [...this.links.values()].filter((link) => link.online);
          if (!online.length) return { error: 'No NIKA is connected now (nika_status says why)' };
          let link = online[0];
          if (input.nika !== undefined) {
            const nika = this.findPaired(input.nika);
            if ('error' in nika) return nika;
            const chosen = this.links.get(nika.id);
            if (!chosen?.online) return { error: `${nikaLabel(nika)} is not connected now` };
            link = chosen;
          }
          const result = await this.say(link, phrase);
          return result.ok ? { content: { said: true, nika: nikaLabel(link.nika) } } : { error: `not said: ${result.error}` };
        }
        default:
          return { error: `Unknown tool ${name}` };
      }
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  private statusOf(): Record<string, unknown> {
    const paired = this.paired();
    return {
      connected: paired.map((nika) => {
        const link = this.links.get(nika.id);
        return {
          id: nika.id,
          name: nikaLabel(nika),
          online: link?.online ?? false,
          ...(link?.online ? {} : { why: link?.lastError ?? 'connecting' }),
          address: nika.host ? `${nika.host}:${nika.port}` : undefined,
          saysNotifications: nika.speaks,
        };
      }),
      foundNotConnected: this.discovery
        .list()
        .filter((nika) => !paired.some((other) => other.id === nika.id))
        .map((nika) => ({ id: nika.id, name: nikaLabel(nika), address: `${nika.host}:${nika.port}` })),
      grants: this.grantMode(),
      commands: this.enabledCommands(),
      pending: this.grants.pending.map((grant) => ({
        request: grant.id,
        nika: grant.nikaName,
        what: grant.summary,
        ...(grant.speaker ? { askedBy: grant.speaker } : {}),
        at: new Date(grant.at).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
      })),
      journal: this.grants.journal.slice(0, 20).map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
      connecting: this.pairing?.open ? { nika: nikaLabel(this.pairing.hello), waitsForCode: true } : undefined,
    };
  }

  private findPaired(value: unknown): PairedNika | { error: string } {
    const paired = this.paired();
    const list = paired.map((nika) => `"${nikaLabel(nika)}"`).join(', ') || 'none';
    if (value === undefined && paired.length === 1) return paired[0];
    const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!wanted) return { error: `nika: which one? Connected: ${list}` };
    const found =
      paired.find((nika) => nika.id === value || nikaLabel(nika).toLowerCase() === wanted) ??
      paired.find((nika) => nikaLabel(nika).toLowerCase().includes(wanted) || (nika.label ?? '').toLowerCase().includes(wanted));
    return found ?? { error: `No connected NIKA "${String(value)}". Connected: ${list}` };
  }

  private async toolConnect(input: Record<string, unknown>): Promise<AssistantToolResult> {
    const lang = this.pageLang();
    if (typeof input.code === 'string' && input.code.trim()) {
      const response = await this.finishPairing(input.code, lang);
      const toast = response?.toast;
      if (toast?.type === 'success') return { content: { connected: true, message: toast.message } };
      return { error: toast?.message ?? 'not connected' };
    }
    let choice: string;
    let address = '';
    if (typeof input.address === 'string' && input.address.trim()) {
      choice = 'address';
      address = input.address;
    } else {
      const found = this.discovery.list();
      const wanted = typeof input.nika === 'string' ? input.nika.trim().toLowerCase() : '';
      const nika = wanted
        ? (found.find((candidate) => candidate.id === input.nika) ?? found.find((candidate) => nikaLabel(candidate).toLowerCase().includes(wanted)))
        : found.length === 1
          ? found[0]
          : undefined;
      if (!nika) {
        return {
          error: found.length
            ? `nika: which one? Found: ${found.map((candidate) => `"${nikaLabel(candidate)}"`).join(', ')}`
            : 'No NIKA was found on the network. Ask whether she is on and in the same network, or ask for her address (address).',
        };
      }
      choice = nika.id;
    }
    const response = await this.startPairing(choice, address);
    if (response.toast?.type === 'error') return { error: response.toast.message };
    return {
      content: {
        nika: this.pairing ? nikaLabel(this.pairing.hello) : undefined,
        codeSaid: true,
        next: 'NIKA said a 6-digit code aloud: ask the owner for it and call nika_connect with code within 5 minutes.',
      },
    };
  }

  private async toolSettings(input: Record<string, unknown>): Promise<AssistantToolResult> {
    if (input.grants !== undefined) {
      if (!(GRANT_MODES as unknown[]).includes(input.grants)) return { error: `grants: ${GRANT_MODES.join(' or ')}` };
      await this.storage.setValue('grants', input.grants as GrantMode);
    }
    if (input.commands !== undefined) {
      if (!Array.isArray(input.commands) || input.commands.some((name) => !COMMAND_NAMES.includes(String(name))))
        return { error: `commands: some of ${COMMAND_NAMES.join(', ')}` };
      await this.storage.setValue('commands', input.commands.map(String));
      await this.offerAll();
    }
    if (input.saysNotifications !== undefined) {
      if (typeof input.saysNotifications !== 'boolean') return { error: 'saysNotifications: true or false' };
      const nika = this.findPaired(input.nika);
      if ('error' in nika) return nika;
      await this.updateDevice(`${DEVICE_PREFIX}${nika.id}`, { active: input.saysNotifications });
    }
    return { content: { saved: true, grants: this.grantMode(), commands: this.enabledCommands(), note: 'The same values are on the page Plugins → NIKA.' } };
  }
}

/** «192.168.1.50», «192.168.1.50:8796», «nika.local:8796»; undefined for anything else. */
export function parseAddress(text: string): Address | undefined {
  const value = text.trim();
  const match = /^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return undefined;
  const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
  if (!(port > 0 && port < 65536)) return undefined;
  return { host: match[1], port };
}
