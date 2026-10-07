/**
 * Presence at the computer: a box of the wanted label crossing the zone, from the object sensor of the camera.
 *
 * A child at a computer barely moves. The server then counts the person as "static": it drops out of detection
 * events but stays in the object sensor's `staticDetections` (and with motion cascade the sensor keeps its last value
 * while nothing moves). So presence reads both lists of the sensor on a timer instead of waiting for events, and the
 * face and attribute seen once in a session hold until the session ends: a child sitting with the back to the camera
 * shows no face for an hour.
 */

export type Point = [number, number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SeenDetection {
  label: string;
  box: Box;
}

export interface PresenceSource {
  zone: string;
  /** Detector labels that count as the child, `person` by default; a trained module adds its own label. */
  labels: string[];
  /** A trained attribute that must have been seen with "yes" ("за компьютером"). */
  attribute?: string;
  /** The face name that must have been seen, when several people use the computer. */
  face?: string;
}

function inside(point: Point, polygon: Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const aboveI = yi > point[1];
    const aboveJ = yj > point[1];
    if (aboveI !== aboveJ && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** Zone points of the camera are 0–100 (percent of the frame); boxes of the sensor are 0–1. */
export function boxCrossesZone(box: Box, zone: Point[]): boolean {
  if (zone.length < 3) return false;
  const polygon = zone.map(([x, y]) => [x / 100, y / 100] as Point);
  const corners: Point[] = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ];
  if (corners.some((corner) => inside(corner, polygon))) return true;
  if (polygon.some(([x, y]) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)) return true;
  for (let i = 0; i < 4; i++) {
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      if (crosses(corners[i], corners[(i + 1) % 4], polygon[k], polygon[j])) return true;
    }
  }
  return false;
}

/** What the camera saw at one look: boxes from the object sensor, names and attributes from its events. */
export interface Sighting {
  detections: SeenDetection[];
  faces: string[];
  /** Attribute answers: type → yes/no. */
  attributes: Record<string, boolean>;
}

/**
 * Raw presence of one look plus the name and attribute held for the session. `sessionEnded()` forgets them.
 */
export class PresenceTracker {
  private name: string | undefined;
  private attributeYes = false;

  constructor(
    private source: PresenceSource,
    private zone: () => Point[] | undefined,
  ) {}

  setSource(source: PresenceSource): void {
    this.source = source;
  }

  /** Whether the look counts as the child at the computer. */
  look(sighting: Sighting): boolean {
    const zone = this.zone();
    if (!zone) return false;
    const inZone = sighting.detections.some((d) => this.source.labels.includes(d.label) && boxCrossesZone(d.box, zone));
    if (!inZone) return false;

    const faces = sighting.faces.filter((face) => face && face !== 'unknown');
    if (faces.length) this.name = this.source.face && faces.includes(this.source.face) ? this.source.face : (this.name ?? faces[0]);
    if (this.source.face && this.name !== this.source.face) return false;

    if (this.source.attribute) {
      const answer = sighting.attributes[this.source.attribute];
      if (answer !== undefined) this.attributeYes = answer;
      if (!this.attributeYes) return false;
    }
    return true;
  }

  /** The name seen in this session, if any. */
  seenName(): string | undefined {
    return this.name;
  }

  sessionEnded(): void {
    this.name = undefined;
    this.attributeYes = false;
  }
}
