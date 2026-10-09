/**
 * Where the plugin runs from. The published bundle is CommonJS (the bundler turns `import.meta` into an empty object),
 * the sources run as ES modules (specs, tsx): the folder of the code and `require` come from whichever is there.
 * Each plugin keeps its own copy: in the speech package these would name the package's folder, not the plugin's.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function codeDir(): string {
  return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

export function nativeRequire(id: string): unknown {
  const load = typeof require === 'function' ? require : createRequire(import.meta.url);
  return load(id);
}

/** A folder shipped with the plugin (i18n, profiles): next to the code in the bundle, up from src/ in the sources. */
export function shippedDir(name: string, probe: string): string {
  let dir = codeDir();
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, name);
    try {
      readFileSync(join(candidate, probe));
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`${name}/ is missing from the plugin`);
}
