// The store of ready-made automations: automations/catalog.json and one blueprint per template and language
// (automations/blueprints/<id>.<lang>.json). The server reads them from this repository (its automation registry
// URL) and hands out the entry and the blueprint in the language of the interface.
//
// A template is written once, below; its texts (name, description, what the notification says) in every language
// of the interface. The name of the automation and the text it sends are part of the blueprint, so each language
// has its own blueprint file.
//
//   npm run automations              write catalog.json and the blueprints
//   npm run automations -- --check   exit 1 when the files are not what this script writes (CI)
//
// Written without dependencies and with erasable types only: `node scripts/automations.ts` runs it as is.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES } from './i18n.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'automations');

type Text = Record<string, string>;

interface NodeSpec {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

interface EdgeSpec {
  source: string;
  target: string;
  sourceHandle?: string;
}

interface Template {
  id: string;
  category: string;
  featured?: boolean;
  tags: string[];
  /** Plugin interfaces the automation needs on the cameras it watches. */
  requiredPlugins?: string[];
  title: Text;
  description: Text;
  /** What the person installing the template picks: the token `{{input:<key>}}` in a node is replaced by it. */
  inputs?: { key: string; type: 'camera'; label: Text }[];
  /** A detection republishes while it lasts: one run per event instead of one per update. */
  suppressDuplicates?: boolean;
  nodes: (text: (value: Text) => string) => NodeSpec[];
  edges: EdgeSpec[];
}

const CAMERA = '{{input:camera}}';
const CAMERA_INPUT = { key: 'camera', type: 'camera' as const, label: { en: 'Camera', ru: 'Камера', de: 'Kamera' } };

// the editor's own defaults for each node (ui/src/components/CuiAutomation/nodeDefinitions.ts): a node that lacks
// a list the editor expects cannot be opened for editing
const detection = (data: Record<string, unknown>): Record<string, unknown> => ({
  cameraId: CAMERA,
  eventPhase: ['start'],
  detectionLabels: [],
  confidenceThreshold: 0,
  audioLabels: [],
  faceFilter: [],
  licensePlateFilter: [],
  ...data,
});
const notification = (data: Record<string, unknown>): Record<string, unknown> => ({ title: '', body: '', severity: 'info', deepLink: '', targets: [], ...data });
const snapshot = (): NodeSpec => ({ id: 'snapshot', type: 'action-snapshot', data: { cameraId: CAMERA, forceNew: true } });
const PICTURE = '{{snapshot.base64}}';

const TEMPLATES: Template[] = [
  {
    id: 'person-alert',
    category: 'notification',
    featured: true,
    tags: ['person', 'snapshot'],
    requiredPlugins: ['ObjectDetection'],
    title: {
      en: 'Person at the camera',
      ru: 'Человек у камеры',
      de: 'Person an der Kamera',
    },
    description: {
      en: 'Sends a notification with a picture when the camera sees a person.',
      ru: 'Присылает уведомление со снимком, когда камера видит человека.',
      de: 'Sendet eine Benachrichtigung mit Bild, wenn die Kamera eine Person sieht.',
    },
    inputs: [CAMERA_INPUT],
    suppressDuplicates: true,
    nodes: (t) => [
      // segment-start: the moment an object is first seen. An event starts with motion, the person joins later.
      { id: 'trigger', type: 'trigger-detection', data: detection({ eventPhase: ['segment-start'], detectionLabels: ['person'] }) },
      snapshot(),
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Person: {{event.cameraName}}', ru: 'Человек: {{event.cameraName}}', de: 'Person: {{event.cameraName}}' }),
          body: t({ en: 'The camera sees a person.', ru: 'Камера видит человека.', de: 'Die Kamera sieht eine Person.' }),
          image: PICTURE,
        }),
      },
    ],
    edges: [
      { source: 'trigger', target: 'snapshot' },
      { source: 'snapshot', target: 'notify' },
    ],
  },
  {
    id: 'night-person-alert',
    category: 'notification',
    featured: true,
    tags: ['person', 'night', 'snapshot'],
    requiredPlugins: ['ObjectDetection'],
    title: {
      en: 'Person at night',
      ru: 'Человек ночью',
      de: 'Person in der Nacht',
    },
    description: {
      en: 'Sends an urgent notification with a picture when the camera sees a person between 22:00 and 06:00. Change the hours in the time condition.',
      ru: 'Присылает срочное уведомление со снимком, когда камера видит человека с 22:00 до 06:00. Часы меняются в условии по времени.',
      de: 'Sendet eine dringende Benachrichtigung mit Bild, wenn die Kamera zwischen 22:00 und 06:00 Uhr eine Person sieht. Die Uhrzeiten ändern Sie in der Zeitbedingung.',
    },
    inputs: [CAMERA_INPUT],
    suppressDuplicates: true,
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-detection', data: detection({ eventPhase: ['segment-start'], detectionLabels: ['person'] }) },
      { id: 'night', type: 'condition-time', data: { startTime: '22:00', endTime: '06:00', days: [] } },
      snapshot(),
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Person at night: {{event.cameraName}}', ru: 'Человек ночью: {{event.cameraName}}', de: 'Person in der Nacht: {{event.cameraName}}' }),
          body: t({
            en: 'The camera sees a person outside the usual hours.',
            ru: 'Камера видит человека в нерабочее время.',
            de: 'Die Kamera sieht eine Person außerhalb der üblichen Zeiten.',
          }),
          severity: 'warn',
          image: PICTURE,
        }),
      },
    ],
    edges: [
      { source: 'trigger', target: 'night' },
      { source: 'night', target: 'snapshot', sourceHandle: 'true' },
      { source: 'snapshot', target: 'notify' },
    ],
  },
  {
    id: 'vehicle-alert',
    category: 'detection',
    tags: ['vehicle', 'snapshot'],
    requiredPlugins: ['ObjectDetection'],
    title: {
      en: 'Vehicle at the camera',
      ru: 'Машина у камеры',
      de: 'Fahrzeug an der Kamera',
    },
    description: {
      en: 'Sends a notification with a picture when the camera sees a vehicle.',
      ru: 'Присылает уведомление со снимком, когда камера видит машину.',
      de: 'Sendet eine Benachrichtigung mit Bild, wenn die Kamera ein Fahrzeug sieht.',
    },
    inputs: [CAMERA_INPUT],
    suppressDuplicates: true,
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-detection', data: detection({ eventPhase: ['segment-start'], detectionLabels: ['vehicle'] }) },
      snapshot(),
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Vehicle: {{event.cameraName}}', ru: 'Машина: {{event.cameraName}}', de: 'Fahrzeug: {{event.cameraName}}' }),
          body: t({ en: 'The camera sees a vehicle.', ru: 'Камера видит машину.', de: 'Die Kamera sieht ein Fahrzeug.' }),
          image: PICTURE,
        }),
      },
    ],
    edges: [
      { source: 'trigger', target: 'snapshot' },
      { source: 'snapshot', target: 'notify' },
    ],
  },
  {
    id: 'alarm-sound',
    category: 'detection',
    tags: ['sound', 'alarm'],
    requiredPlugins: ['AudioDetection'],
    title: {
      en: 'Alarming sound',
      ru: 'Тревожный звук',
      de: 'Alarmierendes Geräusch',
    },
    description: {
      en: 'Sends a critical notification when the camera hears breaking glass, a scream, a gunshot, an alarm, a siren or a smoke alarm.',
      ru: 'Присылает критическое уведомление, когда камера слышит звон стекла, крик, выстрел, сигнализацию, сирену или пожарный извещатель.',
      de: 'Sendet eine kritische Benachrichtigung, wenn die Kamera Glasbruch, einen Schrei, einen Schuss, einen Alarm, eine Sirene oder einen Rauchmelder hört.',
    },
    inputs: [CAMERA_INPUT],
    // the sound may come in the middle of a motion event, so updates are watched too; one run per event
    suppressDuplicates: true,
    nodes: (t) => [
      {
        id: 'trigger',
        type: 'trigger-detection',
        data: detection({
          eventPhase: ['start', 'update'],
          detectionLabels: ['audio'],
          audioLabels: ['glass_break', 'scream', 'gunshot', 'alarm', 'siren', 'smoke_alarm'],
        }),
      },
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Alarming sound: {{event.cameraName}}', ru: 'Тревожный звук: {{event.cameraName}}', de: 'Alarmierendes Geräusch: {{event.cameraName}}' }),
          body: t({
            en: 'The camera heard an alarming sound. Check the live view.',
            ru: 'Камера услышала тревожный звук. Проверьте прямой эфир.',
            de: 'Die Kamera hat ein alarmierendes Geräusch gehört. Prüfen Sie das Livebild.',
          }),
          severity: 'critical',
        }),
      },
    ],
    edges: [{ source: 'trigger', target: 'notify' }],
  },
  {
    id: 'camera-offline',
    category: 'notification',
    featured: true,
    tags: ['camera', 'offline'],
    title: {
      en: 'Camera went offline',
      ru: 'Камера отключилась',
      de: 'Kamera ist offline',
    },
    description: {
      en: 'Sends a notification when any camera stops responding.',
      ru: 'Присылает уведомление, когда любая камера перестаёт отвечать.',
      de: 'Sendet eine Benachrichtigung, wenn eine Kamera nicht mehr antwortet.',
    },
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-system', data: { category: 'camera', eventType: 'camera:disconnected', targetId: '' } },
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Camera offline: {{system.cameraName}}', ru: 'Камера отключилась: {{system.cameraName}}', de: 'Kamera offline: {{system.cameraName}}' }),
          body: t({
            en: 'The camera stopped responding. Check its power and network.',
            ru: 'Камера перестала отвечать. Проверьте её питание и сеть.',
            de: 'Die Kamera antwortet nicht mehr. Prüfen Sie Stromversorgung und Netzwerk.',
          }),
          severity: 'warn',
        }),
      },
    ],
    edges: [{ source: 'trigger', target: 'notify' }],
  },
  {
    id: 'camera-online',
    category: 'notification',
    tags: ['camera', 'online'],
    title: {
      en: 'Camera is back online',
      ru: 'Камера снова на связи',
      de: 'Kamera ist wieder online',
    },
    description: {
      en: 'Sends a notification when a camera answers again after it was offline.',
      ru: 'Присылает уведомление, когда камера снова отвечает после отключения.',
      de: 'Sendet eine Benachrichtigung, wenn eine Kamera nach einem Ausfall wieder antwortet.',
    },
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-system', data: { category: 'camera', eventType: 'camera:connected', targetId: '' } },
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Camera online: {{system.cameraName}}', ru: 'Камера на связи: {{system.cameraName}}', de: 'Kamera online: {{system.cameraName}}' }),
          body: t({ en: 'The camera answers again.', ru: 'Камера снова отвечает.', de: 'Die Kamera antwortet wieder.' }),
        }),
      },
    ],
    edges: [{ source: 'trigger', target: 'notify' }],
  },
  {
    id: 'daily-picture',
    category: 'schedule',
    tags: ['schedule', 'snapshot'],
    title: {
      en: 'Daily picture',
      ru: 'Ежедневный снимок',
      de: 'Tägliches Bild',
    },
    description: {
      en: 'Sends a picture of the camera every day at 09:00. Change the time in the schedule.',
      ru: 'Каждый день в 09:00 присылает снимок с камеры. Время меняется в расписании.',
      de: 'Sendet jeden Tag um 09:00 Uhr ein Bild der Kamera. Die Uhrzeit ändern Sie im Zeitplan.',
    },
    inputs: [CAMERA_INPUT],
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-schedule', data: { cron: '0 9 * * *' } },
      snapshot(),
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Daily picture', ru: 'Ежедневный снимок', de: 'Tägliches Bild' }),
          body: t({ en: 'This is what the camera sees now.', ru: 'Так сейчас выглядит то, что видит камера.', de: 'Das sieht die Kamera gerade.' }),
          image: PICTURE,
        }),
      },
    ],
    edges: [
      { source: 'trigger', target: 'snapshot' },
      { source: 'snapshot', target: 'notify' },
    ],
  },
  {
    id: 'plugin-error',
    category: 'utility',
    tags: ['plugin', 'error'],
    title: {
      en: 'A plugin stopped with an error',
      ru: 'Плагин остановился с ошибкой',
      de: 'Ein Plugin wurde mit einem Fehler beendet',
    },
    description: {
      en: 'Sends a notification when a plugin stops with an error, so a detector or a camera source does not stay down unnoticed.',
      ru: 'Присылает уведомление, когда плагин останавливается с ошибкой: детектор или источник камер не останется неработающим незаметно.',
      de: 'Sendet eine Benachrichtigung, wenn ein Plugin mit einem Fehler beendet wird, damit ein Detektor oder eine Kameraquelle nicht unbemerkt ausfällt.',
    },
    nodes: (t) => [
      { id: 'trigger', type: 'trigger-system', data: { category: 'plugin', eventType: 'plugin:error', targetId: '' } },
      {
        id: 'notify',
        type: 'action-notification',
        data: notification({
          title: t({ en: 'Plugin error: {{system.pluginName}}', ru: 'Ошибка плагина: {{system.pluginName}}', de: 'Plugin-Fehler: {{system.pluginName}}' }),
          body: t({
            en: 'The plugin stopped with an error. Open Plugins to see its log.',
            ru: 'Плагин остановился с ошибкой. Откройте «Плагины», чтобы посмотреть его журнал.',
            de: 'Das Plugin wurde mit einem Fehler beendet. Öffnen Sie „Plugins", um das Protokoll zu sehen.',
          }),
          severity: 'error',
        }),
      },
    ],
    edges: [{ source: 'trigger', target: 'notify' }],
  },
];

// where the editor puts the nodes of an automation it lays out itself: the trigger on top, one row per step
const LAYOUT = { x: 320, y: 192, row: 224, column: 280 };

function layout(nodes: NodeSpec[], edges: EdgeSpec[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const perLevel = new Map<number, number>();
  const queue = [{ id: nodes[0].id, level: 0 }];
  while (queue.length) {
    const { id, level } = queue.shift()!;
    if (positions.has(id)) continue;
    const index = perLevel.get(level) ?? 0;
    perLevel.set(level, index + 1);
    positions.set(id, { x: LAYOUT.x + index * LAYOUT.column, y: LAYOUT.y + level * LAYOUT.row });
    for (const edge of edges) if (edge.source === id) queue.push({ id: edge.target, level: level + 1 });
  }
  return positions;
}

function blueprint(template: Template, language: string): unknown {
  const text = (value: Text): string => value[language];
  const nodes = template.nodes(text);
  const positions = layout(nodes, template.edges);
  return {
    version: 2,
    name: text(template.title),
    description: text(template.description),
    ...(template.inputs ? { inputs: template.inputs.map((input) => ({ key: input.key, type: input.type, label: text(input.label) })) } : {}),
    ...(template.suppressDuplicates ? { suppressDuplicates: true } : {}),
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, position: positions.get(node.id), data: { type: node.type, ...node.data } })),
    edges: template.edges.map((edge) => ({
      id: `e-${edge.source}-${edge.sourceHandle ?? 'out'}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    })),
  };
}

/** Every file of the store: path below automations/ and its content. */
export function build(): Map<string, string> {
  const [base, ...others] = LANGUAGES;
  const files = new Map<string, string>();
  const catalog: Record<string, unknown> = {};
  const file = (id: string, language: string): string => `blueprints/${id}.${language}.json`;

  for (const template of TEMPLATES) {
    for (const language of LANGUAGES) {
      files.set(file(template.id, language), JSON.stringify(blueprint(template, language), null, 2) + '\n');
    }
    catalog[template.id] = {
      title: template.title[base],
      description: template.description[base],
      category: template.category,
      author: 'ViON',
      featured: template.featured ?? false,
      tags: template.tags,
      ...(template.requiredPlugins ? { requiredPlugins: template.requiredPlugins } : {}),
      ...(template.inputs ? { requiredInputs: [{ type: 'camera', count: template.inputs.length }] } : {}),
      blueprint: file(template.id, base),
      i18n: Object.fromEntries(
        others.map((language) => [language, { title: template.title[language], description: template.description[language], blueprint: file(template.id, language) }]),
      ),
    };
  }

  files.set('catalog.json', JSON.stringify(catalog, null, 2) + '\n');
  return files;
}

function existing(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? existing(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

function main(): void {
  const files = build();

  for (const template of TEMPLATES) {
    for (const [what, text] of Object.entries({ title: template.title, description: template.description })) {
      for (const language of LANGUAGES) {
        if (!text[language]?.trim()) throw new Error(`${template.id}: no ${what} in ${language}`);
      }
    }
  }

  if (process.argv.includes('--check')) {
    const problems: string[] = [];
    for (const [path, content] of files) {
      const onDisk = existsSync(join(OUT, path)) ? readFileSync(join(OUT, path), 'utf8').replace(/\r\n/g, '\n') : undefined;
      if (onDisk === undefined) problems.push(`automations/${path} is missing`);
      else if (onDisk !== content) problems.push(`automations/${path} is not what scripts/automations.ts writes`);
    }
    for (const path of existing(OUT)) {
      if (!files.has(path)) problems.push(`automations/${path} belongs to no template`);
    }
    if (problems.length) {
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('\nRun `npm run automations` and commit the result.');
      process.exit(1);
    }
    console.log(`${TEMPLATES.length} automation template(s) in: ${LANGUAGES.join(', ')}`);
    return;
  }

  for (const path of existing(OUT)) {
    if (!files.has(path)) rmSync(join(OUT, path));
  }
  for (const [path, content] of files) {
    mkdirSync(dirname(join(OUT, path)), { recursive: true });
    writeFileSync(join(OUT, path), content);
  }
  console.log(`Wrote ${TEMPLATES.length} automation template(s), ${files.size} file(s) in automations/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
