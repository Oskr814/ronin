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
} as const;

export const LABEL_MANAGED = 'valeria';
export const LABEL_STATES = {
  ready: 'valeria:ready',
  'in-progress': 'valeria:in-progress',
  blocked: 'valeria:blocked',
  done: 'valeria:done',
} as const;

export type SpecStatus = keyof typeof LABEL_STATES;
