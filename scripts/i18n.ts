// Every plugin ships its texts in the languages of the ViON interface:
//
//   README.md, CHANGELOG.md                 English, written for the customer
//   i18n/README.<lang>.md                   the same page in the other languages
//   i18n/CHANGELOG.<lang>.md
//   i18n/<lang>.json                        settings texts: { "<text as written in the code>": "<text in that language>" }
//
// `i18n` is listed in `additionalFiles` of cameraui.config.ts, so it lands in the bundle (dist/i18n) where the
// server reads it. The server falls back to the text from the code when a translation is missing, so a gap is not
// an error on screen, it is a foreign sentence in the middle of the settings. This script is what finds the gaps.
//
//   npm run i18n              check every plugin, exit 1 on a gap
//   npm run i18n -- --sync    add the texts the code gained (empty, to be translated), drop the ones it lost
//
// Written without dependencies and with erasable types only: `node scripts/i18n.ts` runs it as is.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Languages of the ViON interface (ui/src/i18n/locales in the VIONN- repo). The first one is the language of
// README.md and CHANGELOG.md.
export const LANGUAGES = ['en', 'ru', 'de'];
const BASE_LANGUAGE = LANGUAGES[0];

// Schema fields the interface prints (JsonSchema in the SDK): everything else in a schema is data.
const TEXT_KEYS = ['title', 'description', 'placeholder', 'group'];
const LABELS_KEY = 'enumLabels';

const SKIP_FILE_MARK = 'i18n-skip-file';

// The legacy variants take their code and build config from the regular plugin when they are built (their
// scripts/sync.mjs), and neither is in the repository: both are read from where they come from.
const BUILT_FROM: Record<string, string> = {
  'camera-ui-onnx-legacy': 'camera-ui-onnx',
  'camera-ui-openvino-legacy': 'camera-ui-openvino',
};

function codeDir(pluginDir: string): string {
  const base = BUILT_FROM[basename(pluginDir)];
  return base ? join(dirname(pluginDir), base) : pluginDir;
}

const SOURCE_EXTENSIONS = ['.ts', '.py', '.go'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'bundle', 'build', 'target', 'spec', 'test', 'tests', 'externals', 'i18n', '__pycache__', '.venv']);

// What a customer page must not carry: a way out of the product, or the names of where the code came from.
const FORBIDDEN_IN_DOCS: [RegExp, string][] = [
  [/https?:\/\//i, 'a web address'],
  [/\]\(/, 'a link'],
  [/<a\s/i, 'a link'],
  [/github/i, '"GitHub"'],
  [/\bnpm\b/i, '"npm"'],
  [/camera[.\s-]ui/i, 'the upstream product name'],
  [/seydx/i, 'the upstream author'],
];

interface Literal {
  value: string;
  end: number;
}

/** One string literal at `at` (JS/TS/Go/Python quoting), or undefined when what stands there is not a plain literal. */
function readLiteral(source: string, at: number): Literal | undefined {
  let index = at;
  // Python prefixes; a formatted string is assembled at run time and has no fixed text to translate
  const prefix = /^[rRbBuUfF]{0,2}(?=['"])/.exec(source.slice(index, index + 3))?.[0] ?? '';
  if (/f/i.test(prefix)) return undefined;
  index += prefix.length;
  const raw = /r/i.test(prefix);

  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  const triple = quote !== '`' && source.startsWith(quote.repeat(3), index);
  const close = triple ? quote.repeat(3) : quote;
  index += close.length;

  let value = '';
  while (index < source.length) {
    if (source.startsWith(close, index)) {
      return { value, end: index + close.length };
    }
    const char = source[index];
    if (quote === '`' && char === '$' && source[index + 1] === '{') return undefined;
    if (char === '\n' && !triple && quote !== '`') return undefined;
    if (char === '\\' && !raw) {
      const next = source[index + 1];
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\n': '' };
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
        value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      }
      value += escapes[next] ?? next;
      index += 2;
      continue;
    }
    value += char;
    index++;
  }
  return undefined;
}

function skipSpace(source: string, at: number): number {
  let index = at;
  while (index < source.length) {
    if (/\s/.test(source[index])) index++;
    else if (source[index] === '#' || source.startsWith('//', index)) index = source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index);
    else break;
  }
  return index;
}

/**
 * The text a schema field is given: one literal, or literals glued together ("a" "b" in Python, 'a' + 'b' in
 * TypeScript), optionally in brackets. Anything else (a variable, a call, a formatted string) is not a fixed text.
 */
function readText(source: string, at: number): string | undefined {
  let index = skipSpace(source, at);
  let depth = 0;
  while (source[index] === '(') {
    depth++;
    index = skipSpace(source, index + 1);
  }

  let text = '';
  let parts = 0;
  for (;;) {
    const literal = readLiteral(source, index);
    if (!literal) return undefined;
    text += literal.value;
    parts++;
    index = skipSpace(source, literal.end);
    if (source[index] === '+') {
      index = skipSpace(source, index + 1);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') continue;
    break;
  }

  while (depth > 0 && source[index] === ')') {
    depth--;
    index = skipSpace(source, index + 1);
  }
  // what follows must end the value: more of an expression (`.format(`, `if`, `%`) means the text is built at run time
  if (depth > 0 || !/^[,})\]\n;]|^$/.test(source[index] ?? '')) return undefined;
  return parts > 0 ? text : undefined;
}

/** Texts of the labels object `{ value: 'Label', ... }`: only the fixed ones, spreads and variables are skipped. */
function readLabels(source: string, at: number): string[] {
  const start = skipSpace(source, at);
  if (source[start] !== '{') return [];
  const labels: string[] = [];
  let index = start + 1;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === "'" || char === '"' || char === '`') {
      const literal = readLiteral(source, index);
      if (!literal) break;
      // a key is followed by ':', a label by ',' or the closing bracket
      const after = source[skipSpace(source, literal.end)];
      if (after !== ':' && literal.value.trim()) labels.push(literal.value);
      index = literal.end;
      continue;
    }
    index++;
  }
  return labels;
}

/** Fixed texts a source file hands to the settings forms. Go writes the same fields as struct members (`Title:`). */
export function extractTexts(source: string, go = false): string[] {
  const texts: string[] = [];
  const names = [...TEXT_KEYS, LABELS_KEY].map((name) => (go ? name[0].toUpperCase() + name.slice(1) : name));
  const field = new RegExp(`(?:\\b|["'])(${names.join('|')})["']?\\s*:`, 'g');
  for (let match = field.exec(source); match; match = field.exec(source)) {
    const after = match.index + match[0].length;
    if (match[1].toLowerCase() === LABELS_KEY.toLowerCase()) {
      texts.push(...readLabels(source, after));
    } else {
      const text = readText(source, after);
      if (text?.trim()) texts.push(text);
    }
  }
  return texts;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) files.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

/** Every text of a plugin that needs a translation: its description and what its settings forms print. */
export function pluginTexts(pluginDir: string): string[] {
  const texts = new Set<string>();
  const description = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).description;
  if (typeof description === 'string' && description.trim()) texts.add(description);
  const code = codeDir(pluginDir);
  for (const file of sourceFiles(code)) {
    // the build config and the contract describe the plugin to the build, not to people
    if (['cameraui.config.ts', 'contract.ts', 'eslint.config.js'].includes(relative(code, file))) continue;
    const source = readFileSync(file, 'utf8');
    // a file whose `description`s are read by a model, not by people (tool and answer schemas), says so itself
    if (source.includes(SKIP_FILE_MARK)) continue;
    for (const text of extractTexts(source, file.endsWith('.go'))) texts.add(text);
  }
  return [...texts];
}

function readDictionary(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path}: expected an object of texts`);
  return data;
}

function versions(changelog: string): string[] {
  return [...changelog.matchAll(/^##\s*\[([^\]]+)\]/gm)].map((match) => match[1]);
}

function docPath(pluginDir: string, name: string, language: string): string {
  return language === BASE_LANGUAGE ? join(pluginDir, `${name}.md`) : join(pluginDir, 'i18n', `${name}.${language}.md`);
}

function sync(pluginDir: string): void {
  const texts = pluginTexts(pluginDir);
  mkdirSync(join(pluginDir, 'i18n'), { recursive: true });
  for (const language of LANGUAGES) {
    const path = join(pluginDir, 'i18n', `${language}.json`);
    const known = readDictionary(path) ?? {};
    const next: Record<string, string> = {};
    for (const text of texts) next[text] = typeof known[text] === 'string' ? known[text] : '';
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  }
}

export function check(pluginDir: string): string[] {
  const problems: string[] = [];
  const texts = pluginTexts(pluginDir);

  for (const language of LANGUAGES) {
    const path = join(pluginDir, 'i18n', `${language}.json`);
    let dictionary: Record<string, string> | undefined;
    try {
      dictionary = readDictionary(path);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    if (!dictionary) {
      problems.push(`i18n/${language}.json is missing`);
      continue;
    }
    for (const text of texts) {
      const translation = dictionary[text];
      if (typeof translation !== 'string' || !translation.trim()) problems.push(`i18n/${language}.json: no translation for ${JSON.stringify(text)}`);
    }
    for (const key of Object.keys(dictionary)) {
      if (!texts.includes(key)) problems.push(`i18n/${language}.json: ${JSON.stringify(key)} is not a text of the plugin any more (run --sync)`);
    }
  }

  for (const name of ['README', 'CHANGELOG']) {
    const pages: Record<string, string> = {};
    for (const language of LANGUAGES) {
      const path = docPath(pluginDir, name, language);
      if (!existsSync(path) || !readFileSync(path, 'utf8').trim()) {
        problems.push(`${relative(pluginDir, path).replace(/\\/g, '/')} is missing`);
        continue;
      }
      pages[language] = readFileSync(path, 'utf8');
      for (const [pattern, what] of FORBIDDEN_IN_DOCS) {
        const found = pages[language].split('\n').findIndex((line) => pattern.test(line));
        if (found !== -1) problems.push(`${relative(pluginDir, path).replace(/\\/g, '/')}:${found + 1} carries ${what}`);
      }
    }
    if (name === 'CHANGELOG' && pages[BASE_LANGUAGE]) {
      const expected = versions(pages[BASE_LANGUAGE]).join(' ');
      for (const language of LANGUAGES.slice(1)) {
        if (pages[language] && versions(pages[language]).join(' ') !== expected) {
          problems.push(`i18n/CHANGELOG.${language}.md lists other versions than CHANGELOG.md`);
        }
      }
    }
  }

  const config = join(codeDir(pluginDir), 'cameraui.config.ts');
  if (!existsSync(config) || !/additionalFiles:\s*\[[^\]]*['"]i18n['"]/s.test(readFileSync(config, 'utf8'))) {
    problems.push(`cameraui.config.ts: 'i18n' is not in additionalFiles, the translations would not be shipped`);
  }

  return problems;
}

/**
 * The interface looks a text up without knowing which plugin a field belongs to, in one dictionary made of all
 * installed plugins. So a text that several plugins share must be translated the same way in each of them:
 * otherwise what the customer reads depends on which plugins happen to be installed.
 */
export function conflicts(names: string[]): string[] {
  const seen = new Map<string, Map<string, string[]>>();
  for (const name of names) {
    for (const language of LANGUAGES) {
      let dictionary: Record<string, string> | undefined;
      try {
        dictionary = readDictionary(join(ROOT, name, 'i18n', `${language}.json`));
      } catch {
        // reported by check()
      }
      for (const [text, translation] of Object.entries(dictionary ?? {})) {
        if (typeof translation !== 'string' || !translation.trim()) continue;
        const key = `${language}\n${text}`;
        const wordings = seen.get(key) ?? new Map<string, string[]>();
        wordings.set(translation, [...(wordings.get(translation) ?? []), name]);
        seen.set(key, wordings);
      }
    }
  }

  const problems: string[] = [];
  for (const [key, wordings] of seen) {
    if (wordings.size < 2) continue;
    const [language, text] = key.split('\n');
    const variants = [...wordings].map(([translation, where]) => `${JSON.stringify(translation)} in ${where.join(', ')}`);
    problems.push(`${language}: ${JSON.stringify(text)} is translated differently: ${variants.join(' / ')}`);
  }
  return problems;
}

function plugins(): string[] {
  return readdirSync(ROOT)
    .filter((name) => name.startsWith('camera-ui-') && statSync(join(ROOT, name)).isDirectory() && existsSync(join(ROOT, name, 'package.json')))
    .sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const only = args.filter((arg) => !arg.startsWith('--'));
  const selected = plugins().filter((name) => !only.length || only.includes(name));

  if (args.includes('--sync')) {
    for (const name of selected) sync(join(ROOT, name));
  }

  let failed = 0;
  for (const name of selected) {
    const problems = check(join(ROOT, name));
    if (problems.length) {
      failed++;
      console.error(`\n${name}: ${problems.length} problem(s)`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
  }

  // across all plugins, whichever were selected: the dictionaries meet on the customer's server
  const differing = conflicts(plugins());
  if (differing.length) {
    console.error(`\n${differing.length} text(s) shared by several plugins are translated differently`);
    for (const problem of differing) console.error(`  - ${problem}`);
  }

  if (failed || differing.length) {
    if (failed) console.error(`\n${failed} of ${selected.length} plugin(s) are not fully translated into: ${LANGUAGES.join(', ')}`);
    process.exit(1);
  }
  console.log(`${selected.length} plugin(s) are translated into: ${LANGUAGES.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
