// Cross-camera episodes: events of several cameras that belong to one visit (a person walking from the gate to
// the door, a car driving in and parking) are joined into one story. Linking is by rules, not by a model: the
// same kind of object appearing on another camera right after (or at the same time), or the same licence plate
// or known face within minutes. Every link is kept with its reason; that is what the episode trace shows.

import { facesOf, labelsOf, normalizePlate, platesOf } from './assistant.js';

import type { EpisodeRow, Store } from './store.js';
import type { RecordedEvent } from './types.js';

export interface EpisodeSegmentSpan {
  index: number;
  firstSeen: number;
  lastSeen: number;
}

export interface EpisodeMember {
  cameraId: string;
  eventId: string;
  segments: number[];
  firstSeen: number;
  lastSeen: number;
  segmentSpans?: EpisodeSegmentSpan[];
}

export interface EpisodeBlock {
  cameraId: string;
  startMs: number;
  endMs: number;
  secondAngle?: boolean;
}

export interface EpisodeText {
  title: string;
  description: string;
  summary: string;
  threatLevel: number;
}

export interface RecordedEpisode {
  id: string;
  startTime: number;
  endTime: number;
  members: EpisodeMember[];
  blocks?: EpisodeBlock[];
  description?: EpisodeText;
  favorite?: boolean;
}

export interface EpisodeLink {
  from: string;
  to: string;
  linked: boolean;
  why: string;
}

export interface EpisodeTraceMember {
  cameraId: string;
  eventId: string;
  firstSeen: number;
  lastSeen: number;
  segmentSpans: EpisodeSegmentSpan[];
  labels: string[];
  identities: string[];
}

export interface EpisodeTrace {
  episodeId: string;
  candidateId: string;
  startedAt: number;
  lastActivity: number;
  decidedAt: number;
  cameras: Record<string, string>;
  members: EpisodeTraceMember[];
  links: EpisodeLink[];
  blocks: EpisodeBlock[];
  images: { note: string }[];
  fixture: string;
}

/** The same kind of object on another camera within this gap (or at the same time) is the same visit. */
export const LINK_GAP_MS = 45_000;
/** The same plate or known face within this gap is the same visit, on any camera. */
export const IDENTITY_GAP_MS = 10 * 60_000;
/** A visit longer than this, or with more events, takes no more: a busy entrance must not become one all-day story. */
export const MAX_SPAN_MS = 15 * 60_000;
export const MAX_MEMBERS = 24;
/** A new event may start this much before the one it continues (clocks of two cameras, overlapping views). */
const START_TOLERANCE_MS = 10_000;
/** A candidate stays open while an identity link could still come. */
const CLOSE_AFTER_MS = IDENTITY_GAP_MS;
/** An event that never ended (crash, lost "end") stops holding its candidate open after this. */
const STALE_MS = 30 * 60_000;
/** Spans of one camera closer than this form one block. */
const JOIN_MS = 2000;

const CLASS_OF: Record<string, string> = {
  person: 'person',
  face: 'person',
  vehicle: 'vehicle',
  car: 'vehicle',
  truck: 'vehicle',
  bus: 'vehicle',
  motorcycle: 'vehicle',
  motorbike: 'vehicle',
  bicycle: 'vehicle',
  animal: 'animal',
  dog: 'animal',
  cat: 'animal',
  bird: 'animal',
  horse: 'animal',
};
const CLASS_ORDER = ['person', 'vehicle', 'animal'];
const CLASS_RU: Record<string, string> = { person: 'Человек', vehicle: 'Транспорт', animal: 'Животное' };

interface MemberState {
  eventId: string;
  cameraId: string;
  classes: Set<string>;
  identities: Set<string>;
  labels: string[];
  spans: EpisodeSegmentSpan[];
  firstSeen: number;
  lastSeen: number;
  ended: boolean;
  aiTitle?: string;
}

interface Candidate {
  id: string;
  members: Map<string, MemberState>;
  links: EpisodeLink[];
  startedAt: number;
  decidedAt?: number;
  favorite: boolean;
  /** JSON last written for this episode; an update that changes nothing is neither stored nor sent. */
  written?: string;
}

/** What one episode row stores: the episode as the UI gets it plus what the trace needs. */
interface StoredEpisode {
  episode: RecordedEpisode;
  links: EpisodeLink[];
  members: EpisodeTraceMember[];
  startedAt: number;
  decidedAt: number;
}

export interface EpisodeDeps {
  cameraName: (cameraId: string) => string;
  newId: () => string;
  now?: () => number;
}

export class Episodes {
  private readonly candidates = new Map<string, Candidate>();

  constructor(
    private readonly store: Store,
    private readonly deps: EpisodeDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Takes every update of every event. Returns the episode when it changed and should be sent to the UI:
   * a candidate becomes an episode once its events come from at least two cameras.
   */
  public offer(event: RecordedEvent): RecordedEpisode | undefined {
    this.sweep(this.now());
    const state = memberOf(event);
    const owner = this.ownerOf(event.id);
    if (owner) {
      owner.members.set(event.id, state);
      return this.commit(owner);
    }
    // motion without an object belongs to no story
    if (!state.classes.size && !state.identities.size) return undefined;

    let best: { candidate: Candidate; link: EpisodeLink; score: number } | undefined;
    for (const candidate of this.candidates.values()) {
      const found = linkTo(candidate, state, this.deps.cameraName);
      if (found && (!best || found.score > best.score)) best = { candidate, ...found };
    }
    if (!best) {
      const id = this.deps.newId();
      this.candidates.set(id, { id, members: new Map([[event.id, state]]), links: [], startedAt: this.now(), favorite: false });
      return undefined;
    }
    best.candidate.members.set(event.id, state);
    best.candidate.links.push(best.link);
    return this.commit(best.candidate);
  }

  /** Drops candidates nothing can join any more; their episodes stay stored. */
  public sweep(nowMs: number): void {
    for (const [id, candidate] of this.candidates) {
      const members = [...candidate.members.values()];
      const lastActivity = Math.max(...members.map((m) => m.lastSeen));
      const open = members.some((m) => !m.ended) && nowMs - lastActivity < STALE_MS;
      if (!open && nowMs - lastActivity > CLOSE_AFTER_MS) this.candidates.delete(id);
    }
  }

  /** Rebuilds the candidates of episodes that may still grow (restart in the middle of a visit). */
  public restore(loadEvent: (id: string) => RecordedEvent | undefined): void {
    const since = this.now() - CLOSE_AFTER_MS;
    for (const row of this.store.episodesEndingAfter(since)) {
      const stored = parse(row);
      if (!stored) continue;
      const members = new Map<string, MemberState>();
      for (const member of stored.episode.members) {
        const event = loadEvent(member.eventId);
        if (event) members.set(member.eventId, memberOf(event));
      }
      if (!members.size) continue;
      this.candidates.set(row.id, {
        id: row.id,
        members,
        links: stored.links,
        startedAt: stored.startedAt,
        decidedAt: stored.decidedAt,
        favorite: row.favorite === 1,
        written: row.data,
      });
    }
  }

  public list(opts: { startMs?: number; endMs?: number; limit?: number; favoritesOnly?: boolean } = {}): { episodes: RecordedEpisode[]; hasMore: boolean } {
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 500);
    const rows = this.store.episodes({
      fromMs: Number(opts.startMs) || 0,
      toMs: Number(opts.endMs) || Number.MAX_SAFE_INTEGER,
      limit: limit + 1,
      favoritesOnly: opts.favoritesOnly,
    });
    const episodes = rows
      .slice(0, limit)
      .map((row) => episodeOf(row))
      .filter((e): e is RecordedEpisode => !!e);
    return { episodes, hasMore: rows.length > limit };
  }

  public get(id: string): RecordedEpisode | undefined {
    const row = this.store.episode(id);
    return row ? episodeOf(row) : undefined;
  }

  public setFavorite(id: string, favorite: boolean): RecordedEpisode | undefined {
    const row = this.store.episode(id);
    const stored = row && parse(row);
    if (!stored) return undefined;
    stored.episode.favorite = favorite;
    const data = JSON.stringify(stored);
    this.store.setEpisodeFavorite(id, favorite, data);
    const candidate = this.candidates.get(id);
    if (candidate) {
      candidate.favorite = favorite;
      candidate.written = data;
    }
    return stored.episode;
  }

  /** Removes deleted events from their episodes; an episode left with fewer than two cameras is deleted (its id is returned). */
  public forgetEvents(eventIds: string[]): string[] {
    const deleted: string[] = [];
    if (!eventIds.length) return deleted;
    const gone = new Set(eventIds);
    const keep = (l: EpisodeLink) => !gone.has(l.from) && !gone.has(l.to);
    for (const [id, candidate] of this.candidates) {
      let changed = false;
      for (const eventId of gone) changed = candidate.members.delete(eventId) || changed;
      if (!changed) continue;
      candidate.links = candidate.links.filter(keep);
      if (!candidate.members.size) this.candidates.delete(id);
    }
    for (const episodeId of this.store.episodeIdsOfEvents(eventIds)) {
      const row = this.store.episode(episodeId);
      const stored = row && parse(row);
      if (!row || !stored) continue;
      const candidate = this.candidates.get(episodeId);
      const members = candidate ? sortedMembers(candidate) : stored.members.filter((m) => !gone.has(m.eventId)).map(stateOfStored);
      if (new Set(members.map((m) => m.cameraId)).size < 2) {
        this.store.deleteEpisode(episodeId);
        this.candidates.delete(episodeId);
        deleted.push(episodeId);
        continue;
      }
      // rebuilt like a new one, so the title and route no longer name what was deleted
      const { episode, data } = compose(episodeId, members, stored.links.filter(keep), stored.startedAt, stored.decidedAt, row.favorite === 1, this.deps.cameraName);
      if (candidate) candidate.written = data;
      this.store.upsertEpisode(
        { ...row, start_ms: episode.startTime, end_ms: episode.endTime, data },
        members.map((m) => m.eventId),
      );
    }
    return deleted;
  }

  public trace(id: string): EpisodeTrace | null {
    const row = this.store.episode(id);
    const stored = row && parse(row);
    if (!stored) return null;
    const { episode } = stored;
    const cameras: Record<string, string> = {};
    for (const member of episode.members) cameras[member.cameraId] = this.deps.cameraName(member.cameraId);
    return {
      episodeId: episode.id,
      candidateId: episode.id,
      startedAt: stored.startedAt,
      lastActivity: episode.endTime,
      decidedAt: stored.decidedAt,
      cameras,
      members: stored.members,
      links: stored.links,
      blocks: episode.blocks ?? [],
      images: episode.members.map((m) => ({ note: `${cameras[m.cameraId]} · ${clock(m.firstSeen - episode.startTime)}` })),
      fixture: JSON.stringify(
        { rules: { linkGapMs: LINK_GAP_MS, identityGapMs: IDENTITY_GAP_MS, maxSpanMs: MAX_SPAN_MS, maxMembers: MAX_MEMBERS }, members: stored.members },
        null,
        2,
      ),
    };
  }

  private ownerOf(eventId: string): Candidate | undefined {
    for (const candidate of this.candidates.values()) if (candidate.members.has(eventId)) return candidate;
    return undefined;
  }

  private commit(candidate: Candidate): RecordedEpisode | undefined {
    const members = sortedMembers(candidate);
    if (new Set(members.map((m) => m.cameraId)).size < 2) return undefined;
    candidate.decidedAt ??= this.now();
    const { episode, data } = compose(candidate.id, members, candidate.links, candidate.startedAt, candidate.decidedAt, candidate.favorite, this.deps.cameraName);
    if (data === candidate.written) return undefined;
    candidate.written = data;
    this.store.upsertEpisode(
      { id: episode.id, start_ms: episode.startTime, end_ms: episode.endTime, favorite: candidate.favorite ? 1 : 0, data },
      members.map((m) => m.eventId),
    );
    return episode;
  }
}

function sortedMembers(candidate: Candidate): MemberState[] {
  return [...candidate.members.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.eventId.localeCompare(b.eventId));
}

/** The episode as the UI gets it and the row data that also keeps what the trace shows. */
function compose(
  id: string,
  members: MemberState[],
  links: EpisodeLink[],
  startedAt: number,
  decidedAt: number,
  favorite: boolean,
  cameraName: (id: string) => string,
): { episode: RecordedEpisode; data: string } {
  const episode: RecordedEpisode = {
    id,
    startTime: Math.min(...members.map((m) => m.firstSeen)),
    endTime: Math.max(...members.map((m) => m.lastSeen)),
    members: members.map((m) => ({
      cameraId: m.cameraId,
      eventId: m.eventId,
      segments: m.spans.map((s) => s.index),
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
      segmentSpans: m.spans,
    })),
    blocks: buildBlocks(members),
    description: describe(members, cameraName),
    favorite,
  };
  const stored: StoredEpisode = {
    episode,
    links,
    members: members.map((m) => ({
      cameraId: m.cameraId,
      eventId: m.eventId,
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
      segmentSpans: m.spans,
      labels: m.labels,
      identities: [...m.identities],
      ...(m.aiTitle ? { aiTitle: m.aiTitle } : {}),
    })),
    startedAt,
    decidedAt,
  };
  return { episode, data: JSON.stringify(stored) };
}

/** A member as stored in an episode row (its event may be gone from memory). */
function stateOfStored(m: EpisodeTraceMember & { aiTitle?: string }): MemberState {
  return {
    eventId: m.eventId,
    cameraId: m.cameraId,
    classes: new Set(m.labels.map((label) => CLASS_OF[label]).filter((c): c is string => !!c)),
    identities: new Set(m.identities),
    labels: m.labels,
    spans: m.segmentSpans,
    firstSeen: m.firstSeen,
    lastSeen: m.lastSeen,
    ended: true,
    ...(m.aiTitle ? { aiTitle: m.aiTitle } : {}),
  };
}

// ------------------------------------------------------------------ rules

function memberOf(event: RecordedEvent): MemberState {
  const spans: EpisodeSegmentSpan[] = (event.segments ?? [])
    .map((segment, index) => ({ index, firstSeen: Number(segment?.firstSeen), lastSeen: Number(segment?.lastSeen) }))
    .filter((s) => Number.isFinite(s.firstSeen) && Number.isFinite(s.lastSeen) && s.firstSeen > 0)
    .map((s) => ({ ...s, lastSeen: Math.max(s.lastSeen, s.firstSeen) }));
  if (!spans.length) {
    const end = event.endTime ?? event.lastUpdate ?? event.startTime;
    spans.push({ index: 0, firstSeen: event.startTime, lastSeen: Math.max(end, event.startTime) });
  }
  const labels = labelsOf(event);
  const classes = new Set(labels.map((label) => CLASS_OF[label]).filter((c): c is string => !!c));
  const identities = new Set([...platesOf(event).map((p) => `plate:${normalizePlate(p)}`), ...facesOf(event).map((f) => `face:${f}`)]);
  if (identities.size && ![...identities].some((i) => i.startsWith('plate:')) && !classes.size) classes.add('person');
  if ([...identities].some((i) => i.startsWith('plate:')) && !classes.size) classes.add('vehicle');
  const aiTitle = event.ai?.title?.trim();
  return {
    eventId: event.id,
    cameraId: event.cameraId,
    classes,
    identities,
    labels,
    spans,
    firstSeen: Math.min(...spans.map((s) => s.firstSeen)),
    lastSeen: Math.max(...spans.map((s) => s.lastSeen)),
    ended: event.state === 'ended' || event.endTime !== undefined,
    ...(aiTitle ? { aiTitle } : {}),
  };
}

/** The best reason for `state` to join `candidate`, or undefined. Identity beats a camera transition. */
function linkTo(candidate: Candidate, state: MemberState, cameraName: (id: string) => string): { link: EpisodeLink; score: number } | undefined {
  const members = [...candidate.members.values()];
  if (members.length >= MAX_MEMBERS) return undefined;
  const start = Math.min(...members.map((m) => m.firstSeen));
  if (state.lastSeen - start > MAX_SPAN_MS) return undefined;

  let best: { link: EpisodeLink; score: number } | undefined;
  for (const m of members) {
    const gap = state.firstSeen - m.lastSeen;
    const distance = Math.max(gap, m.firstSeen - state.lastSeen, 0);
    const shared = [...state.identities].find((identity) => m.identities.has(identity));
    if (shared && distance <= IDENTITY_GAP_MS) {
      const score = 3 - distance / IDENTITY_GAP_MS;
      if (!best || score > best.score) best = { score, link: { from: m.eventId, to: state.eventId, linked: true, why: identityWhy(shared, m, state, gap, cameraName) } };
      continue;
    }
    const sameKind = [...state.classes].find((c) => m.classes.has(c));
    if (sameKind && m.cameraId !== state.cameraId && gap <= LINK_GAP_MS && state.firstSeen >= m.firstSeen - START_TOLERANCE_MS) {
      const score = 2 - Math.max(gap, 0) / LINK_GAP_MS;
      if (!best || score > best.score)
        best = { score, link: { from: m.eventId, to: state.eventId, linked: true, why: transitionWhy(sameKind, m, state, gap, cameraName) } };
    }
  }
  return best;
}

function identityWhy(identity: string, from: MemberState, to: MemberState, gap: number, cameraName: (id: string) => string): string {
  const [kind, value] = [identity.slice(0, identity.indexOf(':')), identity.slice(identity.indexOf(':') + 1)];
  const what = kind === 'plate' ? `тот же номер ${value}` : `то же лицо: ${value}`;
  const where = from.cameraId === to.cameraId ? `снова на «${cameraName(to.cameraId)}»` : `на «${cameraName(to.cameraId)}» после «${cameraName(from.cameraId)}»`;
  return `${what}, ${where}${gap > 0 ? ` через ${duration(gap)}` : ', одновременно'}`;
}

function transitionWhy(kind: string, from: MemberState, to: MemberState, gap: number, cameraName: (id: string) => string): string {
  const what = (CLASS_RU[kind] ?? kind).toLowerCase();
  const timing = gap > 0 ? `через ${duration(gap)} после «${cameraName(from.cameraId)}»` : `одновременно с «${cameraName(from.cameraId)}»`;
  return `${what} на «${cameraName(to.cameraId)}» ${timing}`;
}

// ------------------------------------------------------------------ blocks and text

/**
 * The order in which the player shows the cameras. Where two cameras see the visit at the same time, the one
 * that saw it first keeps the picture and the other is a second angle until the first loses it.
 */
export function buildBlocks(members: { cameraId: string; spans: EpisodeSegmentSpan[] }[]): EpisodeBlock[] {
  const spans = members
    .flatMap((m) => m.spans.map((s) => ({ cameraId: m.cameraId, startMs: s.firstSeen, endMs: Math.max(s.lastSeen, s.firstSeen) })))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const primary: EpisodeBlock[] = [];
  const angles: EpisodeBlock[] = [];
  let current: EpisodeBlock | undefined;
  for (const span of spans) {
    if (!current) {
      current = { ...span };
      continue;
    }
    if (span.cameraId === current.cameraId && span.startMs <= current.endMs + JOIN_MS) {
      current.endMs = Math.max(current.endMs, span.endMs);
      continue;
    }
    if (span.startMs < current.endMs) {
      angles.push({ cameraId: span.cameraId, startMs: span.startMs, endMs: Math.min(span.endMs, current.endMs), secondAngle: true });
      if (span.endMs > current.endMs) {
        primary.push(current);
        current = { cameraId: span.cameraId, startMs: current.endMs, endMs: span.endMs };
      }
      continue;
    }
    primary.push(current);
    current = { ...span };
  }
  if (current) primary.push(current);
  return [...primary.filter((b) => b.endMs > b.startMs || primary.length === 1), ...angles.filter((b) => b.endMs > b.startMs)];
}

function describe(members: MemberState[], cameraName: (id: string) => string): EpisodeText {
  const faces = unique(members.flatMap((m) => [...m.identities].filter((i) => i.startsWith('face:')).map((i) => i.slice(5))));
  const plates = unique(members.flatMap((m) => [...m.identities].filter((i) => i.startsWith('plate:')).map((i) => i.slice(6))));
  const kind = CLASS_ORDER.find((c) => members.some((m) => m.classes.has(c)));
  const subject = faces.length ? faces.join(', ') : plates.length ? `${CLASS_RU.vehicle} ${plates.join(', ')}` : (CLASS_RU[kind ?? ''] ?? 'Движение');

  // cameras in the order the visit reached them; a return to a camera is a new step
  const steps: { cameraId: string; at: number }[] = [];
  for (const m of members) if (steps.at(-1)?.cameraId !== m.cameraId) steps.push({ cameraId: m.cameraId, at: m.firstSeen });
  const start = members[0].firstSeen;
  const total = Math.max(...members.map((m) => m.lastSeen)) - start;
  const names = steps.map((s) => cameraName(s.cameraId));
  const path = names.length > 4 ? [...names.slice(0, 2), '…', ...names.slice(-2)].join(' → ') : names.join(' → ');
  const route = steps.map((s, i) => (i === 0 ? cameraName(s.cameraId) : `${cameraName(s.cameraId)} (через ${duration(s.at - start)})`)).join(' → ');
  const cameraCount = new Set(members.map((m) => m.cameraId)).size;
  const seen = unique(members.map((m) => m.aiTitle).filter((t): t is string => !!t));

  return {
    title: `${subject}: ${path}`,
    description: [
      `${route}.`,
      `Всего ${duration(total)}, ${cameraCount} ${plural(cameraCount, 'камера', 'камеры', 'камер')}.`,
      seen.length ? `Что видно: ${seen.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    summary: `${subject}, ${cameraCount} ${plural(cameraCount, 'камера', 'камеры', 'камер')}, ${duration(total)}`,
    threatLevel: 0,
  };
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
  return m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.floor(m / 60)} ч`;
}

function clock(offsetMs: number): string {
  return `+${duration(offsetMs)}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function parse(row: EpisodeRow): StoredEpisode | undefined {
  try {
    const stored = JSON.parse(row.data) as StoredEpisode;
    return stored?.episode?.id ? stored : undefined;
  } catch {
    return undefined;
  }
}

function episodeOf(row: EpisodeRow): RecordedEpisode | undefined {
  const stored = parse(row);
  return stored ? { ...stored.episode, favorite: row.favorite === 1 } : undefined;
}
