// The privacy zones of a camera (the zone editor's) over the pictures the recorder reads out of its own recording. The
// recording is the camera's raw video: the server masks what it looks at and the snapshots it sends, and the pictures
// of object_gone and place_history went to the model with what the zones hide. ffmpeg draws them black: a zone as
// bands of its height, each as wide as the zone is anywhere in it — never less than the zone, a little more at its
// slanted sides.

import type { PrivacyZone } from '@camera.ui/sdk';

import type { Place } from './gone.js';

/** The bands of a zone over the picture's height: a slanted side is covered to 1/36 of the height past it. */
export const PRIVACY_BANDS = 36;

/** A zone as the camera keeps it: points [x, y] in percent of the picture (as the server's mask reads them). */
export type PrivacyArea = Pick<PrivacyZone, 'points'>;

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** The black boxes over the zones, in shares of the picture. */
export function privacyBoxes(zones: readonly PrivacyArea[] | undefined): Place[] {
  const boxes: Place[] = [];
  for (const zone of zones ?? []) {
    const points = (zone.points ?? []).map(([x, y]) => ({ x: clamp(Number(x) / 100), y: clamp(Number(y) / 100) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length < 3) continue;
    const top = Math.min(...points.map((p) => p.y));
    const bottom = Math.max(...points.map((p) => p.y));
    for (let band = Math.floor(top * PRIVACY_BANDS); band < Math.ceil(bottom * PRIVACY_BANDS); band++) {
      const from = Math.max(top, band / PRIVACY_BANDS);
      const to = Math.min(bottom, (band + 1) / PRIVACY_BANDS);
      // where the zone is within the band: its corners in it and where its sides cross the band's edges
      const xs = points.filter((p) => p.y >= from && p.y <= to).map((p) => p.x);
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (a.y === b.y) continue;
        for (const y of [from, to]) if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      if (!xs.length) continue;
      const left = Math.min(...xs);
      boxes.push({ x: left, y: from, width: Math.max(...xs) - left, height: to - from });
    }
  }
  return boxes;
}

/** The zones as ffmpeg's filter, first of a chain on the decoded picture; undefined when the camera has none. */
export function privacyFilter(zones: readonly PrivacyArea[] | undefined): string | undefined {
  const boxes = privacyBoxes(zones);
  if (!boxes.length) return undefined;
  const share = (v: number) => clamp(v).toFixed(4);
  // a pixel more on each side: rounding never leaves a line of the zone open
  return boxes
    .map((b) => `drawbox=x=floor(iw*${share(b.x)}):y=floor(ih*${share(b.y)}):w=ceil(iw*${share(b.width)})+1:h=ceil(ih*${share(b.height)})+1:color=black:t=fill`)
    .join(',');
}
