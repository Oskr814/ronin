import { sql } from 'kysely';
import pg from 'pg';
import type { Db } from '@platform/db/db.js';
import { log } from '@platform/logger.js';

// What changed, for every screen open on it (#446): a process that changes
// something (the API, a worker in the runner) says so with NOTIFY, and the
// API, which LISTENs, hands it to the tablero's streams. Small on purpose:
// it names what changed, and the page reads it again. Postgres caps a
// notification at 8000 bytes.
export interface LiveEvent {
  type: string;
  repo?: string;
  number?: number;
  [key: string]: unknown;
}

export const CHANNEL = 'ronin_events';

export async function publish(db: Db, event: LiveEvent, channel = CHANNEL): Promise<void> {
  await sql`select pg_notify(${channel}, ${JSON.stringify(event)})`.execute(db);
}

// Publishing never fails what changed: the screens catch up on their next read.
export function publishQuietly(db: Db, event: LiveEvent, channel = CHANNEL): void {
  void publish(db, event, channel).catch((error) => log.error(`eventos: no se pudo avisar ${event.type}`, error));
}

type Listener = (event: LiveEvent) => void;

// One connection that LISTENs, shared by every stream of the process; if it
// drops, it connects again after a pause. `onReconnect` lets the streams
// tell their pages to read again what they may have missed.
export class EventHub {
  private listeners = new Set<Listener>();
  private client: pg.Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(private url: string, private channel = CHANNEL, private retryMs = 5000) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const client = new pg.Client({ connectionString: this.url });
    client.on('notification', (message) => {
      if (message.channel !== this.channel || !message.payload) return;
      let event: LiveEvent;
      try {
        event = JSON.parse(message.payload) as LiveEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    });
    client.on('error', (error) => {
      log.error('eventos: se cortó la conexión que escucha', error);
      this.again();
    });
    client.on('end', () => this.again());
    try {
      await client.connect();
      await client.query(`LISTEN ${pg.escapeIdentifier(this.channel)}`);
      this.client = client;
    } catch (error) {
      log.error('eventos: no se pudo escuchar', error);
      await client.end().catch(() => {});
      this.again();
    }
  }

  private again(): void {
    if (this.stopped || this.retry) return;
    this.client = null;
    this.retry = setTimeout(() => {
      this.retry = null;
      for (const listener of this.listeners) listener({ type: 'reconnected' });
      void this.start();
    }, this.retryMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}

let shared: EventHub | null | undefined;

// The process's hub, started on first use, or null without DATABASE_URL.
export function eventHub(): EventHub | null {
  if (shared === undefined) {
    shared = process.env.DATABASE_URL ? new EventHub(process.env.DATABASE_URL) : null;
    void shared?.start();
  }
  return shared;
}
