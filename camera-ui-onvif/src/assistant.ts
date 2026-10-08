// Tools the assistant can call on ONVIF cameras: the presets of a PTZ camera, saving and deleting one, and a reboot
// of the camera itself (what repair_camera of the server cannot do). Reading runs without asking; the changes declare
// `approval` and `adminOnly`, and answer `__preview` (set only by the server, for the confirmation card) with lines
// that say what they would do, doing nothing.
// i18n-skip-file: the descriptions are read by the model; the card lines below carry their own three languages.

import type { AssistantToolContext, AssistantToolResult, AssistantToolSpec } from '@camera.ui/sdk';

/** One camera as the tools see it; kept narrow so they are testable without a device. */
export interface OnvifAssistantCamera {
  id: string;
  name: string;
  /** The ONVIF device answers now. */
  connected: boolean;
  hasPTZ: boolean;
  presets(): Promise<{ name: string; token: string }[]>;
  /** Stores the current position under the name; with a token, overwrites that preset. Answers the token. */
  savePreset(name: string, token?: string): Promise<string>;
  removePreset(token: string): Promise<void>;
  reboot(): Promise<string>;
}

export interface OnvifAssistantHost {
  cameras(): OnvifAssistantCamera[];
}

type Input = Record<string, unknown>;
type Lang = 'ru' | 'en' | 'de';

/** A preset name goes into the SOAP body as it is (the library does not escape it): letters, digits, spaces, - _ . only. */
export const PRESET_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;

const ACTING = new Set(['save_preset', 'delete_preset', 'reboot']);

const cameraField = { type: 'string', description: 'Exact camera name.' } as const;

export const ONVIF_TOOLS: AssistantToolSpec[] = [
  {
    name: 'presets',
    description: 'The presets (saved positions) of the PTZ cameras added through ONVIF, or of one camera.',
    inputSchema: { type: 'object', properties: { camera: cameraField } },
    lazy: true,
  },
  {
    name: 'save_preset',
    description:
      'Save where a PTZ camera looks now as a preset with a name ("remember this position as Gate"). A preset with the same name is overwritten. ' +
      'Move the camera there first. Requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: { camera: cameraField, name: { type: 'string', description: 'Name of the preset: letters, digits, spaces, - _ . (at most 32).' } },
      required: ['camera', 'name'],
    },
    approval: true,
    adminOnly: true,
    lazy: true,
  },
  {
    name: 'delete_preset',
    description: 'Delete a preset of a PTZ camera by its name. Requires user confirmation.',
    inputSchema: { type: 'object', properties: { camera: cameraField, name: { type: 'string' } }, required: ['camera', 'name'] },
    approval: true,
    adminOnly: true,
    lazy: true,
  },
  {
    name: 'reboot',
    description:
      'Reboot an ONVIF camera itself (the step after the repairs of the server did not help): it is gone for one or two minutes. ' + 'Requires user confirmation.',
    inputSchema: { type: 'object', properties: { camera: cameraField }, required: ['camera'] },
    approval: true,
    adminOnly: true,
    timeoutMs: 30_000,
    lazy: true,
  },
];

// prettier-ignore
const T: Record<Lang, Record<string, (v: Record<string, string>) => string>> = {
  ru: {
    save: (v) => `${v.camera}: запомнить текущее положение как пресет «${v.name}»`,
    overwrite: (v) => `${v.camera}: пресет «${v.name}» перезаписывается текущим положением`,
    remove: (v) => `${v.camera}: удалить пресет «${v.name}»`,
    reboot: (v) => `${v.camera}: перезагрузить камеру`,
    rebootNote: () => 'Камера будет недоступна 1–2 минуты: ни эфира, ни записи',
  },
  de: {
    save: (v) => `${v.camera}: aktuelle Position als Preset „${v.name}“ speichern`,
    overwrite: (v) => `${v.camera}: Preset „${v.name}“ wird mit der aktuellen Position überschrieben`,
    remove: (v) => `${v.camera}: Preset „${v.name}“ löschen`,
    reboot: (v) => `${v.camera}: Kamera neu starten`,
    rebootNote: () => 'Die Kamera ist 1–2 Minuten nicht erreichbar: kein Live-Bild, keine Aufnahme',
  },
  en: {
    save: (v) => `${v.camera}: save the current position as the preset "${v.name}"`,
    overwrite: (v) => `${v.camera}: the preset "${v.name}" is overwritten with the current position`,
    remove: (v) => `${v.camera}: delete the preset "${v.name}"`,
    reboot: (v) => `${v.camera}: reboot the camera`,
    rebootNote: () => 'The camera is gone for 1–2 minutes: no live video, no recording',
  },
};

const langOf = (language: string): Lang => (language.startsWith('ru') ? 'ru' : language.startsWith('de') ? 'de' : 'en');
const lines = (...list: string[]): AssistantToolResult => ({ content: { preview: { lines: list } } });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function oneCamera(host: OnvifAssistantHost, value: unknown): OnvifAssistantCamera | { error: string } {
  const cameras = host.cameras();
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const camera = cameras.find((c) => c.name.toLowerCase() === wanted || c.id === value);
  return camera ?? { error: `No ONVIF camera "${String(value)}". The ONVIF cameras: ${cameras.map((c) => c.name).join(', ') || 'none'}` };
}

function ptzCamera(host: OnvifAssistantHost, value: unknown): OnvifAssistantCamera | { error: string } {
  const camera = oneCamera(host, value);
  if ('error' in camera) return camera;
  if (!camera.connected) return { error: `"${camera.name}" does not answer over ONVIF right now.` };
  if (!camera.hasPTZ) return { error: `"${camera.name}" has no pan and tilt: it has no presets.` };
  return camera;
}

const sameName = (a: unknown, b: unknown) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * The presets as the camera answers them, with names as text. The ONVIF library reads a name of digits ("1", "2") as a
 * number: `.trim()` of it threw, and saving or deleting any preset of such a camera failed.
 */
export function presetsOf(raw: Record<string, { name?: string | number; token?: string | number }> | null | undefined): { name: string; token: string }[] {
  return Object.values(raw ?? {})
    .filter((preset) => preset.token !== undefined && preset.token !== null)
    .map((preset) => {
      const name = preset.name === undefined || preset.name === null ? '' : String(preset.name).trim();
      return { name: name || String(preset.token), token: String(preset.token) };
    });
}

export async function callOnvifTool(host: OnvifAssistantHost, name: string, input: Input, ctx: AssistantToolContext): Promise<AssistantToolResult> {
  try {
    if (name === 'presets') return await listPresets(host, input);
    if (!ACTING.has(name)) return { error: `Unknown tool ${name}` };
    // the server offers these to admins only; a call that gets here otherwise is refused here too
    if (ctx.role !== 'admin' && ctx.role !== 'master') return { error: 'Only an administrator can do this.' };
    const preview = input.__preview === true;
    const t = T[langOf(ctx.language)];
    switch (name) {
      case 'save_preset':
        return await savePreset(host, input, preview, t);
      case 'delete_preset':
        return await deletePreset(host, input, preview, t);
      default:
        return await reboot(host, input, preview, t);
    }
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function listPresets(host: OnvifAssistantHost, input: Input): Promise<AssistantToolResult> {
  const picked = typeof input.camera === 'string' && input.camera.trim() ? ptzCamera(host, input.camera) : undefined;
  if (picked && 'error' in picked) return picked;
  const cameras = picked ? [picked] : host.cameras().filter((camera) => camera.hasPTZ && camera.connected);
  const out = [];
  for (const camera of cameras) out.push({ camera: camera.name, presets: (await camera.presets()).map((preset) => preset.name) });
  return { content: out.length ? out : { note: 'No ONVIF camera with pan and tilt answers right now.' } };
}

async function savePreset(host: OnvifAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const camera = ptzCamera(host, input.camera);
  if ('error' in camera) return camera;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!PRESET_NAME.test(name)) return { error: 'name: 1–32 letters, digits, spaces, - _ . starting with a letter or digit.' };
  const existing = (await camera.presets()).find((preset) => sameName(preset.name, name));
  if (preview) return lines((existing ? t.overwrite : t.save)({ camera: camera.name, name }));
  const token = await camera.savePreset(name, existing?.token);
  return { content: { done: true, camera: camera.name, preset: name, overwritten: Boolean(existing), token } };
}

async function deletePreset(host: OnvifAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const camera = ptzCamera(host, input.camera);
  if ('error' in camera) return camera;
  const name = typeof input.name === 'string' ? input.name : '';
  const presets = await camera.presets();
  const preset = presets.find((p) => sameName(p.name, name));
  if (!preset) return { error: `"${camera.name}" has no preset "${name}". Its presets: ${presets.map((p) => p.name).join(', ') || 'none'}` };
  if (preview) return lines(t.remove({ camera: camera.name, name: preset.name }));
  await camera.removePreset(preset.token);
  return { content: { done: true, camera: camera.name, deleted: preset.name } };
}

async function reboot(host: OnvifAssistantHost, input: Input, preview: boolean, t: (typeof T)['en']): Promise<AssistantToolResult> {
  const camera = oneCamera(host, input.camera);
  if ('error' in camera) return camera;
  if (!camera.connected) return { error: `"${camera.name}" does not answer over ONVIF: it cannot be told to reboot. Check its power and network.` };
  if (preview) return lines(t.reboot({ camera: camera.name }), t.rebootNote({}));
  const message = await camera.reboot();
  return { content: { done: true, camera: camera.name, ...(message ? { camera_says: message } : {}), note: 'The camera reboots: gone for one or two minutes.' } };
}
