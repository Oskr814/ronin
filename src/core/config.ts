import { join, resolve } from 'node:path';
import { assertTimezone } from './timezone.js';
import { currentRepo } from './repo-context.js';

const logins = (value: string | undefined) => (value ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);

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
  // The whole run of one webhook event's handler (server/api/webhooks/
  // handler.ts): waiting for its turn and a slot, and every agent its flows
  // start. Past it, the handler ends itself and the agent it's running.
  // Restarting the server no longer stops handlers (KillMode=process), so
  // this is what keeps one stuck on something other than an agent (a `gh`
  // that never answers) from staying forever.
  eventHandlerTimeoutMs: Number(process.env.EVENT_HANDLER_TIMEOUT_MINUTES ?? 120) * 60_000,
  // Binario invocado para las corridas headless. Defaults to plain `claude`;
  // only change this if a genuinely different binary/wrapper script is used.
  claudeCommand: process.env.CLAUDE_COMMAND ?? 'claude',
  // Model and effort of every headless run, passed as --model/--effort. Set
  // here, not left to CLAUDE_CONFIG_DIR's settings.json: that file is shared
  // with interactive sessions, and a /model there saves itself as the
  // default — one did on 2026-10-11 and silently moved every agent to Sonnet
  // with medium effort, which made the review orchestrator skip its workers.
  // Empty means "whatever the Claude config says".
  agentModel: process.env.AGENT_MODEL ?? 'opus',
  agentEffort: process.env.AGENT_EFFORT ?? 'high',
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
  // fix-e2e runs on failures that keep changing (progress, per
  // failure-signature.ts) still stop here — see docs/BLOCKING.md.
  e2eAttemptHardLimit: Number(process.env.E2E_ATTEMPT_HARD_LIMIT ?? 5),
  checksPendingRetryLimit: Number(process.env.CHECKS_PENDING_RETRY_LIMIT ?? 60),
  sliceAttemptLimit: Number(process.env.SLICE_ATTEMPT_LIMIT ?? 3),
  retargetRetryLimit: Number(process.env.RETARGET_RETRY_LIMIT ?? 3),
  issueErrorRetryLimit: Number(process.env.ISSUE_ERROR_RETRY_LIMIT ?? 3),
  // How many jobs tick() runs at once *within one active repo* — see
  // repo-context.ts and tick.ts's outer loop for why this stays per-repo, not
  // global-across-repos. Every flow shares one job pool (tick.ts's runJobs),
  // so this bounds issues, external reviews, /spikes and changelog entries
  // together.
  tickConcurrency: Number(process.env.TICK_CONCURRENCY ?? 3),
  // Of those, how many external reviews at once: each one is an orchestrator
  // plus its workers, and three at once exhausted the account's session
  // limit (docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md).
  externalReviewConcurrency: Number(process.env.EXTERNAL_REVIEW_CONCURRENCY ?? 2),
  requestCopilotReview: process.env.REQUEST_COPILOT_REVIEW === 'true',
  // Exploration (docs/DESIGN.md §11): how many functions one run tests, and
  // how much of what it finds gets published — findings most severe first,
  // ideas never in a finding's place. Their screenshots go to the product
  // repo's evidence branch unless EXPLORE_PUBLISH_EVIDENCE=false.
  exploreFunctionsPerRun: Number(process.env.EXPLORE_FUNCTIONS_PER_RUN ?? 3),
  exploreFindingsPerRun: Number(process.env.EXPLORE_FINDINGS_PER_RUN ?? 8),
  exploreIdeasPerRun: Number(process.env.EXPLORE_IDEAS_PER_RUN ?? 2),
  explorePublishEvidence: process.env.EXPLORE_PUBLISH_EVIDENCE !== 'false',
  // Exploration's clock (timezone.ts): the night window, a run's date and
  // its week. Logs and the rest of ronin keep the server's time.
  exploreTimezone: assertTimezone(process.env.EXPLORE_TIMEZONE || 'America/Tegucigalpa'),
  // When nightly exploration runs, in EXPLORE_TIMEZONE ("HH:MM-HH:MM",
  // may cross midnight). No new function starts after its end; one already
  // running finishes. The quota it uses is the account's weekly limit too,
  // so it's capped by EXPLORE_FUNCTIONS_PER_NIGHT, not "use everything".
  exploreNightWindow: process.env.EXPLORE_NIGHT_WINDOW ?? '01:00-06:00',
  exploreFunctionsPerNight: Number(process.env.EXPLORE_FUNCTIONS_PER_NIGHT ?? 3),
  // When a task ends in needs-info, also open a Remote Control session that
  // interviews the runner's owner and writes the answers into the issue —
  // see interview.ts. Only the Claude account of CLAUDE_CONFIG_DIR can open
  // it; everyone else answers by commenting on the issue, as always.
  remoteInterviews: process.env.REMOTE_INTERVIEWS !== 'false',
  // /preview: after the base seeds, an agent prepares the data the PR needs
  // to be tried out (preview.ts). Off = just the app with its seeds.
  previewPrepareData: process.env.PREVIEW_PREPARE_DATA !== 'false',
  // Tailnet ports previews are published on — what a tailnet policy can open
  // to someone outside without opening anything else. Outside the kernel's
  // ephemeral range (32768-60999 on Linux), where Docker and the slices'
  // Postgres land: one of those could otherwise fall inside it.
  previewPortRange: process.env.PREVIEW_PORT_RANGE || '20000-20999',
  previewMaxPerRepo: Number(process.env.PREVIEW_MAX_PER_REPO || 2),
  // A preview nobody took down goes on its own this long after it came up
  // (sweepPreviews). 0 = only on /preview stop or when the PR merges/closes.
  previewTtlMinutes: Number(process.env.PREVIEW_TTL_MINUTES ?? 60),
  // Shared by every repo and worker on this runner: the reservations of
  // public ports and per-app slots (preview/reservations.ts).
  previewReservationsDir: process.env.PREVIEW_RESERVATIONS_DIR || '.preview-reservations',
  interviewTimeoutHours: Number(process.env.INTERVIEW_TIMEOUT_HOURS ?? 24),
  // Model for the external review's worker subagents (one per criteria
  // dimension). They only gather candidates; the orchestrating session —
  // whatever model the run's Claude config uses — verifies and decides what
  // gets published, so a cheaper model here costs recall at most, not
  // precision. See docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md.
  externalReviewWorkerModel: process.env.EXTERNAL_REVIEW_WORKER_MODEL ?? 'sonnet',
  // A person's GitHub username, e.g. "oskr814" — not a machine hostname.
  // Same RUNNER_ID across every repo in repos.json (confirmed requirement:
  // one operator, not one runner per repo) — see docs/DESIGN.md §1 and §9.
  runnerId: requireEnv('RUNNER_ID'),
  // Base path for the per-machine claim/checks-pending cache — namespaced
  // per active repo by local-state.ts, never read directly as a file path
  // here anymore.
  localStatePath: process.env.LOCAL_STATE_PATH ?? '.ronin-state.json',
  // The following three are only read by the ronin server (src/server/) —
  // deliberately not requireEnv'd here so `pnpm tick`/the cron path keeps
  // working for anyone who never sets it up. The server validates
  // webhookSecret itself at startup.
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  // The public listener's port, where GitHub's deliveries arrive.
  // WEBHOOK_PORT is its old name, still read when SERVER_PORT isn't set.
  serverPort: Number(process.env.SERVER_PORT ?? process.env.WEBHOOK_PORT ?? 3939),
  // How long to coalesce a burst of webhook deliveries about the same issue
  // or PR (e.g. a review's several inline comments) into a single event
  // handler — see server/api/webhooks/github.ts's scheduleHandler. Short: whatever
  // lands after the window is coalesced anyway, by handler.ts keeping at
  // most one handler waiting per scope.
  webhookDebounceMs: Number(process.env.WEBHOOK_DEBOUNCE_MS ?? 1000),
  // The dashboard (#65): the web app and the rest of the API, on a second
  // listener that only the tailnet reaches (127.0.0.1, published with
  // `tailscale serve` by scripts/setup-server-service.sh). Off unless the
  // GitHub OAuth App is set: without it the server only takes webhooks.
  dashboard: {
    tailnetPort: Number(process.env.SERVER_TAILNET_PORT ?? 3940),
    // Where people open it, e.g. https://media.<tailnet>.ts.net:8443 — the
    // OAuth callback is built from it.
    url: (process.env.DASHBOARD_URL ?? '').replace(/\/+$/, ''),
    githubClientId: process.env.DASHBOARD_GITHUB_CLIENT_ID ?? '',
    githubClientSecret: process.env.DASHBOARD_GITHUB_CLIENT_SECRET ?? '',
    sessionSecret: process.env.DASHBOARD_SESSION_SECRET ?? '',
    // Who sees every repo (#106), comma-separated GitHub logins. Unset, the
    // DASHBOARD_ALLOWED_USERS are: a .env from before #106 works as it did.
    admins: logins(process.env.DASHBOARD_ADMINS ?? process.env.DASHBOARD_ALLOWED_USERS),
    // Optional: only these logins get in at all (admins always do). Empty,
    // anyone who can triage a repo of repos.json on GitHub gets in, and sees
    // just those repos (server/api/access.ts).
    allowedUsers: logins(process.env.DASHBOARD_ALLOWED_USERS),
    sessionDays: Number(process.env.DASHBOARD_SESSION_DAYS ?? 7),
    // How long a repo's GitHub read is reused (server/api/dashboard-github.ts).
    githubTtlSeconds: Number(process.env.DASHBOARD_GITHUB_TTL_SECONDS ?? 60),
  },
  // The request portal (#114): people without GitHub ask for small changes,
  // with their email and a password, on the public listener. Off unless its
  // URL and session secret are set: without them the public listener serves
  // only the webhooks, as before.
  portal: {
    // Where people open it, e.g. https://ronin-agent.redmotoshn.com — the
    // links in its emails are built from it, and a POST from any other
    // origin is refused.
    url: (process.env.PORTAL_URL ?? '').replace(/\/+$/, ''),
    sessionSecret: process.env.PORTAL_SESSION_SECRET ?? '',
    sessionDays: Number(process.env.PORTAL_SESSION_DAYS ?? 30),
    // Its accounts and its requests: the source of truth for them, unlike
    // the local state, so it lives apart and is never pruned. Absolute, from
    // where ronin runs: its paths go to agents and to git commands that run
    // in the product repo's checkout.
    dataDir: resolve(process.env.PORTAL_DATA_DIR || 'portal-data'),
    // Requests a person can start per day unless the admin set theirs.
    dailyLimit: Number(process.env.PORTAL_DAILY_LIMIT ?? 5),
  },
} as const;

// Per task type, the model a run uses when its env var isn't set — anything
// not listed falls back to config.agentModel. Haiku only where the output is
// bounded and checked by something else (update-changelog: the changelog
// repo's own `pnpm build` and AGENTS.md format).
const TASK_MODEL_DEFAULTS: Record<string, string> = {
  'update-changelog': 'haiku',
  // Reading routes and pages into a list: checked by parseDiscoveredFunctions
  // and merged by code, so a mid-size model is enough.
  'explore-inventory': 'sonnet',
  // Classifying a handful of review comments; the supervisor applies them.
  'explore-feedback': 'sonnet',
  // One screenshot of a draft change on the running app.
  'explore-redo-after': 'sonnet',
  // One commit subject line.
  'commit-subject': 'haiku',
  // Reading a PR and its seeds, then a few API calls or inserts, checked by
  // reading them back.
  'prepare-preview-data': 'sonnet',
};

function taskEnv(prefix: string, taskType: string): string | undefined {
  return process.env[`${prefix}_${taskType.toUpperCase().replace(/-/g, '_')}`];
}

// Most specific first: the active repo's own per-task value (its `agent`
// block in repos.json, for an account with tighter limits), then
// AGENT_MODEL_<TASK_TYPE> / AGENT_EFFORT_<TASK_TYPE> (e.g.
// AGENT_MODEL_UPDATE_CHANGELOG=sonnet), then TASK_MODEL_DEFAULTS, then the
// repo's default, then the global one. Empty means "whatever the Claude
// config says" at every level.
export function agentModelFor(taskType: string): string {
  return currentRepo()?.agent?.models?.[taskType] ?? taskEnv('AGENT_MODEL', taskType) ?? TASK_MODEL_DEFAULTS[taskType] ?? defaultAgentModel();
}

export function agentEffortFor(taskType: string): string {
  return currentRepo()?.agent?.efforts?.[taskType] ?? taskEnv('AGENT_EFFORT', taskType) ?? defaultAgentEffort();
}

export function defaultAgentModel(): string {
  return currentRepo()?.agent?.model ?? config.agentModel;
}

export function defaultAgentEffort(): string {
  return currentRepo()?.agent?.effort ?? config.agentEffort;
}

export function reviewWorkerModel(): string {
  return currentRepo()?.agent?.reviewWorkerModel ?? config.externalReviewWorkerModel;
}

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

// On a PR: merge it as soon as it's approved and green — see auto-merge.ts.
// `/auto-merge` puts it on, `/auto-merge off` takes it off, and a human can
// set it by hand; the label itself is the state.
export const LABEL_AUTO_MERGE = 'ronin:auto-merge';

// On an issue opened from the request portal (#114): an approved prototype
// ronin makes, or a request the dev team takes.
export const LABEL_PORTAL = 'ronin:portal';

export type SpecStatus = keyof typeof LABEL_STATES;
