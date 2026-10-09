// Tools the assistant can call on Home Assistant: the entities with their area and state, and a service call — a
// scene, a script, an automation, a light — the pair of yandex_run_scenario. Reading runs without asking; the call
// declares `approval` and `adminOnly` and answers `__preview` (set only by the server, for the confirmation card) with
// what it would do. Only the domains of DEFAULT_DOMAINS, and the ones the admin added in the settings of the plugin,
// can be called: a service of another domain (a lock, an alarm panel, a restart of Home Assistant) is refused.
// i18n-skip-file: the descriptions are read by the model; the card lines below carry their own three languages.

import type { AssistantToolContext, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';

export const DEFAULT_DOMAINS = ['scene', 'script', 'automation', 'light', 'switch', 'cover', 'climate', 'media_player', 'notify'];

export interface HaEntity {
  entityId: string;
  name: string;
  state: string;
  area?: string;
}

/** What the tools need from the plugin; kept narrow so they are testable without Home Assistant. */
export interface HaAssistantHost {
  connected(): boolean;
  entities(): Promise<HaEntity[]>;
  /** The domains the admin added to DEFAULT_DOMAINS in the settings of the plugin. */
  extraDomains(): string[];
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void>;
}

type Input = Record<string, unknown>;
type Lang = 'ru' | 'en' | 'de';

/** A domain or a service goes into the URL path: lower case words only. */
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LISTED = 200;
/**
 * Fields of a service call that name what it acts on besides entity_id. Home Assistant acts on all of them together:
 * light.turn_off with data {"area_id": "kitchen"} turns off every light of the kitchen while the card names one lamp.
 */
const TARGET_KEYS = ['area_id', 'device_id', 'floor_id', 'label_id'];

export const HA_TOOLS: AssistantToolSpec[] = [
  {
    name: 'entities',
    description:
      'The entities of Home Assistant with their area and state: lights, switches, covers, climate, scenes, scripts, automations, sensors. ' +
      'Narrow by area, domain (light, scene...) or words of the name. Then call_service acts on one.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Area (room) as Home Assistant names it.' },
        domain: { type: 'string', description: 'The part of the entity id before the dot, e.g. light, scene, script.' },
        search: { type: 'string', description: 'Words of the name or of the entity id.' },
      },
    },
    lazy: true,
  },
  {
    name: 'call_service',
    description:
      'Call a service of Home Assistant on one entity: run a scene or a script (scene.turn_on, script.turn_on), trigger an automation ' +
      '(automation.trigger), switch a light or a switch, open or close a cover, set a climate (climate.set_temperature with data {"temperature": 22}). ' +
      `Allowed domains: ${DEFAULT_DOMAINS.join(', ')} and the ones added in the settings of the plugin. Requires user confirmation.`,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'e.g. scene, light, cover' },
        service: { type: 'string', description: 'e.g. turn_on, turn_off, toggle, open_cover, set_temperature, trigger' },
        entity_id: { type: 'string', description: 'The entity, from entities; of the same domain. A notify service needs none.' },
        data: {
          type: 'object',
          description:
            'Further fields of the service, e.g. {"brightness_pct": 40} or {"message": "..."}. ' +
            'Not an area, device, floor, label or target: the call acts on entity_id only.',
          properties: {},
        },
      },
      required: ['domain', 'service'],
    },
    approval: true,
    adminOnly: true,
    lazy: true,
  },
];

type Line = (v: Record<string, string>) => string;
// prettier-ignore
const T: Record<Lang, { service: Record<string, string>; call: Line; notify: Line; data: Line }> = {
  ru: {
    service: { turn_on: 'включить', turn_off: 'выключить', toggle: 'переключить', open_cover: 'открыть', close_cover: 'закрыть', stop_cover: 'остановить',
      set_cover_position: 'положение', set_temperature: 'температура', set_hvac_mode: 'режим', trigger: 'запустить', media_play: 'играть',
      media_pause: 'пауза', media_stop: 'стоп', volume_set: 'громкость' },
    call: (v) => `${v.name}${v.area}: ${v.action}`,
    notify: (v) => `Уведомление через ${v.service}`,
    data: (v) => `${v.key}: ${v.value}`,
  },
  de: {
    service: { turn_on: 'einschalten', turn_off: 'ausschalten', toggle: 'umschalten', open_cover: 'öffnen', close_cover: 'schließen', stop_cover: 'anhalten',
      set_cover_position: 'Position', set_temperature: 'Temperatur', set_hvac_mode: 'Modus', trigger: 'auslösen', media_play: 'abspielen',
      media_pause: 'Pause', media_stop: 'Stopp', volume_set: 'Lautstärke' },
    call: (v) => `${v.name}${v.area}: ${v.action}`,
    notify: (v) => `Benachrichtigung über ${v.service}`,
    data: (v) => `${v.key}: ${v.value}`,
  },
  en: {
    service: { turn_on: 'turn on', turn_off: 'turn off', toggle: 'toggle', open_cover: 'open', close_cover: 'close', stop_cover: 'stop',
      set_cover_position: 'position', set_temperature: 'temperature', set_hvac_mode: 'mode', trigger: 'run', media_play: 'play',
      media_pause: 'pause', media_stop: 'stop', volume_set: 'volume' },
    call: (v) => `${v.name}${v.area}: ${v.action}`,
    notify: (v) => `A notification through ${v.service}`,
    data: (v) => `${v.key}: ${v.value}`,
  },
};

const langOf = (language: string): Lang => (language.startsWith('ru') ? 'ru' : language.startsWith('de') ? 'de' : 'en');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const domainOf = (entityId: string) => entityId.split('.')[0];
const shownValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export function allowedDomains(host: HaAssistantHost): Set<string> {
  return new Set([...DEFAULT_DOMAINS, ...host.extraDomains().filter((domain) => NAME.test(domain))]);
}

export async function callHaTool(host: HaAssistantHost, name: string, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  try {
    if (!host.connected()) return { error: 'Home Assistant is not connected: check the address and the token in the settings of the plugin.' };
    if (name === 'entities') return await entities(host, input);
    if (name !== 'call_service') return { error: `Unknown tool ${name}` };
    // the server offers it to admins only; a call that gets here otherwise is refused here too
    if (ctx.role !== 'admin' && ctx.role !== 'master') return { error: 'Only an administrator can do this.' };
    return await callService(host, input, input.__preview === true, T[langOf(ctx.language)]);
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function entities(host: HaAssistantHost, input: Input): Promise<AssistantToolResult> {
  const area = typeof input.area === 'string' ? input.area.trim().toLowerCase() : '';
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
  const words = typeof input.search === 'string' ? input.search.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
  const found = (await host.entities()).filter(
    (entity) =>
      (!area || entity.area?.toLowerCase() === area) &&
      (!domain || domainOf(entity.entityId) === domain) &&
      words.every((word) => entity.name.toLowerCase().includes(word) || entity.entityId.includes(word)),
  );
  const allowed = allowedDomains(host);
  return {
    content: {
      entities: found.slice(0, MAX_LISTED).map((entity) => ({
        entity_id: entity.entityId,
        name: entity.name,
        state: entity.state,
        ...(entity.area ? { area: entity.area } : {}),
        ...(allowed.has(domainOf(entity.entityId)) ? {} : { readOnly: true }),
      })),
      ...(found.length > MAX_LISTED ? { more: found.length - MAX_LISTED, note: 'Narrow by area, domain or search.' } : {}),
    },
  };
}

async function callService(host: HaAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const domain = typeof input.domain === 'string' ? input.domain.trim() : '';
  const service = typeof input.service === 'string' ? input.service.trim() : '';
  if (!NAME.test(domain) || !NAME.test(service)) return { error: 'domain and service are lower case words, e.g. scene and turn_on.' };
  if (!allowedDomains(host).has(domain)) {
    const allowed = [...allowedDomains(host)].join(', ');
    return { error: `The domain "${domain}" may not be called from the chat. Allowed: ${allowed}; an admin adds more in the settings of the plugin.` };
  }
  const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? { ...(input.data as Record<string, unknown>) } : {};
  delete data.entity_id;
  // refused, not dropped: dropped, the call would run on one entity while the model tells the user the area is done.
  // A `target` object is the target of an automation; a notify service's own `target` (its recipients) is a list or a text
  const widening = [...TARGET_KEYS.filter((key) => key in data), ...(data.target && typeof data.target === 'object' && !Array.isArray(data.target) ? ['target'] : [])];
  if (widening.length) return { error: `data may not name what the call acts on (${widening.join(', ')}): a call acts on one entity, entity_id. Call once per entity.` };

  const entityId = typeof input.entity_id === 'string' ? input.entity_id.trim() : '';
  let entity: HaEntity | undefined;
  if (domain !== 'notify') {
    if (!entityId) return { error: 'entity_id is required: take it from entities.' };
    // a service acts on the entities of its own domain: light.turn_on never switches a lock
    if (domainOf(entityId) !== domain) return { error: `${entityId} is not a ${domain} entity.` };
    entity = (await host.entities()).find((candidate) => candidate.entityId === entityId);
    if (!entity) return { error: `No entity ${entityId} in Home Assistant. Take the id from entities.` };
  }

  if (preview) {
    const action = t.service[service] ?? service;
    const head = entity ? t.call({ name: entity.name, area: entity.area ? ` (${entity.area})` : '', action }) : t.notify({ service: `notify.${service}` });
    return { content: { preview: { lines: [head, ...Object.entries(data).map(([key, value]) => t.data({ key, value: shownValue(value) }))] } } };
  }
  await host.callService(domain, service, entity ? { ...data, entity_id: entity.entityId } : data);
  return { content: { done: true, called: `${domain}.${service}`, ...(entity ? { entity: entity.name } : {}) } };
}
