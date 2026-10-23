import { inspect } from 'node:util';

type Level = 'INFO' | 'ERROR';

const REDACTED = '[redacted]';

// Env vars whose value is a secret by name; shorter values aren't worth
// replacing (and would replace common words or numbers).
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY/i;
const MIN_SECRET_LENGTH = 8;

const PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys, whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // JWTs: "eyJ" is the base64 of `{"`. Also a cut one — agent output is
  // truncated before it gets here (claude-runner.ts), dots and all.
  [/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)*/g, REDACTED],
  // GitHub tokens: personal, OAuth, app, refresh, fine-grained.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // Authorization: Bearer <x> / Basic <x> / token <x>, header or JSON.
  [/\b(authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+)?[^\s"',}]+/gi, `$1$2 ${REDACTED}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`],
  // Credentials in a URL: scheme://user:password@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // key: value / key=value with a sensitive key (accessToken, id_token,
  // api_key, password…), in JSON, Python dicts, env files or query strings —
  // the key stays, so the line still reads. A plural ("input_tokens", in
  // Claude's usage) is a count, not a secret, and doesn't match.
  // Not a value that's an object or a list (a metric's "mintReadToken":
  // {"ms":…}, #370): it's no secret itself, whatever is inside is redacted
  // by its own key, and redacting its first character broke the line's JSON.
  [/(["']?\b[\w-]*(?:token|api_?key|client_?secret|secret|password|passwd|pwd|cookie|session_?id|private_?key)["']?\s*[:=]\s*["']?)(?![{[])[^\s"',;&}]+/gi, `$1${REDACTED}`],
];

// Logs are read by people and, with the dashboard (#65), shown on a page:
// nothing secret may end up in them. Covers the runner's own secrets by value
// and the usual shapes of anyone else's — the agents' tool output (a test
// user's token from a /preview's API, a password in a seed script) lands
// here too.
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) out = out.split(value).join(`[redacted:${name}]`);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function line(level: Level, message: string): string {
  return redact(`[${new Date().toISOString()}] ${level} ${message}`);
}

export const log = {
  info(message: string): void {
    console.log(line('INFO', message));
  },
  error(message: string, error?: unknown): void {
    // The error rendered here, not by console: its message and stack can carry
    // a secret too (a failed request's URL, a command's output).
    console.error(line('ERROR', message), error === undefined ? '' : redact(inspect(error)));
  },
  // One JSON line per event, into the same daily log as info/error — no new
  // storage, queried later with jq/grep. Kept separate from info() (plain
  // text) so a metric line is trivial to pick out of a log full of prose.
  metric(event: string, fields: Record<string, unknown>): void {
    console.log(redact(JSON.stringify({ event, ts: new Date().toISOString(), ...fields })));
  },
};
