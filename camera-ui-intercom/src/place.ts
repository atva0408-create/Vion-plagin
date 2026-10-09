/**
 * Where a panel stands, for the door agent (ТЗ 12.4): the passage of the floor plan its doorbell is placed at, the rooms
 * on both sides of it and the notes of the owner ("parcels go into the box on the left"). The agent may then say "leave
 * it at the gate on the street side". The plan comes from the server's floor plan; without it the agent knows the
 * panel's name only.
 */
import type { Panel } from './types.js';

/** The part of the server's floor plan that is read here. */
export interface FloorPlanView {
  rooms: { rooms: { id: string; name: string; outdoor?: boolean; note?: string }[] };
  plan: {
    connections: { id: string; fromRoomId: string; toRoomId: string; note?: string; type?: string }[];
    sensors: { sensorId: string; roomId: string; connectionId: string | null; note?: string }[];
  };
}

export function placeOf(panel: Panel, plan: FloorPlanView | undefined): string | undefined {
  if (!plan) return undefined;
  const placed = plan.plan.sensors.find((s) => panel.doorbellSensorIds.includes(s.sensorId));
  if (!placed) return undefined;
  const room = (id: string) => plan.rooms.rooms.find((r) => r.id === id);
  const name = (id: string) => {
    const r = room(id);
    return r ? `"${r.name}"${r.outdoor ? ' (outdoors)' : ''}` : undefined;
  };
  const parts: string[] = [];
  const connection = placed.connectionId ? plan.plan.connections.find((c) => c.id === placed.connectionId) : undefined;
  if (connection) {
    const sides = [name(connection.fromRoomId), name(connection.toRoomId)].filter(Boolean);
    if (sides.length === 2) parts.push(`between ${sides[0]} and ${sides[1]}`);
    if (connection.note?.trim()) parts.push(connection.note.trim());
  } else {
    const where = name(placed.roomId);
    if (where) parts.push(`in ${where}`);
  }
  if (placed.note?.trim()) parts.push(placed.note.trim());
  const text = parts.join('; ');
  return text ? text.slice(0, 300) : undefined;
}
