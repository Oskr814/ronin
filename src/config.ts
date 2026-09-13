import { join } from 'node:path';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  // Fine-grained PAT de la cuenta de GitHub dedicada `ronin`, invitada como
  // colaboradora en cada repo de repos.json — reemplaza al GitHub App (ver
  // docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md). Token
  // estático: a diferencia del installation token que reemplaza, no hay
  // nada que refrescar ni cachear.
  githubToken: requireEnv('RONIN_GITHUB_TOKEN'),
  // Username real de esa cuenta (sin sufijo "[bot]", no es un App). Usado
  // para detectar @menciones dirigidas al agente (mentions.ts).
  githubLogin: requireEnv('RONIN_GITHUB_LOGIN'),
  // Dónde vive la lista de repos a supervisar — ver repos.ts.
  reposConfigPath: process.env.REPOS_CONFIG_PATH || join(process.cwd(), 'repos.json'),
  // Ref every new task branch is created from. Defaults to the
  // remote-tracking origin/main (kept fresh by a `git fetch` before each
  // new worktree branch — see worktree.ts) rather than the local `main`
  // branch, since nothing here ever checks out or updates local main
  // directly. Overridable (e.g. a dry run against a throwaway base ref)
  // without needing a code change every time.
  worktreeBaseRef: process.env.WORKTREE_BASE_REF ?? 'origin/main',
  // claude -p runs unattended (nobody to answer permission prompts), and
  // bypassPermissions was chosen deliberately over a curated allowlist —
  // see docs/DESIGN.md §7.1. Containment relies on every task running
  // inside its own disposable git worktree, never the main checkout.
  agentTaskTimeoutMs: Number(process.env.AGENT_TASK_TIMEOUT_MINUTES ?? 30) * 60_000,
  // Binario invocado para las corridas headless. Defaults to plain `claude`;
  // only change this if a genuinely different binary/wrapper script is used.
  claudeCommand: process.env.CLAUDE_COMMAND ?? 'claude',
  // Default global de CLAUDE_CONFIG_DIR — una entrada de repos.json puede
  // pisarlo por repo con su propio claudeConfigDir (ver repo-context.ts);
  // esto es lo que se usa cuando esa entrada no trae el suyo. Empty means
  // "use whatever's ambient".
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? '',
  specDir: process.env.SPEC_DIR ?? 'docs/superpowers',
  // Required, not optional: per docs/BLOCKING.md, every blocker always
  // includes an email — a missing value here used to fail lazily, mid
  // incident, inside notifier.ts's transport()/notifyBlocker instead of at
  // startup where a human would actually notice it.
  gmailUser: requireEnv('GMAIL_USER'),
  gmailAppPassword: requireEnv('GMAIL_APP_PASSWORD'),
  notifyTo: requireEnv('NOTIFY_TO'),
  e2eRetryLimit: Number(process.env.E2E_RETRY_LIMIT ?? 2),
  checksPendingRetryLimit: Number(process.env.CHECKS_PENDING_RETRY_LIMIT ?? 60),
  sliceAttemptLimit: Number(process.env.SLICE_ATTEMPT_LIMIT ?? 3),
  rebaseRetryLimit: Number(process.env.REBASE_RETRY_LIMIT ?? 3),
  issueErrorRetryLimit: Number(process.env.ISSUE_ERROR_RETRY_LIMIT ?? 3),
  // How many issues' pipelines (fixes + a possible new-slice start) tick()
  // runs at once *within one active repo* — see repo-context.ts and
  // tick.ts's outer loop for why this stays per-repo, not global-across-repos.
  tickConcurrency: Number(process.env.TICK_CONCURRENCY ?? 2),
  requestCopilotReview: process.env.REQUEST_COPILOT_REVIEW === 'true',
  // A person's GitHub username, e.g. "oskr814" — not a machine hostname.
  // Same RUNNER_ID across every repo in repos.json (confirmed requirement:
  // one operator, not one runner per repo) — see docs/DESIGN.md §1 and §9.
  runnerId: requireEnv('RUNNER_ID'),
  // Base path for the per-machine claim/checks-pending cache — namespaced
  // per active repo by local-state.ts, never read directly as a file path
  // here anymore.
  localStatePath: process.env.LOCAL_STATE_PATH ?? '.ronin-state.json',
  // The following three are only read by webhook-server.ts — deliberately
  // not requireEnv'd here so `pnpm tick`/the cron path keeps working for
  // anyone who never sets up webhooks. webhook-server.ts validates
  // webhookSecret itself at startup.
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  webhookPort: Number(process.env.WEBHOOK_PORT ?? 3939),
  // How long to coalesce a burst of qualifying webhook deliveries (e.g.
  // several PR comments in a row) into a single tick trigger — see
  // webhook-server.ts's scheduleTick.
  webhookDebounceMs: Number(process.env.WEBHOOK_DEBOUNCE_MS ?? 8000),
} as const;

export const LABEL_MANAGED = 'ronin';
export const LABEL_STATES = {
  ready: 'ronin:ready',
  'in-progress': 'ronin:in-progress',
  blocked: 'ronin:blocked',
  done: 'ronin:done',
} as const;

// Applied by discoverAssignedIssues (tick.ts) to every issue picked up via
// direct assignment (as opposed to a spec PR's mirror tracking issue) — lets
// agentTaskFor tell the two apart without depending on a label a human may or
// may not have set. See docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md
// (original design, since generalized from bug-only intake to any assigned issue).
export const LABEL_DIRECT_ISSUE = 'ronin:issue-fix';

// Opt-in: without it, processIssue only starts a slice's PR once the issue
// has no open PR at all (sequential). Applied by hand by a human on the
// tracking issue — the runner never adds it itself.
export const LABEL_STACK_PRS = 'ronin:stack-prs';

export type SpecStatus = keyof typeof LABEL_STATES;
