import { appendFileSync, readFileSync } from 'node:fs';

import { GO, NODE, PYTHON, PYTHON_VERSIONS } from './plugins.mjs';

const changed = JSON.parse(process.env.CHANGED || '[]');
const allNode = changed.includes('shared-node');
const allPython = changed.includes('shared-python');
const allGo = changed.includes('shared-go');

// A plugin made for another platform (camera-ui-apple-llm: darwin/arm64) is still built and linted on the Linux
// runner, its native parts skip themselves there; only npm's platform check has to be told (--force). Its specs run
// when the plugin has its own (`test` in package.json; the recorder's need the root packages, see ci.yml).
function nodeEntry(plugin, externals) {
  const pkg = JSON.parse(readFileSync(`${plugin}/package.json`, 'utf8'));
  const linux = (list) => !Array.isArray(list) || list.length === 0 || list.some((v) => v === 'linux' || v === 'x64' || v === '!darwin');
  return { plugin, externals, force: !(linux(pkg.os) && linux(pkg.cpu)), test: typeof pkg.scripts?.test === 'string' };
}

const node = Object.entries(NODE)
  .filter(([plugin]) => allNode || changed.includes(plugin))
  .map(([plugin, externals]) => nodeEntry(plugin, externals));

const python = PYTHON.filter((plugin) => allPython || changed.includes(plugin)).map((plugin) => ({
  plugin,
  python: PYTHON_VERSIONS[plugin] ?? '3.13',
}));

const go = Object.entries(GO)
  .filter(([plugin]) => allGo || changed.includes(plugin))
  .map(([plugin, externals]) => ({ plugin, externals }));

const out = `node=${JSON.stringify(node)}\npython=${JSON.stringify(python)}\ngo=${JSON.stringify(go)}\n`;
console.log(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
