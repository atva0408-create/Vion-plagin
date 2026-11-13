// The part of multicast-dns 7 this plugin uses (the package ships no types).
declare module 'multicast-dns' {
  import type { EventEmitter } from 'node:events';

  export interface MdnsRecord {
    name: string;
    type: string;
    ttl?: number;
    class?: string;
    flush?: boolean;
    data: any;
  }

  export interface MdnsPacket {
    type: 'query' | 'response';
    questions?: { name: string; type: string }[];
    answers?: MdnsRecord[];
    additionals?: MdnsRecord[];
    authorities?: MdnsRecord[];
  }

  export interface MdnsRemote {
    address: string;
    port: number;
  }

  export interface MulticastDns extends EventEmitter {
    query(query: { questions: { name: string; type: string }[] }, callback?: (error?: Error | null) => void): void;
    destroy(callback?: () => void): void;
    on(event: 'response', listener: (packet: MdnsPacket, remote: MdnsRemote) => void): this;
    on(event: 'error' | 'warning', listener: (error: Error) => void): this;
    on(event: 'ready', listener: () => void): this;
  }

  export interface MdnsOptions {
    port?: number;
    multicast?: boolean;
    interface?: string;
    reuseAddr?: boolean;
    loopback?: boolean;
    ip?: string;
    ttl?: number;
    bind?: string | false;
  }

  export default function multicastDns(options?: MdnsOptions): MulticastDns;
}
