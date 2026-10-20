import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../core/config.js';
import { log } from '../../core/logger.js';
import { timed } from '../../core/timing.js';
import type { RepoEntry } from '../../core/repo-context.js';
import { linearKey, teamPeople } from '../../core/linear-api.js';
import { applySettings, EFFORTS, invalidValue, MODELS, readSettingsSync, settingDef, settingsPath, settingsView, TASK_TYPES, type SettingsFile, type SettingValue } from '../../core/settings.js';
import { taskDefaultEffort, taskDefaultModel, taskEnvEffort, taskEnvModel } from '../../core/config.js';
import { sendMail } from '../../core/notifier.js';
import { withJson } from '../../portal/json-store.js';
import { readTeam, withTeam, type Member } from './team.js';
import { EVENTS, eventsOf, isEvent } from '../../core/notifications.js';

// The dashboard's Ajustes (#174), stage 1:
//   GET  /api/ajustes           the person's profile, and for an admin the settings of General
//   POST /api/ajustes/perfil    { name?, email?, linear?: { repo, id } }: their own profile (in people.json, team.ts)
//   POST /api/ajustes/valores   { key, value }: a setting (admins); value null goes back to .env's
//   GET  /api/ajustes/registro  every change made here, newest first (admins)
//   POST /api/ajustes/notificaciones  { repo, event, on }: one of their own emails (stage 4)
//
// Everything lives in SETTINGS_DATA_DIR: settings.json (core/settings.ts),
// people.json (the team, team.ts) and registro.jsonl (one line per change,
// never rewritten).

export class AjustesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// What a person says about themselves (Perfil): part of their entry in the
// team (team.ts).
export type Profile = Pick<Member, 'name' | 'email' | 'linear'>;
const profile = (m: Member | undefined): Profile => ({ ...(m?.name ? { name: m.name } : {}), ...(m?.email ? { email: m.email } : {}), ...(m?.linear ? { linear: m.linear } : {}) });

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

const registroPath = () => join(config.settings.dataDir, 'registro.jsonl');
const emptySettings = (): SettingsFile => ({ values: {} });
const isEmail = (email: string) => email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export async function record(entry: Omit<RegistroEntry, 'at'>, now = new Date()): Promise<void> {
  await mkdir(config.settings.dataDir, { recursive: true, mode: 0o700 });
  await appendFile(registroPath(), `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export async function profileOf(login: string): Promise<Profile> {
  return profile((await readTeam()).people[login]);
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

// Each repo the person sees, with the emails they get from it: what they
// chose, or the defaults (core/notifications.ts).
export function notificaciones(member: Member | undefined, entries: RepoEntry[]) {
  return entries.map((entry) => ({ repo: entry.productRepo, events: eventsOf(member ?? {}, entry.productRepo, entry), chosen: Boolean(member?.notify?.[entry.productRepo]), deploy: Boolean(entry.deploy) }));
}

export async function ajustesView(login: string, admin: boolean, entries: RepoEntry[]): Promise<unknown> {
  const member = (await readTeam()).people[login];
  return {
    me: { login, admin },
    perfil: profile(member),
    notificaciones: notificaciones(member, entries),
    // The address itself, only to an admin.
    ...(admin ? { notifyTo: config.notifyTo } : {}),
    linear: await linearTeams(entries),
    ...(admin ? {
      valores: settingsView(readSettingsSync(config.settings.dataDir)),
      tareas: tareasView(readSettingsSync(config.settings.dataDir)),
      fixed: { previewPortRange: config.previewPortRange, runnerId: config.runnerId, githubLogin: config.githubLogin },
      portal: { url: config.portal.url },
      dashboard: { url: config.dashboard.url },
    } : {}),
  };
}

const word = (value: SettingValue) => (value === true ? 'sí' : value === false ? 'no' : value === '' ? '(el de Claude)' : String(value));
const shown = (value: SettingValue, source: string) => `${word(value)}${source ? ` (${source})` : ''}`;
// The page of Ajustes a setting is on, for the Registro.
const SECTION: Record<string, string> = { dashboard: 'General', portal: 'General', agent: 'Agentes', tick: 'Agentes', retry: 'Agentes', explore: 'Exploración', preview: 'Previews' };
const sectionOf = (key: string) => SECTION[key.split('.')[0]] ?? 'General';

// Per task type: what's chosen here, and what it'd be without it.
function tareasView(file: SettingsFile) {
  return TASK_TYPES.map((task) => ({
    task,
    model: file.tasks?.[task]?.model ?? '',
    effort: file.tasks?.[task]?.effort ?? '',
    envModel: taskEnvModel(task) ?? null,
    envEffort: taskEnvEffort(task) ?? null,
    defaultModel: taskDefaultModel(task) ?? null,
    defaultEffort: taskDefaultEffort(task) ?? null,
  }));
}

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
  const clean = typeof value === 'string' && def.type === 'text' ? value.trim() : value;
  const before = settingsView(readSettingsSync(config.settings.dataDir)).find((s) => s.key === def.key)!;
  await withJson(settingsPath(config.settings.dataDir), emptySettings, (file) => {
    file.values ??= {};
    if (value === null) delete file.values[def.key];
    else file.values[def.key] = clean as SettingValue;
  });
  applySettings(config as unknown as Record<string, unknown>, readSettingsSync(config.settings.dataDir));
  const after = settingsView(readSettingsSync(config.settings.dataDir)).find((s) => s.key === def.key)!;
  if (before.value !== after.value || before.source !== after.source) {
    await record({ login, what: `${sectionOf(def.key)} · ${def.key}`, from: shown(before.value, before.source === 'tablero' ? '' : before.source === 'env' ? '.env' : 'por defecto'), to: shown(after.value, after.source === 'tablero' ? '' : after.source === 'env' ? '.env' : 'por defecto') });
    log.info(`ajustes: ${login} cambió ${def.key} a ${after.value} (${after.source})`);
  }
  return { setting: after };
}

// POST /api/ajustes/perfil: only the person's own. An empty string clears a field.
export async function saveProfile(login: string, body: Record<string, unknown>, teams: Array<{ repo: string; people: Array<{ id: string; name: string }> }>): Promise<unknown> {
  const changes: Array<Omit<RegistroEntry, 'at' | 'login'>> = [];
  const saved = await withTeam((file) => {
    const p: Member = { ...(file.people[login] ?? {}) };
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
    return profile(p);
  });
  for (const change of changes) await record({ login, ...change });
  return { perfil: saved };
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


const EVENT_NAME: Record<string, string> = { 'pedido-equipo': 'pedido para el equipo', 'pedido-revisar': 'pedido para revisar', reunion: 'propuestas de una reunión', bloqueo: 'bloqueos' };

// POST /api/ajustes/notificaciones: only the person's own, only a repo they
// see. The first change in a repo saves their defaults with it.
export async function saveNotificacion(login: string, body: Record<string, unknown>, entries: RepoEntry[]): Promise<unknown> {
  const entry = entries.find((e) => e.productRepo === body.repo);
  if (!entry) throw new AjustesError('Ese repo no está entre los que ves.');
  if (!isEvent(body.event)) throw new AjustesError('Ese aviso no existe.');
  if (typeof body.on !== 'boolean') throw new AjustesError('Falta si lo quieres o no.');
  const event = body.event;
  const on = body.on;
  const changed = await withTeam((team) => {
    const m: Member = { ...(team.people[login] ?? {}) };
    const before = eventsOf(m, entry.productRepo, entry);
    const after = EVENTS.filter((e) => (e === event ? on : before.includes(e)));
    m.notify = { ...(m.notify ?? {}), [entry.productRepo]: after };
    team.people[login] = m;
    return before.includes(event) !== on;
  });
  if (changed) await record({ login, what: `Notificaciones · ${entry.productRepo} · ${EVENT_NAME[event]}`, from: on ? 'no' : 'sí', to: on ? 'sí' : 'no' });
  return { notificaciones: notificaciones((await readTeam()).people[login], entries) };
}

// POST /api/ajustes/tareas { task, model?, effort? }: a task type's own model
// or effort; null goes back to .env's (AGENT_MODEL_<TIPO>) or the general one.
export async function setTask(login: string, body: Record<string, unknown>): Promise<unknown> {
  const task = typeof body.task === 'string' ? body.task : '';
  if (!TASK_TYPES.includes(task)) throw new AjustesError('Ese tipo de tarea no existe.');
  const changes: Array<{ what: string; from: string; to: string }> = [];
  await withJson(settingsPath(config.settings.dataDir), emptySettings, (file) => {
    const tasks = { ...(file.tasks ?? {}) };
    const choice = { ...(tasks[task] ?? {}) };
    for (const [field, allowed] of [['model', MODELS], ['effort', EFFORTS]] as const) {
      if (body[field] === undefined) continue;
      const value = body[field] === null ? '' : String(body[field]);
      if (value && !allowed.includes(value)) throw new AjustesError(field === 'model' ? 'Ese modelo no existe.' : 'Ese esfuerzo no existe.');
      const before = choice[field] ?? '';
      if (value) choice[field] = value;
      else delete choice[field];
      if (before !== value) changes.push({ what: `Agentes · ${task} · ${field === 'model' ? 'modelo' : 'esfuerzo'}`, from: before || 'sin elegir', to: value || 'sin elegir' });
    }
    if (Object.keys(choice).length) tasks[task] = choice;
    else delete tasks[task];
    file.values ??= {};
    file.tasks = tasks;
  });
  applySettings(config as unknown as Record<string, unknown>, readSettingsSync(config.settings.dataDir));
  for (const change of changes) await record({ login, ...change });
  return { tareas: tareasView(readSettingsSync(config.settings.dataDir)) };
}

// GET /api/ajustes/conexiones: whether each credential of .env is there and,
// for GitHub, whether it answers and when the token expires. Never the
// values: only whether they're set.
export async function conexionesView(): Promise<unknown> {
  let github: { ok: boolean; login?: string; expires?: string; error?: string };
  try {
    const response = await timed('github', () => fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ronin-dashboard' },
      signal: AbortSignal.timeout(15_000),
    }));
    const expires = response.headers.get('github-authentication-token-expiration') ?? undefined;
    github = response.ok
      ? { ok: true, login: ((await response.json()) as { login?: string }).login, ...(expires ? { expires } : {}) }
      : { ok: false, error: `GitHub respondió ${response.status}` };
  } catch (error) {
    github = { ok: false, error: (error as Error).message };
  }
  const set = (value: string) => Boolean(value);
  return {
    github,
    oauth: set(config.dashboard.githubClientId) && set(config.dashboard.githubClientSecret),
    webhookSecret: set(config.webhookSecret),
    gmail: { user: config.gmailUser, password: set(config.gmailAppPassword) },
    sessions: { dashboard: set(config.dashboard.sessionSecret), portal: set(config.portal.sessionSecret) },
    urls: { dashboard: config.dashboard.url, portal: config.portal.url },
  };
}

// POST /api/ajustes/conexiones/correo: a test email to the person's own
// address (Perfil), from GMAIL_USER.
export async function testMail(login: string): Promise<unknown> {
  const email = (await profileOf(login)).email;
  if (!email) throw new AjustesError('Pon tu correo en Perfil para mandarte la prueba.');
  try {
    await sendMail({ to: email, subject: '[ronin] Correo de prueba', text: `Si lees esto, ronin puede mandar correos desde ${config.gmailUser}.\n\nLo pediste desde Ajustes → Conexiones.` }, 'ronin');
  } catch (error) {
    throw new AjustesError(`No salió: ${(error as Error).message.split('\n')[0]}`, 502);
  }
  return { to: email };
}
