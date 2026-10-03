import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES } from './i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const RAW_BASE = 'https://raw.githubusercontent.com/atva0408-create/Vion-plagin/main';

type Category = 'detection' | 'camera-source' | 'notification' | 'recording' | 'automation' | 'ai-model' | 'utility' | 'other';

interface CatalogEntry {
  displayName?: string;
  category: Category;
  featured: boolean;
  /** English; servers older than the translations read only this one. */
  tagline: string;
  /** The same line in every language of the interface, from the plugin's own translations (i18n/<lang>.json). */
  i18n?: Record<string, { tagline: string }>;
  logo?: string;
  screenshots: string[];
  protocolLevel?: number;
  /**
   * Where the plugin runs, as its package.json declares it (an empty list: anywhere). A server tells "compatible with
   * this system" from them; an entry without them (an external plugin, a catalog older than these fields) is "not known".
   */
  os?: string[];
  cpu?: string[];
  engines?: Record<string, string>;
}

const CATEGORY_OVERRIDES: Record<string, Category> = {
  'camera-ui-audio-yamnet': 'detection',
  'camera-ui-coral': 'ai-model',
  'camera-ui-coreml': 'ai-model',
  'camera-ui-eufy': 'camera-source',
  'camera-ui-homeassistant': 'automation',
  'camera-ui-homekit': 'automation',
  'camera-ui-ncnn': 'ai-model',
  'camera-ui-nvr': 'recording',
  'camera-ui-onnx': 'ai-model',
  'camera-ui-onnx-legacy': 'ai-model',
  'camera-ui-onvif': 'camera-source',
  'camera-ui-opencl': 'ai-model',
  'camera-ui-opencv': 'ai-model',
  'camera-ui-openvino': 'ai-model',
  'camera-ui-openvino-legacy': 'ai-model',
  'camera-ui-pamdiff': 'detection',
  'camera-ui-reolink': 'camera-source',
  'camera-ui-ring': 'camera-source',
  'camera-ui-rust-motion': 'detection',
  'camera-ui-smtp': 'detection',
  'camera-ui-tuya': 'camera-source',
  'camera-ui-wasm-motion': 'detection',
  'camera-ui-wyze': 'camera-source',
  'camera-ui-xiaomi': 'camera-source',
  'camera-ui-yandex': 'automation',
};

const FEATURED = new Set<string>([
  'camera-ui-homeassistant',
  'camera-ui-homekit',
  'camera-ui-nvr',
  'camera-ui-rust-motion',
  'camera-ui-coreml',
  'camera-ui-openvino',
  'camera-ui-onnx',
]);

// Official plugins published to npm but sourced from a separate repo, so unavailable
// when this script runs. Their metadata is maintained here by hand; protocolLevel is
// only the fallback until the registry serves a stamped release.
const EXTERNAL_PLUGINS: Record<string, CatalogEntry> = {
  '@camera.ui/camera-ui-nvr': {
    displayName: 'NVR',
    category: 'recording',
    featured: true,
    tagline: 'Manage and store video recordings from your cameras.',
    logo: `${RAW_BASE}/external-logos/camera-ui-nvr.png`,
    screenshots: [],
    protocolLevel: 1,
  },
};

// Not in the registry yet, so not in the store: apple-llm is built on macOS only.
const DRAFT_PLUGINS = new Set<string>(['camera-ui-apple-llm']);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);

function discoverPlugins(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('camera-ui-'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ROOT, name, 'package.json')) && !DRAFT_PLUGINS.has(name))
    .sort();
}

function firstSentence(description: string): string {
  const text = (description || '').trim();
  const match = text.match(/^(.*?[.!?])(?=\s|$)/);
  return (match ? match[1] : text).trim();
}

function deriveCategory(dir: string): Category {
  const contractPath = resolve(dir, 'contract.ts');
  if (!existsSync(contractPath)) return 'other';

  const src = readFileSync(contractPath, 'utf-8');
  const role = src.match(/role:\s*PluginRole\.(\w+)/)?.[1] ?? '';
  const interfaces = [...src.matchAll(/PluginInterface\.(\w+)/g)].map((m) => m[1]);

  if (role === 'CameraController' || role === 'CameraAndSensorProvider') return 'camera-source';
  if (interfaces.includes('AssistantModels')) return 'ai-model';
  if (interfaces.some((name) => name.endsWith('Detection'))) return 'detection';
  if (role === 'SensorProvider') return 'utility';
  return 'other';
}

function collectScreenshots(folder: string, dir: string): string[] {
  const screenshotsDir = resolve(dir, 'screenshots');
  if (!existsSync(screenshotsDir)) return [];

  return readdirSync(screenshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .map((file) => `${RAW_BASE}/${folder}/screenshots/${file}`);
}

function readProtocolLevel(dir: string): number | undefined {
  const bundlePkgPath = resolve(dir, 'bundle', 'package.json');
  if (!existsSync(bundlePkgPath)) return undefined;
  const level = JSON.parse(readFileSync(bundlePkgPath, 'utf-8')).cameraui?.protocolLevel;
  return typeof level === 'number' ? level : undefined;
}

async function fetchExternalProtocolLevel(name: string): Promise<number | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
    if (!response.ok) return undefined;
    const pkg = (await response.json()) as { cameraui?: { protocolLevel?: unknown } };
    const level = pkg.cameraui?.protocolLevel;
    return typeof level === 'number' ? level : undefined;
  } catch {
    return undefined;
  }
}

/** The plugin's one-line description in `language`: its package description through its own dictionary. */
function describe(dir: string, description: string, language: string): string {
  const dictionaryPath = resolve(dir, 'i18n', `${language}.json`);
  const translated = existsSync(dictionaryPath) ? JSON.parse(readFileSync(dictionaryPath, 'utf-8'))[description] : undefined;
  return firstSentence(typeof translated === 'string' && translated.trim() ? translated : description);
}

function buildEntry(folder: string): { name: string; entry: CatalogEntry } {
  const dir = resolve(ROOT, folder);
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'));
  const name: string = pkg.name;
  const protocolLevel = readProtocolLevel(dir);
  const taglines = Object.fromEntries(LANGUAGES.map((language) => [language, { tagline: describe(dir, pkg.description, language) }]));

  const entry: CatalogEntry = {
    ...(pkg.displayName ? { displayName: pkg.displayName as string } : {}),
    category: CATEGORY_OVERRIDES[folder] ?? deriveCategory(dir),
    featured: FEATURED.has(folder),
    tagline: taglines[LANGUAGES[0]].tagline,
    i18n: taglines,
    ...(existsSync(resolve(dir, 'logo.png')) ? { logo: `${RAW_BASE}/${folder}/logo.png` } : {}),
    screenshots: collectScreenshots(folder, dir),
    ...(protocolLevel !== undefined ? { protocolLevel } : {}),
    os: pkg.os ?? [],
    cpu: pkg.cpu ?? [],
    ...(pkg.engines ? { engines: pkg.engines as Record<string, string> } : {}),
  };

  return { name, entry };
}

/**
 * What --check compares. `protocolLevel` is the one field that does not come from the repository: it is read from a
 * plugin's built bundle (bundle/package.json) and, for the external plugins, from the npm registry. A checkout in CI
 * has neither, so the field is left out on both sides: a catalog that is stale only in protocolLevel passes the check.
 */
function differences(committed: CatalogEntry, written: CatalogEntry): string[] {
  const [before, after] = [committed, written] as unknown as Record<string, unknown>[];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  fields.delete('protocolLevel');
  return [...fields]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => `${field} is ${JSON.stringify(before[field])}, scripts/catalog.ts writes ${JSON.stringify(after[field])}`);
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const folders = discoverPlugins();
  if (!folders.length) {
    console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red('No camera-ui-* plugins found.'));
    process.exit(1);
  }

  const catalog: Record<string, CatalogEntry> = {};
  for (const folder of folders) {
    const { name, entry } = buildEntry(folder);
    catalog[name] = entry;
  }

  for (const [name, entry] of Object.entries(EXTERNAL_PLUGINS)) {
    // --check does not compare protocolLevel, so it has nothing to ask the registry for
    const registryLevel = check ? undefined : await fetchExternalProtocolLevel(name);
    catalog[name] = registryLevel !== undefined ? { ...entry, protocolLevel: registryLevel } : entry;
  }

  const sorted: Record<string, CatalogEntry> = {};
  for (const name of Object.keys(catalog).sort()) {
    sorted[name] = catalog[name];
  }

  const outPath = resolve(ROOT, 'catalog.json');

  if (check) {
    const committed: Record<string, CatalogEntry> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf-8')) : {};
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(sorted)) {
      if (!committed[name]) {
        problems.push(`${name} is missing`);
        continue;
      }
      for (const difference of differences(committed[name], entry)) problems.push(`${name}: ${difference}`);
    }
    for (const name of Object.keys(committed)) {
      if (!sorted[name]) problems.push(`${name} belongs to no plugin`);
    }
    if (problems.length) {
      console.error('catalog.json is not what scripts/catalog.ts writes:');
      for (const problem of problems) console.error(`  - ${problem}`);
      // without the bundles the script would write a catalog with no protocolLevel at all
      console.error('\nRun `npm run catalog` with the plugins bundled (protocolLevel is read from the bundles) and commit the result.');
      process.exit(1);
    }
    console.log(`catalog.json describes ${Object.keys(sorted).length} plugin(s)`);
    return;
  }

  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');

  console.log(chalk.cyan(`\r\nWrote ${chalk.bold(String(Object.keys(sorted).length))} plugins to catalog.json\r\n`));
  for (const name of Object.keys(sorted)) {
    const { category, featured } = sorted[name];
    console.log(`  ${featured ? chalk.yellow('★') : ' '} ${chalk.bold(name)} ${chalk.gray('->')} ${category}`);
  }
  console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`catalog.json written to ${outPath}`));
}

await main();
