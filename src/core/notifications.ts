import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import type { RepoEntry } from './repo-context.js';

// Who of the team gets each email ronin sends them (#174, stage 4). Each
// person chooses, repo by repo, in Ajustes → Notificaciones; their choice
// and their email live in their entry of <SETTINGS_DATA_DIR>/people.json
// (domains/access/team.ts writes it, this only reads it, from any process).
//
// Until someone chooses, it works as before:
// - the request portal's emails go to the repo's portal.notifyTo (repos.json):
//   a person of the team whose email is there counts as subscribed, and the
//   addresses that are nobody's keep getting them;
// - blockers go to NOTIFY_TO, read the same way.
// And when nobody of the team gets one, NOTIFY_TO does: an email is never lost.

export const EVENTS = ['pedido-equipo', 'pedido-revisar', 'reunion', 'bloqueo'] as const;
export type NotifyEvent = (typeof EVENTS)[number];
export const isEvent = (value: unknown): value is NotifyEvent => typeof value === 'string' && (EVENTS as readonly string[]).includes(value);

// The events portal.notifyTo stood for; blockers were NOTIFY_TO's.
const PORTAL_EVENTS: NotifyEvent[] = ['pedido-equipo', 'pedido-revisar', 'reunion'];

interface Person {
  email?: string;
  // Per productRepo, the events chosen. Absent for a repo: the defaults.
  notify?: Record<string, NotifyEvent[]>;
}

const splitAddresses = (value: string | undefined) => (value ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);

// What the person gets in the repo before choosing: what .env and
// repos.json already sent to their email.
export function defaultEvents(email: string | undefined, entry: Pick<RepoEntry, 'portal'> | undefined): NotifyEvent[] {
  if (!email) return [];
  const mail = email.toLowerCase();
  return EVENTS.filter((event) => (event === 'bloqueo' ? splitAddresses(config.notifyTo) : (entry?.portal?.notifyTo ?? []).map((a) => a.toLowerCase())).includes(mail));
}

export function eventsOf(person: Person, repo: string, entry: Pick<RepoEntry, 'portal'> | undefined): NotifyEvent[] {
  return person.notify?.[repo] ?? defaultEvents(person.email, entry);
}

async function readPeople(): Promise<Record<string, Person>> {
  try {
    return (JSON.parse(await readFile(join(config.settings.dataDir, 'people.json'), 'utf8')) as { people?: Record<string, Person> }).people ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error('notificaciones: no se pudo leer people.json, uso los correos de .env y repos.json', error);
    return {};
  }
}

// The addresses that get `event` for the repo, comma-separated, as
// nodemailer takes them. Never empty: NOTIFY_TO when nobody else.
export async function recipientsFor(repo: string, entry: Pick<RepoEntry, 'portal'> | undefined, event: NotifyEvent): Promise<string> {
  const people = Object.values(await readPeople());
  const team = people.filter((p) => p.email);
  const chosen = team.filter((p) => eventsOf(p, repo, entry).includes(event)).map((p) => p.email!.toLowerCase());
  // The old lists' addresses that are nobody's in the team keep getting it.
  const theirs = new Set(team.map((p) => p.email!.toLowerCase()));
  const old = event === 'bloqueo' ? splitAddresses(config.notifyTo) : PORTAL_EVENTS.includes(event) ? (entry?.portal?.notifyTo ?? []).map((a) => a.toLowerCase()) : [];
  const to = [...new Set([...chosen, ...old.filter((a) => !theirs.has(a))])];
  return to.length ? to.join(', ') : config.notifyTo;
}
