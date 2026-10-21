import { randomBytes } from 'node:crypto';

// The pure half of `ronin init` (init.ts): reading and writing a .env, the
// secrets it generates and the repos.json entries it adds. No prompts and no
// files here, so the tests cover all of it.

const LINE_RE = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

// KEY=value lines of a .env; comments and blank lines are skipped, and a
// value in single or double quotes loses them.
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(LINE_RE);
    if (!match || match[1]) continue;
    values[match[2]] = unquote(match[3].trim());
  }
  return values;
}

function unquote(value: string): string {
  const quoted = value.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : value;
}

// Quotes a value only when a reader could take part of it for something
// else: spaces, a #, quotes. Both Compose and `node --env-file` read single
// quotes literally.
export function formatValue(value: string): string {
  if (value === '' || /^[\w.,:/@+\-=<>?&%~]+$/.test(value)) return value;
  return value.includes("'") ? `"${value.replace(/"/g, '')}"` : `'${value}'`;
}

// Writes `values` over the example's lines, keeping its comments: a
// `KEY=` line takes its value, a commented `# KEY=…` line is uncommented
// when the key has one. What the example doesn't have (an older .env's own
// keys) goes at the end, so nothing of the old file is lost.
export function mergeEnv(example: string, values: Record<string, string>): string {
  const seen = new Set<string>();
  const lines = example.split('\n').map((line) => {
    const match = line.match(LINE_RE);
    if (!match) return line;
    const key = match[2];
    if (!(key in values) || seen.has(key)) return line;
    // A commented line is only an example of the key when it has no value
    // of its own in the file yet.
    seen.add(key);
    return `${key}=${formatValue(values[key])}`;
  });
  const rest = Object.keys(values).filter((key) => !seen.has(key));
  if (rest.length > 0) {
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('', '# --- Otras, de un .env anterior ---', ...rest.map((key) => `${key}=${formatValue(values[key])}`), '');
  }
  return lines.join('\n');
}

// A secret for a cookie or a webhook signature: what `openssl rand -hex 32` gives.
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// The secrets init fills in on its own when they're missing.
export const GENERATED_SECRETS = ['WEBHOOK_SECRET', 'DASHBOARD_SESSION_SECRET', 'PORTAL_SESSION_SECRET', 'RONIN_PG_PASSWORD'] as const;

export interface Question {
  key: string;
  prompt: string;
  // Empty is a valid answer.
  optional?: boolean;
  // Offered when nothing is typed.
  default?: string;
  // Only asked in the Docker installation (the Tailscale sidecar).
  docker?: boolean;
}

// What init asks for, in order, when the .env doesn't have it yet.
export const QUESTIONS: Question[] = [
  { key: 'RONIN_GITHUB_LOGIN', prompt: 'Usuario de la cuenta de GitHub de ronin' },
  { key: 'RONIN_GITHUB_TOKEN', prompt: 'Fine-grained PAT de esa cuenta' },
  { key: 'RUNNER_ID', prompt: 'Tu usuario de GitHub (RUNNER_ID, no un hostname)' },
  { key: 'GMAIL_USER', prompt: 'Cuenta de Gmail que manda los correos' },
  { key: 'GMAIL_APP_PASSWORD', prompt: 'App password de esa cuenta' },
  { key: 'NOTIFY_TO', prompt: 'Correos que reciben los bloqueos (separados por coma)' },
  { key: 'TS_AUTHKEY', prompt: 'Auth key de Tailscale para el sidecar (tskey-auth-…)', docker: true },
  { key: 'TS_HOSTNAME', prompt: 'Nombre del nodo de ronin en la tailnet', default: 'ronin', docker: true },
  { key: 'DASHBOARD_URL', prompt: 'URL del tablero (https://<host>.<tailnet>.ts.net:8443)' },
  { key: 'DASHBOARD_GITHUB_CLIENT_ID', prompt: 'Client ID de la OAuth App del tablero' },
  { key: 'DASHBOARD_GITHUB_CLIENT_SECRET', prompt: 'Client secret de esa OAuth App' },
  { key: 'DASHBOARD_ADMINS', prompt: 'Primer administrador del tablero (usuarios de GitHub, separados por coma)' },
  { key: 'PORTAL_URL', prompt: 'URL pública del portal de pedidos (vacío: sin portal)', optional: true },
];

// The answers still missing from `current`.
export function pendingQuestions(current: Record<string, string>, opts: { docker: boolean }): Question[] {
  return QUESTIONS.filter((q) => !current[q.key] && (opts.docker || !q.docker));
}

// Fills in the generated secrets `current` doesn't have.
export function withGeneratedSecrets(current: Record<string, string>, generate = generateSecret): Record<string, string> {
  const next = { ...current };
  for (const key of GENERATED_SECRETS) if (!next[key]) next[key] = generate();
  return next;
}

export interface RepoEntry {
  productRepo: string;
  productRepoPath: string;
  [key: string]: unknown;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function isRepo(value: string): boolean {
  return REPO_RE.test(value);
}

// Adds the repos `repos.json` doesn't have yet, each cloned under `reposDir`
// (the ronin-repos volume, /repos in the container) in a folder of its own:
// its worktrees go next to its clone (repo-context.ts), so two repos never
// share them. Entries already there stay as they are.
export function addRepos(existing: RepoEntry[], repos: string[], reposDir: string): RepoEntry[] {
  const have = new Set(existing.map((e) => e.productRepo.toLowerCase()));
  const added: RepoEntry[] = [];
  for (const repo of repos) {
    if (!isRepo(repo)) throw new Error(`"${repo}" no es owner/nombre`);
    if (have.has(repo.toLowerCase())) continue;
    have.add(repo.toLowerCase());
    added.push({ productRepo: repo, productRepoPath: `${reposDir.replace(/\/+$/, '')}/${repo}/repo` });
  }
  return [...existing, ...added];
}
