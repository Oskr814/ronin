import { join } from 'node:path';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const productRepoPath = requireEnv('PRODUCT_REPO_PATH');

export const config = {
  productRepo: requireEnv('PRODUCT_REPO'),
  productRepoPath,
  // Sibling directory to the product repo checkout, not inside it — worktrees
  // come and go per task and should never be mistaken for the main checkout.
  worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(productRepoPath, '..', 'valeria-worktrees'),
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
  // Dedicated ValerIA GitHub App — never the ambient `gh auth` session, so
  // issues/PRs are authored by "ValerIA[bot]", not whoever is logged into
  // `gh` on the box running the supervisor. See docs/DESIGN.md §7.
  githubAppId: requireEnv('VALERIA_GITHUB_APP_ID'),
  githubAppPrivateKeyPath: requireEnv('VALERIA_GITHUB_APP_PRIVATE_KEY_PATH'),
  githubAppInstallationId: requireEnv('VALERIA_GITHUB_APP_INSTALLATION_ID'),
  specDir: process.env.SPEC_DIR ?? 'docs/superpowers',
  gmailUser: process.env.GMAIL_USER ?? '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
  notifyTo: process.env.NOTIFY_TO ?? '',
  e2eRetryLimit: Number(process.env.E2E_RETRY_LIMIT ?? 2),
  sliceAttemptLimit: Number(process.env.SLICE_ATTEMPT_LIMIT ?? 3),
  // Off by default: requesting Copilot review automatically is out of scope
  // for this skeleton, kept as an opt-in switch rather than baked into the
  // core loop. See docs/DESIGN.md §3.
  requestCopilotReview: process.env.REQUEST_COPILOT_REVIEW === 'true',
  // A person's GitHub username, e.g. "oskr814" — not a machine hostname.
  // Unified identity used both for spec-PR assignment (a human labels a spec
  // PR `valeria:runner-<id>` to hand it to a specific runner) and for the
  // per-issue claim lock (`valeria:runner-<id>`) once that runner picks up
  // work — see docs/DESIGN.md §1 and §9. Required, no default: a hostname
  // fallback wouldn't match anything a human would actually label a PR with.
  runnerId: requireEnv('RUNNER_ID'),
  // Per-machine cache of which issues this process already owns, so a claim
  // already held doesn't need to be re-verified against GitHub every tick.
  // Never committed — see .gitignore.
  localStatePath: process.env.LOCAL_STATE_PATH ?? '.valeria-state.json',
} as const;

export const LABEL_MANAGED = 'valeria';
export const LABEL_STATES = {
  ready: 'valeria:ready',
  'in-progress': 'valeria:in-progress',
  blocked: 'valeria:blocked',
  done: 'valeria:done',
} as const;

export type SpecStatus = keyof typeof LABEL_STATES;
