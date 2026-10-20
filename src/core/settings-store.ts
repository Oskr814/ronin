import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { getDb, type Db } from '../db/db.js';
import { withJson } from '../portal/json-store.js';
import { log } from './logger.js';
import { timed } from './timing.js';
import { readSettingsSync, settingsPath, type SettingsFile, type SettingValue } from './settings.js';
import type { AccountPlanChoice } from './claude-plans.js';

// Where Ajustes keep what's changed from the dashboard (#174) and the record
// of every change: Postgres when DATABASE_URL is set (#235, stage 2), else
// the files of SETTINGS_DATA_DIR as before (settings.json, registro.jsonl).
// The rest of ronin sees one shape, SettingsFile, either way.
//
// Doesn't import config: config loads the settings from here. Each call
// takes the data dir, which only the files use.

export interface RegistroEntry {
  at: string;
  login: string;
  // What changed, in words ("General · portal.dailyLimit", "Perfil · correo").
  what: string;
  from: string;
  to: string;
}

// The last ones Ajustes → Registro shows.
export const REGISTRO_MAX = 300;

const registroPath = (dataDir: string) => join(dataDir, 'registro.jsonl');
const emptySettings = (): SettingsFile => ({ values: {} });
// One key for Postgres's advisory lock: changes to Ajustes take turns, as the
// file's lock made them.
const SETTINGS_LOCK = 174_001;

const db = (): Db | null => getDb();
const timedDb = <T>(fn: () => Promise<T>) => timed('db', fn);

async function readFromDb(conn: Pick<Db, 'selectFrom'>): Promise<SettingsFile> {
  const [values, tasks, accounts] = await Promise.all([
    conn.selectFrom('settings').select(['key', 'value']).execute(),
    conn.selectFrom('task_settings').select(['task_type', 'model', 'effort']).execute(),
    conn.selectFrom('claude_account_plans').select(['account', 'choice']).execute(),
  ]);
  return {
    values: Object.fromEntries(values.map((r) => [r.key, r.value as SettingValue])),
    ...(tasks.length ? { tasks: Object.fromEntries(tasks.map((r) => [r.task_type, { ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) }])) } : {}),
    ...(accounts.length ? { accounts: Object.fromEntries(accounts.map((r) => [r.account, r.choice as AccountPlanChoice])) } : {}),
  };
}

// The dashboard's values. A database that doesn't answer, like a file that
// doesn't read, is "nothing changed" with an error in the log: .env still
// applies, and no process stops for it.
export async function readSettings(dataDir: string): Promise<SettingsFile> {
  const conn = db();
  if (!conn) return readSettingsSync(dataDir);
  try {
    return await timedDb(() => readFromDb(conn));
  } catch (error) {
    log.error(`ajustes: no se pudieron leer de la base, uso los de .env: ${(error as Error).message}`);
    return emptySettings();
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Changes them through `fn`, which gets the current ones and edits them in
// place (throwing leaves everything as it was). One change at a time, across
// processes. In the database, only what `fn` changed is written, with who.
export async function updateSettings<R>(dataDir: string, by: string, fn: (file: SettingsFile) => R | Promise<R>): Promise<R> {
  const conn = db();
  if (!conn) return withJson(settingsPath(dataDir), emptySettings, fn);
  return timedDb(() => conn.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${SETTINGS_LOCK})`.execute(trx);
    const file = await readFromDb(trx);
    const before = structuredClone(file);
    const result = await fn(file);
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(file.values ?? {})) {
      if (same(before.values[key], value)) continue;
      await trx.insertInto('settings').values({ key, value: JSON.stringify(value), updated_by: by, updated_at: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: by, updated_at: now })).execute();
    }
    const goneValues = Object.keys(before.values).filter((key) => !(key in (file.values ?? {})));
    if (goneValues.length) await trx.deleteFrom('settings').where('key', 'in', goneValues).execute();
    for (const [task, choice] of Object.entries(file.tasks ?? {})) {
      if (same(before.tasks?.[task], choice)) continue;
      const row = { model: choice.model ?? null, effort: choice.effort ?? null, updated_by: by, updated_at: now };
      await trx.insertInto('task_settings').values({ task_type: task, ...row }).onConflict((oc) => oc.column('task_type').doUpdateSet(row)).execute();
    }
    const goneTasks = Object.keys(before.tasks ?? {}).filter((task) => !(task in (file.tasks ?? {})));
    if (goneTasks.length) await trx.deleteFrom('task_settings').where('task_type', 'in', goneTasks).execute();
    for (const [account, choice] of Object.entries(file.accounts ?? {})) {
      if (same(before.accounts?.[account], choice)) continue;
      const row = { choice: JSON.stringify(choice), updated_by: by, updated_at: now };
      await trx.insertInto('claude_account_plans').values({ account, ...row }).onConflict((oc) => oc.column('account').doUpdateSet(row)).execute();
    }
    const goneAccounts = Object.keys(before.accounts ?? {}).filter((account) => !(account in (file.accounts ?? {})));
    if (goneAccounts.length) await trx.deleteFrom('claude_account_plans').where('account', 'in', goneAccounts).execute();
    return result;
  }));
}

// One more line in the record of changes; the record is never rewritten.
export async function appendRegistro(dataDir: string, entry: RegistroEntry): Promise<void> {
  const conn = db();
  if (!conn) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await appendFile(registroPath(dataDir), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return;
  }
  await timedDb(() => conn.insertInto('settings_log').values({ at: entry.at, login: entry.login, what: entry.what, from_value: entry.from, to_value: entry.to }).execute());
}

// The last REGISTRO_MAX, newest first.
export async function readRegistro(dataDir: string, limit = REGISTRO_MAX): Promise<RegistroEntry[]> {
  const conn = db();
  if (conn) {
    const rows = await timedDb(() => conn.selectFrom('settings_log').select(['at', 'login', 'what', 'from_value', 'to_value'])
      .orderBy('at', 'desc').orderBy('id', 'desc').limit(limit).execute());
    return rows.map((r) => ({ at: r.at.toISOString(), login: r.login, what: r.what, from: r.from_value, to: r.to_value }));
  }
  let raw: string;
  try {
    raw = await readFile(registroPath(dataDir), 'utf8');
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
  return entries.slice(-limit).reverse();
}
