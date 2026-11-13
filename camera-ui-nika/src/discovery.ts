import { networkInterfaces } from 'node:os';

import multicastDns from 'multicast-dns';

import { SERVICE_NAME } from './protocol.js';

import type { MdnsPacket, MdnsRecord, MdnsRemote, MulticastDns } from 'multicast-dns';

/** A NIKA heard on the network. */
export interface FoundNika {
  id: string;
  name: string;
  room: string;
  version: string;
  proto: number;
  host: string;
  port: number;
  seenAt: number;
}

/** How often the network is asked who is NIKA; NIKA also announces herself when she starts. */
export const QUERY_EVERY_MS = 60_000;
/** A NIKA not heard of for this long is no longer listed as found (she answers each query while she runs). */
export const FORGET_AFTER_MS = 3 * QUERY_EVERY_MS + 15_000;

interface Instance {
  port?: number;
  target?: string;
  txt?: Record<string, string>;
  /** where her answers came from, and when: one copy comes through each network both machines share */
  from: Map<string, number>;
  seenAt: number;
}

/** A network of this machine. */
export interface LocalNet {
  address: string;
  netmask: string;
}

/** The IPv4 networks of this machine, without the loopback. */
export function localNets(): LocalNet[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => !!net && net.family === 'IPv4' && !net.internal)
    .map((net) => ({ address: net!.address, netmask: net!.netmask }));
}

function ipv4(text: string): number | undefined {
  const parts = text.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function onNet(address: string, net: LocalNet): boolean {
  const ip = ipv4(address);
  const own = ipv4(net.address);
  const mask = ipv4(net.netmask);
  return ip !== undefined && own !== undefined && mask !== undefined && (ip & mask) >>> 0 === (own & mask) >>> 0;
}

/**
 * The address to connect to her at, of those she names and those her answers came from, newest first in each rank:
 * an address of 169.254.x.x (a network adapter without a network) is never one, and an address of this machine itself
 * only when nothing else is there (VION and NIKA on one machine): both machines have 172.17.0.1 as their Docker bridge,
 * and a NIKA that names it sent VION to its own bridge.
 */
export function chooseAddress(named: Map<string, number>, from: Map<string, number>, nets: LocalNet[]): string | undefined {
  const own = new Set(nets.map((net) => net.address));
  const usable = (ip: string) => ipv4(ip) !== undefined && !ip.startsWith('169.254.');
  const local = (ip: string) => nets.some((net) => onNet(ip, net));
  const newest = (addresses: Map<string, number>) => [...addresses.entries()].sort((a, b) => b[1] - a[1]).map(([ip]) => ip);
  const heard = newest(from).filter(usable);
  const names = newest(named).filter(usable);
  return (
    heard.find(local) ?? names.find((ip) => local(ip) && !own.has(ip)) ?? heard[0] ?? names.find((ip) => !own.has(ip)) ?? names[0] ?? newest(from)[0] ?? newest(named)[0]
  );
}

export interface DiscoveryDeps {
  log: (message: string) => void;
  /** a NIKA was heard: one not connected may be at a new address */
  onChange?: () => void;
  now?: () => number;
  /** the mDNS socket; the specs give a stand-in */
  open?: () => MulticastDns;
  /** the networks of this machine; the specs give theirs */
  nets?: () => LocalNet[];
}

function txtOf(data: unknown): Record<string, string> {
  const parts = Array.isArray(data) ? data : [data];
  const values: Record<string, string> = {};
  for (const part of parts) {
    const text = Buffer.isBuffer(part) ? part.toString('utf8') : typeof part === 'string' ? part : '';
    const at = text.indexOf('=');
    if (at > 0) values[text.slice(0, at).toLowerCase()] = text.slice(at + 1);
  }
  return values;
}

/**
 * Who is NIKA on the network, by mDNS. Each answer is put together from its records (the instance's SRV gives the port
 * and host name, its TXT the id and names, the host's A record the address); what an answer lacks is asked for.
 */
export class Discovery {
  private mdns?: MulticastDns;
  private timer?: NodeJS.Timeout;
  private instances = new Map<string, Instance>();
  private hosts = new Map<string, Map<string, number>>();
  private waiters = new Set<() => void>();
  private failed = '';

  constructor(private readonly deps: DiscoveryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(): void {
    if (this.mdns) return;
    try {
      this.mdns = (this.deps.open ?? (() => multicastDns({ reuseAddr: true })))();
    } catch (error) {
      this.deps.log(`NIKA: the network cannot be searched (mDNS): ${(error as Error).message}. Connect NIKA by her address.`);
      return;
    }
    this.mdns.on('response', (packet, remote) => this.onPacket(packet, remote));
    this.mdns.on('error', (error) => {
      // said once while it stays the same
      if (error.message !== this.failed) this.deps.log(`NIKA: the network search (mDNS) failed: ${error.message}. Connect NIKA by her address.`);
      this.failed = error.message;
    });
    this.mdns.on('warning', () => undefined);
    this.query();
    // the asking alone does not keep the process alive: the plugin's own work does
    this.timer = setInterval(() => this.query(), QUERY_EVERY_MS).unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.mdns?.destroy();
    this.mdns = undefined;
  }

  query(): void {
    this.ask(SERVICE_NAME, 'PTR');
  }

  private ask(name: string, type: string): void {
    this.mdns?.query({ questions: [{ name, type }] }, (error) => {
      if (error && error.message !== this.failed) {
        this.failed = error.message;
        this.deps.log(`NIKA: the network was not asked (mDNS): ${error.message}`);
      }
    });
  }

  /** Every NIKA heard of lately, newest first. */
  list(): FoundNika[] {
    const now = this.now();
    const found = new Map<string, FoundNika>();
    for (const instance of this.instances.values()) {
      const nika = this.complete(instance);
      if (!nika || now - nika.seenAt > FORGET_AFTER_MS) continue;
      const known = found.get(nika.id);
      if (!known || known.seenAt < nika.seenAt) found.set(nika.id, nika);
    }
    return [...found.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  get(id: string): FoundNika | undefined {
    return this.list().find((nika) => nika.id === id);
  }

  /** The NIKA of this id, asking the network again and waiting up to `ms` when she is not known now. */
  async lookup(id: string, ms = 3_000): Promise<FoundNika | undefined> {
    const known = this.get(id);
    if (known || !this.mdns) return known;
    this.query();
    return new Promise((resolve) => {
      const finish = (nika: FoundNika | undefined) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(nika);
      };
      const check = () => {
        const nika = this.get(id);
        if (nika) finish(nika);
      };
      const timer = setTimeout(() => finish(this.get(id)), ms);
      this.waiters.add(check);
    });
  }

  /** Public for the specs. */
  onPacket(packet: MdnsPacket, remote?: MdnsRemote): void {
    if (packet.type !== 'response') return;
    const records: MdnsRecord[] = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    const touched = new Set<string>();
    const now = this.now();
    const suffix = `.${SERVICE_NAME}`.toLowerCase();
    for (const record of records) {
      const name = String(record.name ?? '');
      const lower = name.toLowerCase();
      if (record.type === 'PTR' && lower === SERVICE_NAME.toLowerCase()) {
        const instance = String(record.data ?? '');
        if (!instance) continue;
        if (record.ttl === 0) {
          // a goodbye: NIKA stops or leaves the network
          this.instances.delete(instance.toLowerCase());
          continue;
        }
        touched.add(instance.toLowerCase());
      } else if (record.type === 'SRV' && lower.endsWith(suffix)) {
        const data = (record.data ?? {}) as { port?: number; target?: string };
        const instance = this.instance(lower, now);
        instance.port = Number(data.port) || undefined;
        instance.target = data.target ? String(data.target).toLowerCase() : undefined;
        touched.add(lower);
      } else if (record.type === 'TXT' && lower.endsWith(suffix)) {
        this.instance(lower, now).txt = txtOf(record.data);
        touched.add(lower);
      } else if (record.type === 'A' && typeof record.data === 'string') {
        const addresses = this.hosts.get(lower) ?? new Map<string, number>();
        addresses.set(record.data, now);
        this.hosts.set(lower, addresses);
      }
    }
    for (const key of touched) {
      const instance = this.instance(key, now);
      instance.seenAt = now;
      if (remote?.address && !remote.address.includes(':')) instance.from.set(remote.address, now);
      // a short answer names the instance only: what it lacks is asked for
      if (!instance.port || !instance.target) this.ask(key, 'SRV');
      if (!instance.txt) this.ask(key, 'TXT');
      if (instance.target && !this.hosts.has(instance.target) && !instance.from.size) this.ask(instance.target, 'A');
    }
    if (!touched.size) return;
    for (const waiter of [...this.waiters]) waiter();
    this.deps.onChange?.();
  }

  private instance(key: string, now: number): Instance {
    let instance = this.instances.get(key);
    if (!instance) {
      instance = { seenAt: now, from: new Map() };
      this.instances.set(key, instance);
    }
    return instance;
  }

  private complete(instance: Instance): FoundNika | undefined {
    const txt = instance.txt;
    if (!txt?.id || !instance.port) return undefined;
    const fresh = (addresses: Map<string, number> | undefined) =>
      new Map([...(addresses ?? new Map<string, number>()).entries()].filter(([, at]) => this.now() - at <= FORGET_AFTER_MS));
    const host = chooseAddress(fresh(instance.target ? this.hosts.get(instance.target) : undefined), fresh(instance.from), (this.deps.nets ?? localNets)());
    if (!host) return undefined;
    return {
      id: txt.id,
      name: txt.name || 'NIKA',
      room: txt.room ?? '',
      version: txt.ver ?? '',
      proto: Number(txt.proto) || 1,
      host,
      port: instance.port,
      seenAt: instance.seenAt,
    };
  }
}
