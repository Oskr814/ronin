import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../core/config.js';
import { log } from '../../core/logger.js';
import type { RepoEntry } from '../../core/repo-context.js';
import { linearKey, teamPeople } from '../../core/linear-api.js';
import { applySettings, invalidValue, readSettingsSync, settingDef, settingsPath, settingsView, type SettingsFile } from '../../core/settings.js';
import { readJson, withJson } from '../../portal/json-store.js';

// The dashboard's Ajustes (#174), stage 1:
//   GET  /api/ajustes           the person's profile, and for an admin the settings of General
//   POST /api/ajustes/perfil    { name?, email?, linear?: { repo, id } }: their own profile
//   POST /api/ajustes/valores   { key, value }: a setting (admins); value null goes back to .env's
//   GET  /api/ajustes/registro  every change made here, newest first (admins)
//
// Everything lives in SETTINGS_DATA_DIR: settings.json (core/settings.ts),
// people.json (each login's profile) and registro.jsonl (one line per
// change, never rewritten).

export class AjustesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Profile {
  name?: string;
  email?: string;
  // Who they are in each repo's Linear team, by productRepo.
  linear?: Record<string, { id: string; name: string }>;
}

interface PeopleFile {
  people: Record<string, Profile>;
}

export interface RegistroEntry {
  at: string;
  login: string;
  // What changed, in words ("General · portal.dailyLimit", "Perfil · correo").
  what: string;
  from: string;
  to: string;
}

const NAME_MAX = 120;
const EMAIL_MAX = 254;
const REGISTRO_MAX = 300;
const LINEAR_TTL_MS = 10 * 60_000;

const peoplePath = () => join(config.settings.dataDir, 'people.json');
const registroPath = () => join(config.settings.dataDir, 'registro.jsonl');
const emptyPeople = (): PeopleFile => ({ people: {} });
const emptySettings = (): SettingsFile => ({ values: {} });
const isEmail = (email: string) => email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

async function record(entry: Omit<RegistroEntry, 'at'>, now = new Date()): Promise<void> {
  await mkdir(config.settings.dataDir, { recursive: true, mode: 0o700 });
  await appendFile(registroPath(), `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export async function profileOf(login: string): Promise<Profile> {
  return (await readJson(peoplePath(), emptyPeople)).people[login] ?? {};
}

// Each repo the person sees that has Linear, with its team's people, read
// once every few minutes. A Linear that doesn't answer leaves that repo out.
const linearCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof teamPeople>> }>();
export async function linearTeams(entries: RepoEntry[], now = Date.now()) {
  const teams = await Promise.all(entries.map(async (entry) => {
    const key = linearKey(entry);
    if (!key) return null;
    const cached = linearCache.get(entry.productRepo);
    let value = cached && now - cached.at < LINEAR_TTL_MS ? cached.value : undefined;
    if (value === undefined) {
      value = await teamPeople(entry, key).catch((error) => {
        log.error(`ajustes: no se pudo leer el equipo de Linear de ${entry.productRepo}`, error);
        return cached?.value ?? null;
      });
      linearCache.set(entry.productRepo, { at: now, value });
    }
    return value ? { repo: entry.productRepo, ...value } : null;
  }));
  return teams.filter((t) => t !== null);
}

export async function ajustesView(login: string, admin: boolean, entries: RepoEntry[]): Promise<unknown> {
  return {
    me: { login, admin },
    perfil: await profileOf(login),
    linear: await linearTeams(entries),
    ...(admin ? {
      general: settingsView(readSettingsSync(config.settings.dataDir)),
      portal: { url: config.portal.url },
      dashboard: { url: config.dashboard.url },
    } : {}),
  };
}

const shown = (value: number | undefined, source: string) => (value === undefined ? '—' : `${value}${source ? ` (${source})` : ''}`);

// POST /api/ajustes/valores: saves one, applies it to this process's config
// right away, and records it.
export async function setValue(login: string, body: Record<string, unknown>): Promise<unknown> {
  const def = typeof body.key === 'string' ? settingDef(body.key) : undefined;
  if (!def) throw new AjustesError('Ese ajuste no existe.');
  const value = body.value;
  if (value !== null) {
    const problem = invalidValue(def, value);
    if (problem) throw new AjustesError(problem);
  }
  const before = settingsView(readSettingsSync(config.settings.dataDir)).find((s) => s.key === def.key)!;
  await withJson(settingsPath(config.settings.dataDir), emptySettings, (file) => {
    file.values ??= {};
    if (value === null) delete file.values[def.key];
    else file.values[def.key] = value as number;
  });
  applySettings(config as unknown as Record<string, unknown>, readSettingsSync(config.settings.dataDir));
  const after = settingsView(readSettingsSync(config.settings.dataDir)).find((s) => s.key === def.key)!;
  if (before.value !== after.value || before.source !== after.source) {
    await record({ login, what: `General · ${def.key}`, from: shown(before.value, before.source === 'tablero' ? '' : before.source === 'env' ? '.env' : 'por defecto'), to: shown(after.value, after.source === 'tablero' ? '' : after.source === 'env' ? '.env' : 'por defecto') });
    log.info(`ajustes: ${login} cambió ${def.key} a ${after.value} (${after.source})`);
  }
  return { setting: after };
}

// POST /api/ajustes/perfil: only the person's own. An empty string clears a field.
export async function saveProfile(login: string, body: Record<string, unknown>, teams: Array<{ repo: string; people: Array<{ id: string; name: string }> }>): Promise<unknown> {
  const changes: Array<Omit<RegistroEntry, 'at' | 'login'>> = [];
  const profile = await withJson(peoplePath(), emptyPeople, (file) => {
    const p: Profile = { ...(file.people[login] ?? {}) };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length > NAME_MAX) throw new AjustesError(`El nombre puede tener hasta ${NAME_MAX} caracteres.`);
      const name = body.name.trim();
      if ((p.name ?? '') !== name) changes.push({ what: 'Perfil · nombre', from: p.name ?? '—', to: name || '—' });
      if (name) p.name = name;
      else delete p.name;
    }
    if (body.email !== undefined) {
      if (typeof body.email !== 'string') throw new AjustesError('El correo no es válido.');
      const email = body.email.trim().toLowerCase();
      if (email && !isEmail(email)) throw new AjustesError('Ese correo no es válido.');
      if ((p.email ?? '') !== email) changes.push({ what: 'Perfil · correo', from: p.email ?? '—', to: email || '—' });
      if (email) p.email = email;
      else delete p.email;
    }
    if (body.linear !== undefined) {
      const { repo, id } = (body.linear ?? {}) as { repo?: unknown; id?: unknown };
      const team = teams.find((t) => t.repo === repo);
      if (!team) throw new AjustesError('Ese repo no tiene Linear, o no lo ves.');
      const person = id === null || id === '' ? null : team.people.find((x) => x.id === id);
      if (person === undefined) throw new AjustesError('Esa persona no está en el equipo de Linear.');
      const linear = { ...(p.linear ?? {}) };
      const was = linear[team.repo]?.name ?? '—';
      if (person) linear[team.repo] = { id: person.id, name: person.name };
      else delete linear[team.repo];
      if (was !== (person?.name ?? '—')) changes.push({ what: `Perfil · Linear de ${team.repo}`, from: was, to: person?.name ?? '—' });
      if (Object.keys(linear).length) p.linear = linear;
      else delete p.linear;
    }
    file.people[login] = p;
    return p;
  });
  for (const change of changes) await record({ login, ...change });
  return { perfil: profile };
}

// GET /api/ajustes/registro: the last REGISTRO_MAX, newest first.
export async function readRegistro(): Promise<RegistroEntry[]> {
  let raw: string;
  try {
    raw = await readFile(registroPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: RegistroEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RegistroEntry);
    } catch {
      // A torn line (a write cut short) doesn't hide the rest.
    }
  }
  return entries.slice(-REGISTRO_MAX).reverse();
}

