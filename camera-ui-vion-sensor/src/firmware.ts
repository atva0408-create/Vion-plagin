/**
 * Firmware updates come from ViON Cloud: a manifest names the newest firmware, its address and its SHA-256. The
 * manifest is read here over checked TLS; the board downloads the file itself and refuses it unless the SHA-256 matches.
 */
export const DEFAULT_MANIFEST_URL = 'https://models.vionvision.tech/firmware/vion-sensor/manifest.json';

export interface FirmwareRelease {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

export async function readManifest(url: string): Promise<FirmwareRelease> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`the firmware list answered HTTP ${response.status}`);
  const data = (await response.json()) as Partial<FirmwareRelease>;
  if (!data.version || !data.url || !/^[0-9a-f]{64}$/i.test(data.sha256 ?? '')) throw new Error('the firmware list is not valid');
  // a relative address is relative to the manifest
  return { version: data.version, url: new URL(data.url, url).toString(), sha256: data.sha256!.toLowerCase(), notes: data.notes };
}

/** 1.2.10 > 1.2.9; anything that is not a version counts as older. */
export function newer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(candidate);
  const b = parse(current);
  if (a.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = Number.isNaN(b[i] ?? 0) ? -1 : (b[i] ?? 0);
    if (x !== y) return x > y;
  }
  return false;
}
