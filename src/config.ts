function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  productRepo: requireEnv('PRODUCT_REPO'),
  productRepoPath: requireEnv('PRODUCT_REPO_PATH'),
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
