// The privacy zones of a camera over the pictures the recorder reads out of its own recording (privacy.ts): black
// bands of each zone, together never less than the zone; no zones, no filter.
// Run: npx tsx spec/privacy.spec.ts
import assert from 'node:assert/strict';

import { PRIVACY_BANDS, privacyBoxes, privacyFilter } from '../src/privacy.js';

const covered = (boxes: ReturnType<typeof privacyBoxes>, x: number, y: number) =>
  boxes.some((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);

// a triangle, points in percent as the zone editor keeps them
const triangle = { points: [[10, 10], [70, 30], [20, 80]] as [number, number][] };
const boxes = privacyBoxes([triangle]);
assert.ok(boxes.length > 1 && boxes.length <= PRIVACY_BANDS, `${boxes.length} bands`);
// every point inside the triangle is under a band
const inside = (x: number, y: number) => {
  const [a, b, c] = triangle.points.map(([px, py]) => ({ x: px / 100, y: py / 100 }));
  const side = (p: { x: number; y: number }, q: { x: number; y: number }) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
  const s = [side(a, b), side(b, c), side(c, a)];
  return s.every((v) => v >= 0) || s.every((v) => v <= 0);
};
let points = 0;
for (let x = 0; x <= 1; x += 0.01)
  for (let y = 0; y <= 1; y += 0.01)
    if (inside(x, y)) {
      points++;
      assert.ok(covered(boxes, x, y), `${x.toFixed(2)},${y.toFixed(2)} uncovered`);
    }
assert.ok(points > 1000);
// and not much more than the triangle: the bands follow its sides
const area = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
assert.ok(area < 0.5 * 0.6 * 0.7 * 1.25, `bands ${area.toFixed(3)} of the triangle's ${(0.6 * 0.7 / 2).toFixed(3)}`);
assert.ok(!covered(boxes, 0.9, 0.9) && !covered(boxes, 0.05, 0.5), 'outside the zone stays');

// a zone past the picture is cut at it; a zone of less than three points hides nothing
const beyond = privacyBoxes([{ points: [[-20, 50], [120, 50], [120, 140], [-20, 140]] }]);
assert.ok(beyond.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= 1 && b.y + b.height <= 1));
assert.ok(covered(beyond, 0.5, 0.75) && covered(beyond, 0, 1));
assert.deepEqual(privacyBoxes([{ points: [[1, 1], [50, 50]] }]), []);

// the filter: none without zones, black filled boxes in shares of the picture with them
assert.equal(privacyFilter(undefined), undefined);
assert.equal(privacyFilter([]), undefined);
const filter = privacyFilter([triangle])!;
assert.equal(filter.split(',drawbox=').length, boxes.length);
assert.match(filter, /^drawbox=x=floor\(iw\*0\.\d+\):y=floor\(ih\*0\.\d+\):w=ceil\(iw\*0\.\d+\)\+1:h=ceil\(ih\*0\.\d+\)\+1:color=black:t=fill/);

console.log('privacy.spec: the bands of a zone cover it and little more, cut at the picture, no zones no filter OK');
