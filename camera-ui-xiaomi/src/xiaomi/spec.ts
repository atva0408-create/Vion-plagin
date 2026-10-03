// The MIoT description of a camera (its "spec"): the services, properties and actions Xiaomi publishes for each model
// at miot-spec.org. The Mi Home app zooms and focuses a camera with a lens through these; the plugin finds them by
// their names, so a model the plugin has never seen works too, and a model without a lens simply has none.
import { errorText } from './text.js';

export const SPEC_URL = 'https://miot-spec.org/miot-spec-v2';
const SPEC_TIMEOUT_MS = 15_000;

export interface MiotProperty {
  iid: number;
  type: string;
  description?: string;
  format?: string;
  access?: string[];
  'value-range'?: number[];
  'value-list'?: { value: unknown; description?: string }[];
}

export interface MiotAction {
  iid: number;
  type: string;
  description?: string;
  in?: number[];
}

export interface MiotService {
  iid: number;
  type: string;
  description?: string;
  properties?: MiotProperty[];
  actions?: MiotAction[];
}

export interface MiotSpec {
  type: string;
  services: MiotService[];
}

export interface PropRef {
  siid: number;
  piid: number;
}

export interface ActionRef {
  siid: number;
  aiid: number;
}

/**
 * How one optical axis (zoom or focus) is driven:
 * - `range`: a number property, set to a value;
 * - `actions`: an action for each way, one step each;
 * - `values`: a property of a few values (in, out, stop), held like a motor.
 */
export type Axis =
  | { kind: 'range'; prop: PropRef; min: number; max: number; step: number }
  | { kind: 'actions'; plus: ActionRef; minus: ActionRef }
  | { kind: 'values'; prop: PropRef; plus: unknown; minus: unknown; stop?: unknown };

export type AutoFocus = { kind: 'action'; action: ActionRef } | { kind: 'switch'; prop: PropRef };

/** What the lens of a camera can do from ViON. Empty for a camera with a fixed lens (Mi 360°, C200, C300). */
export interface Optics {
  zoom?: Axis;
  focus?: Axis;
  autoFocus?: AutoFocus;
}

const NUMBER_FORMATS = new Set(['uint8', 'uint16', 'uint32', 'int8', 'int16', 'int32', 'int64', 'float']);

/** The words of a property or action: the name in its type (urn:…:property:<name>:…) and its description. */
export function wordsOf(item: { type: string; description?: string }): string {
  const name = item.type.split(':')[3] ?? '';
  return `${name} ${item.description ?? ''}`
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase();
}

interface AxisWords {
  /** the axis: the words must name it */
  axis: RegExp;
  /** a way towards more zoom / a farther focus */
  plus: RegExp;
  /** a way towards less zoom / a nearer focus */
  minus: RegExp;
}

const ZOOM: AxisWords = {
  axis: /\bzoom/,
  plus: /\b(in|tele|telephoto|increase|plus|up|enlarge|bigger)\b/,
  minus: /\b(out|wide|decrease|minus|down|reduce|smaller)\b/,
};

const FOCUS: AxisWords = {
  axis: /\bfocus/,
  plus: /\b(far|farther|further|infinity|increase|plus)\b/,
  minus: /\b(near|nearer|close|closer|decrease|minus)\b/,
};

const AUTO_FOCUS = /\bauto\s?focus/;
const STOP = /\bstop\b/;

function writable(property: MiotProperty): boolean {
  return property.access?.includes('write') === true;
}

/** A property worth more as a zoom: optical before plain, a digital zoom last. */
function rank(words: string): number {
  if (words.includes('optical')) return 0;
  if (words.includes('digital')) return 2;
  return 1;
}

function findAxis(spec: MiotSpec, words: AxisWords): Axis | undefined {
  const ranges: { axis: Axis; rank: number }[] = [];
  let values: Axis | undefined;
  let plus: ActionRef | undefined;
  let minus: ActionRef | undefined;

  for (const service of spec.services ?? []) {
    for (const property of service.properties ?? []) {
      const text = wordsOf(property);
      if (!words.axis.test(text) || AUTO_FOCUS.test(text) || !writable(property)) continue;
      const range = property['value-range'];
      const list = property['value-list'];
      const prop = { siid: service.iid, piid: property.iid };
      if (NUMBER_FORMATS.has(property.format ?? '') && Array.isArray(range) && range.length >= 2 && range[1] > range[0]) {
        const [min, max, step] = range;
        ranges.push({ axis: { kind: 'range', prop, min, max, step: step && step > 0 ? step : 1 }, rank: rank(text) });
      } else if (Array.isArray(list) && !values) {
        const of = (re: RegExp) => list.find((entry) => re.test(wordsOf({ type: '', description: entry.description })));
        const up = of(words.plus);
        const down = of(words.minus);
        if (up && down && up !== down) values = { kind: 'values', prop, plus: up.value, minus: down.value, stop: of(STOP)?.value };
      }
    }
    for (const action of service.actions ?? []) {
      const text = wordsOf(action);
      if (!words.axis.test(text) || AUTO_FOCUS.test(text) || (action.in?.length ?? 0) > 0) continue;
      if (words.plus.test(text) && !words.minus.test(text)) plus ??= { siid: service.iid, aiid: action.iid };
      else if (words.minus.test(text) && !words.plus.test(text)) minus ??= { siid: service.iid, aiid: action.iid };
    }
  }

  ranges.sort((a, b) => a.rank - b.rank);
  if (ranges[0]) return ranges[0].axis;
  if (plus && minus) return { kind: 'actions', plus, minus };
  return values;
}

function findAutoFocus(spec: MiotSpec): AutoFocus | undefined {
  for (const service of spec.services ?? []) {
    for (const action of service.actions ?? []) {
      if (AUTO_FOCUS.test(wordsOf(action)) && (action.in?.length ?? 0) === 0) return { kind: 'action', action: { siid: service.iid, aiid: action.iid } };
    }
  }
  for (const service of spec.services ?? []) {
    for (const property of service.properties ?? []) {
      if (AUTO_FOCUS.test(wordsOf(property)) && property.format === 'bool' && writable(property)) {
        return { kind: 'switch', prop: { siid: service.iid, piid: property.iid } };
      }
    }
  }
  return undefined;
}

/** The zoom and focus of a camera, as its spec describes them. */
export function findOptics(spec: MiotSpec): Optics {
  const optics: Optics = {};
  const zoom = findAxis(spec, ZOOM);
  const focus = findAxis(spec, FOCUS);
  const autoFocus = findAutoFocus(spec);
  if (zoom) optics.zoom = zoom;
  if (focus) optics.focus = focus;
  if (autoFocus) optics.autoFocus = autoFocus;
  return optics;
}

export function hasOptics(optics: Optics): boolean {
  return optics.zoom !== undefined || optics.focus !== undefined || optics.autoFocus !== undefined;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`miot-spec.org: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * The specs of the models, read once each: a spec of a model does not change. The device list of Mi Home names the
 * spec of a device (`spec_type`); a camera it does not is looked up in the list of all released specs.
 */
export class SpecSource {
  private readonly specs = new Map<string, Promise<MiotSpec>>();
  private types?: Promise<Map<string, string>>;

  constructor(private readonly baseUrl = SPEC_URL) {}

  public spec(model: string, specType?: string): Promise<MiotSpec> {
    const key = specType ?? model;
    let spec = this.specs.get(key);
    if (!spec) {
      spec = this.read(model, specType);
      // a failed read is tried again next time: the site may have been unreachable for a moment
      spec.catch(() => this.specs.delete(key));
      this.specs.set(key, spec);
    }
    return spec;
  }

  private async read(model: string, specType?: string): Promise<MiotSpec> {
    const type = specType ?? (await this.typeOf(model));
    const spec = (await getJson(`${this.baseUrl}/instance?type=${encodeURIComponent(type)}`)) as MiotSpec;
    if (!spec || !Array.isArray(spec.services)) throw new Error(`miot-spec.org has no services for ${model}`);
    return spec;
  }

  private async typeOf(model: string): Promise<string> {
    // the list of all specs is large: only the newest spec of each camera model is kept from it
    this.types ??= getJson(`${this.baseUrl}/instances?status=released`).then((answer) => {
      const newest = new Map<string, { type: string; version: number }>();
      for (const instance of (answer as { instances?: { model?: string; type?: string; version?: number }[] }).instances ?? []) {
        if (!instance.model || !instance.type || !/\.(camera|cateye)\./.test(instance.model)) continue;
        const known = newest.get(instance.model);
        if (!known || (instance.version ?? 0) > known.version) newest.set(instance.model, { type: instance.type, version: instance.version ?? 0 });
      }
      return new Map([...newest].map(([key, value]) => [key, value.type]));
    });
    let types: Map<string, string>;
    try {
      types = await this.types;
    } catch (error) {
      this.types = undefined;
      throw new Error(`Could not read the list of MIoT specs: ${errorText(error)}`);
    }
    const type = types.get(model);
    if (!type) throw new Error(`miot-spec.org has no spec of ${model}`);
    return type;
  }
}
