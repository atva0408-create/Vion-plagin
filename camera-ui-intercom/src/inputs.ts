/**
 * What the interface and the assistant send to make or change a panel, a person, an instruction or a guest code,
 * checked by one function each (ТЗ 2.4): both see the same errors and save the same objects. Names are accepted where
 * an id is wanted ("Калитка", "Маша"), because the assistant knows names; ambiguity is an error, never a guess.
 */
import { randomUUID } from 'node:crypto';

import { instantOf, isClock, localTime } from '@vionvision/speech';

import { hashSecret } from './codes.js';
import { findCompany } from './companies.js';
import { normalizePlate } from './identify.js';
import { EVERY_DAY, windowMinutes } from './schedule.js';
import { CATEGORIES } from './types.js';

import type { Day } from '@vionvision/speech';
import type { PanelProfile } from './panels/profile.js';
import type { Category, Instruction, InstructionWhen, Panel, PanelDoor, Person, PersonAccess, Role, Strength } from './types.js';

export type Checked<T> = { value: T; warnings: string[]; errors?: undefined } | { value?: undefined; errors: string[] };

export const MAX_ACTIVE_INSTRUCTIONS = 50;
const MAX_WINDOW_DAYS = 31;
const ROLES: Role[] = ['family', 'friend', 'staff', 'service', 'blocked', 'other'];

const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const list = (value: unknown, max = 20) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((v) => typeof v === 'string' && v.trim())
            .map((v: string) => v.trim())
            .slice(0, max),
        ),
      ]
    : typeof value === 'string' && value.trim()
      ? [value.trim()]
      : [];
const fold = (text: string) => text.toLowerCase().replace(/ё/g, 'е').trim();
/** A key given: `undefined` counts as not given (the assistant's tools pass every key of their schema). */
const has = (object: Record<string, unknown>, key: string) => object[key] !== undefined;

/** The one item an id or a name points at; an error when none or several do. */
export function resolve<T extends { id: string; name: string }>(items: T[], ref: string, what: string, errors: string[]): T | undefined {
  const byId = items.find((item) => item.id === ref);
  if (byId) return byId;
  const named = items.filter((item) => fold(item.name) === fold(ref));
  if (named.length === 1) return named[0];
  errors.push(named.length ? `${what} "${ref}": several have this name, give the id` : `${what} "${ref}" is not known`);
  return undefined;
}

// ---- time ----

/** A moment as given: milliseconds, an ISO time with its offset, or "YYYY-MM-DDTHH:MM" on the household's clock. */
export function parseMoment(value: unknown, timeZone: string): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(value.trim());
  if (local) return isClock(local[2]) ? instantOf(local[1], local[2], timeZone) : undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** "Today" when the owner named no time: until 23:00 today, or three hours from now when it is later than that. */
export function defaultWindow(now: number, timeZone: string): { from: number; to: number } {
  const today = localTime(now, timeZone).date;
  const evening = instantOf(today, '23:00', timeZone);
  return { from: now, to: evening - now >= 60 * 60_000 ? evening : now + 3 * 60 * 60_000 };
}

function checkWhen(raw: unknown, now: number, timeZone: string, errors: string[]): InstructionWhen | undefined {
  if (raw === undefined || raw === null) return { kind: 'window', ...defaultWindow(now, timeZone) };
  const w = raw as Record<string, unknown>;
  if (Array.isArray(w.days)) {
    const days = w.days.filter((d) => (EVERY_DAY as string[]).includes(d as string)) as Day[];
    if (!days.length) errors.push('when.days: mon … sun');
    if (!isClock(w.from) || !isClock(w.to)) {
      errors.push('when: from and to as HH:MM for a weekly window');
      return undefined;
    }
    if (windowMinutes({ days, from: w.from, to: w.to }) <= 0 || w.from === w.to) errors.push('when: from and to are the same');
    const until = w.until === undefined || w.until === null || w.until === '' ? undefined : parseMoment(w.until, timeZone);
    if (w.until && until === undefined) errors.push('when.until: a date and time');
    return { kind: 'weekly', days, from: w.from, to: w.to, ...(until !== undefined ? { until } : {}) };
  }
  const from = w.from === undefined || w.from === '' ? now : parseMoment(w.from, timeZone);
  const to = parseMoment(w.to, timeZone);
  if (from === undefined) errors.push('when.from: a date and time');
  if (to === undefined) errors.push('when.to: a date and time');
  if (from === undefined || to === undefined) return undefined;
  if (to <= from) errors.push('when: the end is before the start');
  if (to <= now) errors.push('when: the window is over already');
  if (to - from > MAX_WINDOW_DAYS * 24 * 60 * 60_000) errors.push(`when: at most ${MAX_WINDOW_DAYS} days; repeat weekly for longer`);
  return { kind: 'window', from, to };
}

// ---- instructions ----

export interface InstructionWorld {
  now: number;
  timeZone: string;
  panels: Panel[];
  people: Person[];
  /** active instructions, for the limit */
  activeCount: number;
  /** may the author open these doors (the instruction opens only what its author could) */
  mayOpen(panel: Panel): boolean;
}

/** A message that looks like a secret: digits, a key, a code, an address, an absence. */
const SECRET = /\d|ключ|код|пароль|адрес|под ковр|у сосед|нас не|не будет|key|code|password|address|under the|neighbou?r|schlüssel|passwort|nachbar/iu;

export function looksSecret(text: string | undefined): boolean {
  return Boolean(text && SECRET.test(text));
}

/**
 * An instruction of the owner, checked. Opening wants a strong identification (a face, a plate, a code) unless the
 * owner agreed to a weak one (`openOnWeak`, shown red in the card); an instruction that only says something is fine
 * with a weak one, with a warning when the message looks like a secret.
 */
export function checkInstruction(input: Record<string, unknown>, author: string, world: InstructionWorld, previous?: Instruction): Checked<Instruction> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const textOf = str(input.text, 500) ?? previous?.text;
  if (!textOf) errors.push('text: what the owner said is missing');

  let panels: Instruction['panels'] = previous?.panels ?? 'all';
  if (has(input, 'panels')) {
    const refs = input.panels === 'all' || input.panels === undefined || input.panels === null ? 'all' : list(input.panels);
    if (refs === 'all' || !refs.length) panels = 'all';
    else {
      const found = refs.map((ref) => resolve(world.panels, ref, 'panel', errors)).filter((p): p is Panel => Boolean(p));
      panels = found.map((p) => p.id);
    }
  }
  const panelList = panels === 'all' ? world.panels : world.panels.filter((p) => panels.includes(p.id));
  const when = has(input, 'when') || !previous ? checkWhen(input.when, world.now, world.timeZone, errors) : previous.when;

  const e = (input.expect ?? {}) as Record<string, unknown>;
  const was = previous?.expect;
  const label = str(e.label, 80) ?? was?.label;
  if (!label) errors.push('expect.label: who is expected ("курьер Озона", "Маша"), or "*" for anyone');
  let category: Category | undefined = was?.category;
  if (has(e, 'category')) {
    if (e.category === null || e.category === '') category = undefined;
    else if ((CATEGORIES as readonly unknown[]).includes(e.category)) category = e.category as Category;
    else errors.push(`expect.category: one of ${CATEGORIES.join(', ')}`);
  }
  const companies = has(e, 'companies') ? list(e.companies).map((c) => findCompany(c)?.name ?? c) : (was?.companies ?? []);
  const names = has(e, 'names') ? list(e.names) : (was?.names ?? []);
  const personIds = has(e, 'people')
    ? list(e.people)
        .map((ref) => resolve(world.people, ref, 'person', errors)?.id)
        .filter((id): id is string => Boolean(id))
    : (was?.personIds ?? []);
  const plates = has(e, 'plates') ? list(e.plates).map(normalizePlate) : (was?.plates ?? []);
  if (!category && companies.length) category = findCompany(companies[0])?.category;

  const doorsOf = (refs: string[], what: string) => {
    const doors: string[] = [];
    for (const ref of refs) {
      const matches = panelList.flatMap((panel) => panel.doors.filter((door) => door.id === ref || fold(door.name) === fold(ref)).map((door) => ({ panel, door })));
      if (!matches.length) errors.push(`${what}: door "${ref}" is not on the panels of the instruction`);
      for (const { panel, door } of matches) {
        if (!world.mayOpen(panel)) errors.push(`${what}: you may not open "${door.name}" of ${panel.name}`);
        doors.push(door.id);
      }
    }
    return [...new Set(doors)];
  };
  const open = has(input, 'open') ? doorsOf(list(input.open), 'open') : (previous?.open ?? []);
  const neverOpen = typeof input.neverOpen === 'boolean' ? input.neverOpen : (previous?.neverOpen ?? false);
  const exceptFamily = typeof input.exceptFamily === 'boolean' ? input.exceptFamily : previous?.exceptFamily;
  const openOnWeak = typeof input.openOnWeak === 'boolean' ? input.openOnWeak : (previous?.openOnWeak ?? false);
  if (open.length && neverOpen) errors.push('open and neverOpen together');

  const say = has(input, 'say') ? str(input.say, 300) : previous?.say;
  const ask = has(input, 'ask') ? list(input.ask, 3).map((q) => q.slice(0, 200)) : (previous?.ask ?? []);
  const sayVerbatim = typeof input.sayVerbatim === 'boolean' ? input.sayVerbatim : (previous?.sayVerbatim ?? looksSecret(say));
  const guestCode = input.guestCode === true;
  const strongWays = personIds.length + plates.length + (guestCode || was?.guestCodeId ? 1 : 0);

  let minIdentification: Strength = previous?.minIdentification ?? 'weak';
  if (input.minIdentification === 'strong' || input.minIdentification === 'weak') minIdentification = input.minIdentification;
  else if (open.length && !openOnWeak) minIdentification = 'strong';
  if (minIdentification === 'strong' && !strongWays) {
    errors.push(
      open.length
        ? 'opening needs a person known by face, a plate or a guest code; or the owner agrees that it opens for anyone who names themselves (openOnWeak)'
        : 'a strong identification needs a person known by face, a plate or a guest code',
    );
  }
  if (open.length && openOnWeak && minIdentification === 'weak') warnings.push('the door opens for anyone who names themselves as expected');
  if (minIdentification === 'weak' && looksSecret(say)) {
    warnings.push('the message looks like a secret (a code, a key, an address, an absence) and is said to anyone who names themselves as expected');
  }
  if (plates.length) warnings.push('a plate can be faked; add a guest code when it matters');

  const callOwner = ['no', 'yes', 'if_needed'].includes(input.callOwner as string) ? (input.callOwner as Instruction['callOwner']) : (previous?.callOwner ?? 'if_needed');
  const notify = ['none', 'quiet', 'normal', 'urgent'].includes(input.notify as string) ? (input.notify as Instruction['notify']) : (previous?.notify ?? 'normal');
  const record = typeof input.record === 'boolean' ? input.record : (previous?.record ?? true);
  const once = typeof input.once === 'boolean' ? input.once : (previous?.once ?? when?.kind !== 'weekly');
  if (!previous && world.activeCount >= MAX_ACTIVE_INSTRUCTIONS) errors.push(`at most ${MAX_ACTIVE_INSTRUCTIONS} active instructions; cancel old ones first`);
  if (!say && !ask.length && !open.length && !neverOpen && callOwner === 'if_needed' && notify === 'normal') {
    warnings.push('the instruction says, asks and opens nothing: the visit is only marked as expected');
  }
  if (errors.length || !when || !label || !textOf) return { errors };

  return {
    value: {
      id: previous?.id ?? randomUUID(),
      createdBy: previous?.createdBy ?? author,
      createdAt: previous?.createdAt ?? world.now,
      ...(previous?.threadId ? { threadId: previous.threadId } : {}),
      text: textOf,
      panels,
      when,
      once,
      expect: {
        label,
        ...(category ? { category } : {}),
        ...(companies.length ? { companies } : {}),
        ...(names.length ? { names } : {}),
        ...(personIds.length ? { personIds } : {}),
        ...(plates.length ? { plates } : {}),
        ...(was?.guestCodeId ? { guestCodeId: was.guestCodeId } : {}),
      },
      minIdentification,
      ...(say ? { say } : {}),
      sayVerbatim,
      ...(ask.length ? { ask } : {}),
      ...(open.length ? { open } : {}),
      ...(openOnWeak ? { openOnWeak } : {}),
      ...(neverOpen ? { neverOpen } : {}),
      ...(exceptFamily !== undefined ? { exceptFamily } : {}),
      callOwner,
      notify,
      record,
    },
    warnings,
  };
}

// ---- people ----

export function checkPerson(input: Record<string, unknown>, panels: Panel[], previous?: Person): Checked<Person> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = str(input.name, 60) ?? previous?.name;
  if (!name) errors.push('name');
  const role = has(input, 'role') ? (input.role as Role) : (previous?.role ?? 'other');
  if (!ROLES.includes(role)) errors.push(`role: one of ${ROLES.join(', ')}`);
  const faceNames = has(input, 'faceNames') ? list(input.faceNames, 5) : (previous?.faceNames ?? []);
  const plates = has(input, 'plates') ? list(input.plates, 5).map(normalizePlate) : (previous?.plates ?? []);
  let pinHash = previous?.pinHash;
  if (has(input, 'pin')) {
    if (input.pin === '' || input.pin === null) pinHash = undefined;
    else if (typeof input.pin === 'string' && /^\d{4,8}$/.test(input.pin)) {
      const { hash, salt } = hashSecret(input.pin);
      pinHash = `${salt}:${hash}`;
    } else errors.push('pin: 4 to 8 digits');
  }
  let access: PersonAccess[] = previous?.access ?? [];
  if (has(input, 'access')) {
    access = [];
    const raw = Array.isArray(input.access) ? input.access : [];
    raw.forEach((item, i) => {
      const a = (item ?? {}) as Record<string, unknown>;
      const days = (a.days === undefined ? EVERY_DAY : list(a.days, 7).filter((d) => (EVERY_DAY as string[]).includes(d))) as Day[];
      const from = a.from ?? '00:00';
      const to = a.to ?? '00:00';
      if (!isClock(from) || !isClock(to)) {
        errors.push(`access[${i}]: from and to as HH:MM`);
        return;
      }
      const doors: string[] = [];
      for (const ref of list(a.doors)) {
        const found = panels.flatMap((panel) => panel.doors).filter((door) => door.id === ref || fold(door.name) === fold(ref));
        if (!found.length) errors.push(`access[${i}]: door "${ref}" is not known`);
        doors.push(...found.map((door) => door.id));
      }
      if (!doors.length) errors.push(`access[${i}]: which doors`);
      if (!days.length) errors.push(`access[${i}]: days`);
      access.push({ doors: [...new Set(doors)], days, from, to });
    });
  }
  const openWithoutRing = typeof input.openWithoutRing === 'boolean' ? input.openWithoutRing : (previous?.openWithoutRing ?? false);
  if (openWithoutRing && !access.length) errors.push('openWithoutRing needs access to a door');
  if ((access.length || openWithoutRing) && !faceNames.length && !plates.length && !pinHash) {
    warnings.push('access works only with a face, a plate or a PIN: none is given');
  }
  if (role === 'blocked' && (access.length || openWithoutRing)) errors.push('a blocked person has no access');
  const severity = input.blockedSeverity ?? previous?.blockedSeverity;
  if (severity !== undefined && !['quiet', 'normal', 'critical'].includes(severity as string)) errors.push('blockedSeverity: quiet, normal or critical');
  const gender = input.gender ?? previous?.gender;
  if (gender !== undefined && gender !== null && gender !== 'm' && gender !== 'f') errors.push('gender: m or f');
  if (errors.length || !name) return { errors };
  return {
    value: {
      id: previous?.id ?? randomUUID(),
      name,
      role,
      ...((input.child ?? previous?.child) ? { child: true } : {}),
      faceNames,
      plates,
      ...(pinHash ? { pinHash } : {}),
      access,
      openWithoutRing,
      notifyOnArrival: has(input, 'notifyOnArrival') ? list(input.notifyOnArrival) : (previous?.notifyOnArrival ?? []),
      ...(role === 'blocked' ? { blockedSeverity: (severity as Person['blockedSeverity']) ?? 'normal' } : {}),
      ...(gender === 'm' || gender === 'f' ? { gender } : {}),
      ...(str(input.note, 300) ? { note: str(input.note, 300) } : previous?.note ? { note: previous.note } : {}),
    },
    warnings,
  };
}

// ---- panels ----

export interface PanelWorld {
  cameras: { id: string; name: string; speakProblem?: string }[];
  /** sensors the plugin can use, with their type */
  sensors: { id: string; type: string; name: string }[];
  profile(id: string): PanelProfile | undefined;
}

const DOOR_VIAS = ['lock', 'switch', 'panel'];

function checkDoor(raw: unknown, i: number, world: PanelWorld, profile: PanelProfile | undefined, errors: string[]): PanelDoor | undefined {
  const d = (raw ?? {}) as Record<string, unknown>;
  const name = str(d.name, 60);
  if (!name) errors.push(`doors[${i}].name`);
  const v = (d.via ?? {}) as Record<string, unknown>;
  let via: PanelDoor['via'] | undefined;
  if (!DOOR_VIAS.includes(v.kind as string)) errors.push(`doors[${i}].via: lock, switch or panel`);
  else if (v.kind === 'panel') {
    if (!profile) errors.push(`doors[${i}]: a panel door needs a panel model`);
    else if (!profile.doors.some((door) => door.key === v.doorKey)) errors.push(`doors[${i}]: the model has no door "${String(v.doorKey)}"`);
    else via = { kind: 'panel', doorKey: v.doorKey as string };
  } else {
    const sensor = world.sensors.find((s) => s.id === v.sensorId);
    const type = v.kind === 'lock' ? 'lock' : 'switch';
    if (sensor?.type !== type) errors.push(`doors[${i}]: no ${type} sensor "${String(v.sensorId)}" that the intercom may use`);
    else if (v.kind === 'lock') via = { kind: 'lock', sensorId: sensor.id };
    else {
      const pulse = v.pulseSeconds === undefined ? 3 : Number(v.pulseSeconds);
      if (!(pulse >= 1 && pulse <= 30)) errors.push(`doors[${i}].via.pulseSeconds: 1 to 30`);
      via = { kind: 'switch', sensorId: sensor.id, pulseSeconds: pulse };
    }
  }
  const relock = d.relockSeconds === undefined ? 5 : Number(d.relockSeconds);
  if (!(relock >= 0 && relock <= 300)) errors.push(`doors[${i}].relockSeconds: 0 to 300`);
  if (!name || !via) return undefined;
  return {
    id: str(d.id, 64) ?? randomUUID(),
    name,
    via,
    relockSeconds: relock,
    ...(str(d.floorplanConnectionId, 64) ? { floorplanConnectionId: str(d.floorplanConnectionId, 64) } : {}),
  };
}

/**
 * A panel, checked: its camera, its doorbells and door sensors exist and are of the right type, each door has a way to
 * open. A camera that cannot speak is a warning, not an error: the panel still rings, shows video and opens.
 */
export function checkPanel(input: Record<string, unknown>, world: PanelWorld, previous?: Panel): Checked<Panel> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = str(input.name, 60) ?? previous?.name;
  if (!name) errors.push('name');
  const cameraId = str(input.cameraId, 64) ?? previous?.cameraId;
  const camera = world.cameras.find((c) => c.id === cameraId);
  if (!camera) errors.push('cameraId: the camera is not known to the intercom (turn the intercom on for it in the camera settings)');
  else if (camera.speakProblem) warnings.push(`the agent and talking will not work, only video and opening: ${camera.speakProblem}`);

  let driver = previous?.driver;
  let profile: PanelProfile | undefined;
  if (has(input, 'driver')) {
    if (input.driver === null) driver = undefined;
    else {
      const d = (input.driver ?? {}) as Record<string, unknown>;
      profile = world.profile(String(d.profileId));
      if (!profile) errors.push(`driver.profileId: no usable model "${String(d.profileId)}"`);
      const host = str(d.host, 253);
      if (!host || !/^[a-z0-9.-]+$/i.test(host)) errors.push('driver.host: an IP address or a name');
      const port = (key: string) => (d[key] === undefined || d[key] === null ? undefined : Number(d[key]));
      for (const key of ['httpPort', 'rtspPort']) {
        const value = port(key);
        if (value !== undefined && !(Number.isInteger(value) && value > 0 && value < 65536)) errors.push(`driver.${key}: 1 to 65535`);
      }
      const username = str(d.username, 64);
      if (!username && profile?.auth !== 'none') errors.push('driver.username');
      if (profile && host) {
        driver = {
          profileId: profile.id,
          host,
          ...(port('httpPort') !== undefined ? { httpPort: port('httpPort') } : {}),
          ...(port('rtspPort') !== undefined ? { rtspPort: port('rtspPort') } : {}),
          username: username ?? '',
          ...(previous?.driver?.hookTokenHash ? { hookTokenHash: previous.driver.hookTokenHash } : {}),
        };
      }
    }
  } else if (driver) profile = world.profile(driver.profileId);

  const doorbellSensorIds = has(input, 'doorbellSensorIds') ? list(input.doorbellSensorIds) : (previous?.doorbellSensorIds ?? []);
  for (const id of doorbellSensorIds) {
    if (!world.sensors.some((s) => s.id === id && s.type === 'doorbell')) errors.push(`doorbellSensorIds: no doorbell "${id}" that the intercom may use`);
  }
  const ownRing = profile && profile.events.via !== 'sensors';
  if (!doorbellSensorIds.length && !ownRing) errors.push('doorbellSensorIds: where the presses come from (a doorbell sensor), or a panel model with events');

  let doors = previous?.doors ?? [];
  if (has(input, 'doors')) {
    const raw = Array.isArray(input.doors) ? input.doors : [];
    doors = raw.map((door, i) => checkDoor(door, i, world, profile, errors)).filter((door): door is PanelDoor => Boolean(door));
  }
  if (!doors.length) warnings.push('no door: the panel rings and shows video, nothing opens');
  const contactSensorId = has(input, 'contactSensorId') ? str(input.contactSensorId, 64) : previous?.contactSensorId;
  if (contactSensorId && !world.sensors.some((s) => s.id === contactSensorId && s.type === 'contact'))
    errors.push(`contactSensorId: no contact sensor "${contactSensorId}"`);

  const callUserIds = has(input, 'callUserIds') ? (input.callUserIds === 'all' ? 'all' : list(input.callUserIds, 50)) : (previous?.callUserIds ?? 'all');
  if (Array.isArray(callUserIds) && !callUserIds.length) warnings.push('nobody is called: only the agent answers');
  const ringMode = input.ringMode === 'order' ? 'order' : input.ringMode === 'together' ? 'together' : (previous?.ringMode ?? 'together');
  const orderFirstSeconds = input.orderFirstSeconds === undefined ? (previous?.orderFirstSeconds ?? 15) : Number(input.orderFirstSeconds);
  if (!(orderFirstSeconds >= 5 && orderFirstSeconds <= 60)) errors.push('orderFirstSeconds: 5 to 60');
  if (ringMode === 'order' && !(Array.isArray(callUserIds) && callUserIds.length > 1)) errors.push('ringMode "order" needs at least two users to call');
  if (errors.length || !name || !cameraId) return { errors };
  return {
    value: {
      id: previous?.id ?? randomUUID(),
      name,
      cameraId,
      ...(driver ? { driver } : {}),
      doorbellSensorIds,
      doors,
      ...(contactSensorId ? { contactSensorId } : {}),
      callUserIds,
      ringMode,
      orderFirstSeconds,
      ...((has(input, 'presenceZone') ? str(input.presenceZone, 60) : previous?.presenceZone)
        ? { presenceZone: has(input, 'presenceZone') ? str(input.presenceZone, 60) : previous?.presenceZone }
        : {}),
      openUserIds: has(input, 'openUserIds') ? list(input.openUserIds, 50) : (previous?.openUserIds ?? []),
      ...((typeof input.openByPlate === 'boolean' ? input.openByPlate : previous?.openByPlate) ? { openByPlate: true } : {}),
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (previous?.enabled ?? true),
    },
    warnings,
  };
}

// ---- guest codes ----

export interface CodeRequest {
  label: string;
  doors: string[];
  from: number;
  to: number;
  maxUses: number;
}

export function checkCodeRequest(
  input: Record<string, unknown>,
  panels: Panel[],
  now: number,
  timeZone: string,
  mayOpen: (panel: Panel) => boolean,
): Checked<CodeRequest> {
  const errors: string[] = [];
  const label = str(input.label, 80);
  if (!label) errors.push('label: who the code is for ("сантехник")');
  const doors: string[] = [];
  for (const ref of list(input.doors)) {
    const matches = panels.flatMap((panel) => panel.doors.filter((door) => door.id === ref || fold(door.name) === fold(ref)).map((door) => ({ panel, door })));
    if (!matches.length) errors.push(`doors: "${ref}" is not known`);
    for (const { panel, door } of matches) {
      if (!mayOpen(panel)) errors.push(`doors: you may not open "${door.name}"`);
      doors.push(door.id);
    }
  }
  if (!list(input.doors).length) errors.push('doors: which doors the code opens');
  const window = input.from === undefined && input.to === undefined ? defaultWindow(now, timeZone) : undefined;
  const from = window?.from ?? (input.from === undefined || input.from === '' ? now : parseMoment(input.from, timeZone));
  const to = window?.to ?? parseMoment(input.to, timeZone);
  if (from === undefined || to === undefined) errors.push('from and to: a date and time');
  else {
    if (to <= from || to <= now) errors.push('the window is over or empty');
    if (to - from > MAX_WINDOW_DAYS * 24 * 60 * 60_000) errors.push(`a code lives at most ${MAX_WINDOW_DAYS} days`);
  }
  const maxUses = input.maxUses === undefined ? 1 : Number(input.maxUses);
  if (!(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 20)) errors.push('maxUses: 1 to 20');
  if (errors.length || !label || from === undefined || to === undefined) return { errors };
  return { value: { label, doors: [...new Set(doors)], from, to, maxUses }, warnings: [] };
}
