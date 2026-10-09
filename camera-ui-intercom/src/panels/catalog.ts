/**
 * The models of panels the owner can choose: the profiles shipped with the plugin, and newer ones fetched from the ViON
 * models mirror (`<VION_MODELS_HOST>/v1/intercom/profiles/catalog.json`), each checked by size and sha256, then by the
 * profile check, before it is kept. A profile is data only: fetching one never adds code. One that needs an engine
 * this version of the plugin does not have is listed as "needs a newer plugin" and cannot be chosen.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { modelsHost } from '@vionvision/speech';

import { ENGINES, checkProfile, versionAtLeast } from './profile.js';

import type { EngineId, PanelProfile } from './profile.js';

export interface CatalogEntry {
  id: string;
  version: number;
  file: string;
  size: number;
  sha256: string;
  engine: string;
  minPluginVersion: string;
}

export interface ModelChoice {
  profile: PanelProfile;
  source: 'built-in' | 'downloaded';
  usable: boolean;
  /** why it cannot be chosen */
  why?: string;
}

export interface RefreshResult {
  added: string[];
  updated: string[];
  failed: { id: string; reason: string }[];
}

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 512 * 1024;

export type CatalogFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export class ProfileCatalog {
  private profiles = new Map<string, ModelChoice>();

  constructor(
    private readonly builtInDir: string,
    private readonly storeDir: string,
    private readonly pluginVersion: string,
    private readonly fetcher: CatalogFetcher = (url, init) => fetch(url, init),
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Reads the shipped and the downloaded profiles; a downloaded one newer than the shipped one wins. */
  load(): void {
    this.profiles.clear();
    for (const [dir, source] of [
      [this.builtInDir, 'built-in'],
      [this.storeDir, 'downloaded'],
    ] as const) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith('.json') && file !== 'catalog.json');
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          this.add(JSON.parse(readFileSync(join(dir, file), 'utf8')), source);
        } catch (error) {
          this.log(`panel profile ${file}: ${(error as Error).message}`);
        }
      }
    }
  }

  list(): ModelChoice[] {
    return [...this.profiles.values()].sort((a, b) => a.profile.vendor.localeCompare(b.profile.vendor) || a.profile.id.localeCompare(b.profile.id));
  }

  /** A profile that can be used, by id. */
  get(id: string): PanelProfile | undefined {
    const choice = this.profiles.get(id);
    return choice?.usable ? choice.profile : undefined;
  }

  private usability(profile: PanelProfile): { usable: boolean; why?: string } {
    if (!ENGINES.includes(profile.engine)) return { usable: false, why: `engine "${profile.engine}" needs a newer version of the plugin` };
    if (!versionAtLeast(this.pluginVersion, profile.minPluginVersion)) return { usable: false, why: `needs the plugin ${profile.minPluginVersion} or newer` };
    return { usable: true };
  }

  private add(data: unknown, source: 'built-in' | 'downloaded'): PanelProfile {
    // an engine of a newer plugin: listed as such, not refused as a broken profile
    const engine = (data as { engine?: unknown })?.engine;
    const checked = checkProfile(typeof engine === 'string' && !ENGINES.includes(engine as EngineId) ? { ...(data as object), engine: 'generic' } : data);
    if (typeof checked === 'string') throw new Error(checked);
    const profile = typeof engine === 'string' ? ({ ...checked, engine } as PanelProfile) : checked;
    const current = this.profiles.get(profile.id);
    if (!current || profile.version > current.profile.version) this.profiles.set(profile.id, { profile, source, ...this.usability(profile) });
    return profile;
  }

  /** Fetches the catalog and every profile newer than the one there is. */
  async refresh(): Promise<RefreshResult> {
    const base = `${modelsHost()}/v1/intercom/profiles`;
    const result: RefreshResult = { added: [], updated: [], failed: [] };
    const response = await this.fetcher(`${base}/catalog.json`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${base}/catalog.json: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_CATALOG_BYTES) throw new Error('the catalog is too big');
    const entries = (JSON.parse(text) as { profiles?: CatalogEntry[] }).profiles ?? [];
    mkdirSync(this.storeDir, { recursive: true });
    for (const entry of entries) {
      const current = this.profiles.get(entry.id);
      if (current && current.profile.version >= entry.version) continue;
      try {
        if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.file)) throw new Error('a file name of letters, digits and dashes');
        if (!(entry.size > 0 && entry.size <= MAX_PROFILE_BYTES)) throw new Error('size');
        const got = await this.fetcher(`${base}/${entry.file}`, { signal: AbortSignal.timeout(30_000) });
        if (!got.ok) throw new Error(`HTTP ${got.status}`);
        const bytes = Buffer.from(await got.arrayBuffer());
        if (bytes.length !== entry.size) throw new Error(`${bytes.length} bytes instead of ${entry.size}`);
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('checksum mismatch');
        const data = JSON.parse(bytes.toString('utf8')) as { id?: unknown };
        if (data?.id !== entry.id) throw new Error(`the file is the profile "${String(data?.id)}"`);
        this.add(data, 'downloaded');
        writeFileSync(join(this.storeDir, `${entry.id}.json`), bytes);
        (current ? result.updated : result.added).push(entry.id);
      } catch (error) {
        result.failed.push({ id: entry.id, reason: (error as Error).message });
        this.log(`panel profile ${entry.id} from the mirror: ${(error as Error).message}`);
      }
    }
    return result;
  }
}
