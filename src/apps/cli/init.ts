// `ronin init` (#235, stage 5): sets up an installation once. Asks for what
// .env is missing, generates its secrets, registers the repos in repos.json
// and brings the database up to date. Safe to re-run: what's already there
// stays, and only what's missing is asked.
//
// In Docker, through the compose's `init` service (scripts/init.sh), which
// mounts the checkout at /install and the data volume at /data:
//   docker compose run --rm init
// Without Docker: `pnpm ronin:init`.
//
// Flags, for running it without questions:
//   --set KEY=VALUE        a value of .env (repeatable)
//   --repo owner/name      a repo to register (repeatable)
//   --yes                  ask nothing: fails if something required is missing
//   --steps env,repos,migrate   which steps (all by default)
//   --env, --example, --repos-file, --repos-dir   where things are (not
//   --env-file: tsx would take it as its own)
// Deliberately apart from config.ts: that one needs a complete .env to load.
import { existsSync } from 'node:fs';
import { chown, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '@platform/fs/atomic-json.js';
import { addRepos, isRepo, mergeEnv, parseEnv, pendingQuestions, withGeneratedSecrets, type Question, type RepoEntry } from './env-file.js';

const { values: args } = parseArgs({
  options: {
    // In the compose's `init` service, the checkout's .env (mounted at
    // /install) and the image's example.
    env: { type: 'string', default: process.env.RONIN_ENV_FILE || '.env' },
    example: { type: 'string', default: process.env.RONIN_ENV_EXAMPLE || '.env.example' },
    'repos-file': { type: 'string', default: process.env.REPOS_CONFIG_PATH || 'repos.json' },
    'repos-dir': { type: 'string', default: process.env.RONIN_REPOS_DIR || '/repos' },
    set: { type: 'string', multiple: true, default: [] },
    repo: { type: 'string', multiple: true, default: [] },
    steps: { type: 'string', default: 'env,repos,migrate' },
    yes: { type: 'boolean', default: false },
  },
});

const steps = new Set(args.steps.split(',').map((s) => s.trim()));
const rl = args.yes ? null : createInterface({ input: process.stdin, output: process.stdout });

async function ask(q: Question): Promise<string> {
  if (!rl) {
    if (q.default !== undefined || q.optional) return q.default ?? '';
    throw new Error(`Falta ${q.key}: pasalo con --set ${q.key}=… o corré sin --yes.`);
  }
  for (;;) {
    const answer = (await rl.question(`${q.prompt}${q.default ? ` [${q.default}]` : ''}: `)).trim() || q.default || '';
    if (answer || q.optional) return answer;
    console.log('  Hace falta un valor.');
  }
}

async function readText(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

// .env: the example's lines with what was there, what was asked and the
// generated secrets.
async function envStep(): Promise<Record<string, string>> {
  const example = await readText(args.example);
  if (!example) throw new Error(`No encuentro ${args.example}, la base del .env.`);
  let values = parseEnv(await readText(args.env));
  for (const pair of args.set) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`--set ${pair}: tiene que ser KEY=VALUE`);
    values[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const pending = pendingQuestions(values, { docker: process.env.RONIN_DOCKER === '1' });
  if (pending.length > 0 && rl) console.log(`\nConfiguración (${args.env}): falta${pending.length === 1 ? '' : 'n'} ${pending.length}.`);
  for (const q of pending) values[q.key] = await ask(q);
  values = withGeneratedSecrets(values);
  await writeFileAtomic(args.env, mergeEnv(example, values), { private: true });
  await ownLikeItsFolder(args.env);
  console.log(`✓ ${args.env} escrito. Administradores del tablero: ${values.DASHBOARD_ADMINS || 'ninguno'}.`);
  return values;
}

// In the container, init runs as root and writes the checkout's .env: it
// goes to whoever owns the checkout, so they can still edit it.
async function ownLikeItsFolder(path: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = await stat(dirname(resolve(path)));
  await chown(path, uid, gid);
}

// repos.json: the repos ronin works on. Each one is cloned into the repos
// volume when the server starts (docker/entrypoint.sh).
async function reposStep(): Promise<void> {
  const path = args['repos-file'];
  const text = await readText(path);
  const existing = text ? (JSON.parse(text) as RepoEntry[]) : [];
  let repos = args.repo;
  if (repos.length === 0 && rl) {
    if (existing.length > 0) console.log(`\nRepos en ${path}: ${existing.map((e) => e.productRepo).join(', ')}.`);
    const answer = (await rl.question(existing.length > 0 ? 'Repos para sumar (owner/nombre, separados por coma; vacío: ninguno): ' : 'Repos que atiende ronin (owner/nombre, separados por coma): ')).trim();
    repos = answer.split(',').map((r) => r.trim()).filter(Boolean);
    const bad = repos.filter((r) => !isRepo(r));
    if (bad.length > 0) throw new Error(`No son owner/nombre: ${bad.join(', ')}`);
  }
  const next = addRepos(existing, repos, args['repos-dir']);
  if (next.length === existing.length && text) {
    console.log(`✓ ${path} sin cambios.`);
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ ${path}: ${next.map((e) => e.productRepo).join(', ') || 'sin repos todavía'}. El resto de cada entrada, en https://oskr814.github.io/ronin/referencia/repos-json/`);
}

async function migrateStep(env: Record<string, string>): Promise<void> {
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.log('· Sin DATABASE_URL: no hay base que migrar.');
    return;
  }
  process.env.DATABASE_URL = url;
  const { closeDb, getDb } = await import('@platform/db/db.js');
  const { migrateToLatest } = await import('@platform/db/migrate.js');
  try {
    const ran = await migrateToLatest(getDb()!);
    console.log(ran.length ? `✓ Migraciones aplicadas: ${ran.join(', ')}` : '✓ La base ya estaba al día.');
  } finally {
    await closeDb();
  }
}

try {
  const env = steps.has('env') ? await envStep() : parseEnv(await readText(args.env));
  if (steps.has('repos')) await reposStep();
  if (steps.has('migrate')) await migrateStep(env);
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
