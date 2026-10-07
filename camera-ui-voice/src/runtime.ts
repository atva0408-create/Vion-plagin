/**
 * Where the plugin runs from. The published bundle is CommonJS (the bundler turns `import.meta` into an empty object),
 * the sources run as ES modules (specs, tsx): the folder of the code and `require` come from whichever is there.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function codeDir(): string {
  return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

export function nativeRequire(id: string): unknown {
  const load = typeof require === 'function' ? require : createRequire(import.meta.url);
  return load(id);
}
