import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, LABEL_MANAGED, LABEL_STATES, type SpecStatus } from './config.js';
import { getInstallationToken } from './github-app-auth.js';

const execFileAsync = promisify(execFile);

// All gh invocations use execFile with an argv array (never a shell string) so
// issue/PR titles and bodies coming from spec content can't be interpreted as
// shell syntax. GH_TOKEN is set explicitly per-call from the GitHub App
// installation token rather than relying on `gh auth login` state on the
// host, so every issue/PR is authored by "ValerIA[bot]" regardless of who
// else is logged into `gh` there.
async function gh(args: string[]): Promise<string> {
  const token = await getInstallationToken();
  const { stdout } = await execFileAsync('gh', [...args, '--repo', config.productRepo], {
    env: { ...process.env, GH_TOKEN: token },
  });
  return stdout;
}

export interface TrackingIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export async function listTrackingIssues(state: SpecStatus): Promise<TrackingIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--label', LABEL_MANAGED,
    '--label', LABEL_STATES[state],
    '--state', 'open',
    '--json', 'number,title,url,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; title: string; url: string; labels: Array<{ name: string }> }>;
  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels.map((l) => l.name),
  }));
}

export async function createTrackingIssue(title: string, body: string): Promise<{ number: number; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'valeria-issue-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    const stdout = await gh([
      'issue', 'create',
      '--title', title,
      '--body-file', bodyFile,
      '--label', LABEL_MANAGED,
      '--label', LABEL_STATES.ready,
    ]);
    const url = stdout.trim();
    const number = Number(url.split('/').pop());
    return { number, url };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Swaps the current valeria:* state label for `next`. Only one state label is
// ever present at a time — see docs/DESIGN.md §2.1.
export async function setIssueState(issueNumber: number, next: SpecStatus): Promise<void> {
  const current = await gh(['issue', 'view', String(issueNumber), '--json', 'labels']);
  const labels = (JSON.parse(current) as { labels: Array<{ name: string }> }).labels.map((l) => l.name);
  const staleStateLabels = Object.values(LABEL_STATES).filter((l) => labels.includes(l) && l !== LABEL_STATES[next]);

  const args = ['issue', 'edit', String(issueNumber), '--add-label', LABEL_STATES[next]];
  for (const stale of staleStateLabels) args.push('--remove-label', stale);
  await gh(args);
}

export interface PullRequestStatus {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';
  checksPassing: boolean;
  mergeable: boolean;
}

export async function getPullRequestStatus(prNumber: number): Promise<PullRequestStatus> {
  const stdout = await gh([
    'pr', 'view', String(prNumber),
    '--json', 'number,state,reviewDecision,statusCheckRollup,mergeable',
  ]);
  const raw = JSON.parse(stdout) as {
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    reviewDecision: PullRequestStatus['reviewDecision'] | null;
    statusCheckRollup: Array<{ conclusion: string | null }>;
    mergeable: string;
  };
  return {
    number: raw.number,
    state: raw.state,
    reviewDecision: raw.reviewDecision ?? '',
    checksPassing: raw.statusCheckRollup.length > 0 && raw.statusCheckRollup.every((c) => c.conclusion === 'SUCCESS'),
    mergeable: raw.mergeable === 'MERGEABLE',
  };
}

// Hard gate lives here, not just in docs: refuses to merge anything without
// an explicit human approval, regardless of what a caller passes in.
export async function mergePullRequest(prNumber: number): Promise<void> {
  const status = await getPullRequestStatus(prNumber);
  if (status.reviewDecision !== 'APPROVED') {
    throw new Error(`Refusing to merge PR #${prNumber}: reviewDecision is "${status.reviewDecision}", not APPROVED`);
  }
  await gh(['pr', 'merge', String(prNumber), '--squash']);
}

export function branchPrefix(issueNumber: number): string {
  return `valeria/${issueNumber}/`;
}

// Slice branches are created as `valeria/<issue>/<slice-slug>` (see agent-task.ts),
// so the PR for a given issue's current slice is found by branch prefix instead
// of maintaining a separate mapping.
export async function getOpenPrForIssue(issueNumber: number): Promise<PullRequestStatus | null> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
  const match = prs.find((pr) => pr.headRefName.startsWith(branchPrefix(issueNumber)));
  return match ? getPullRequestStatus(match.number) : null;
}

// Opt-in only (config.requestCopilotReview) — requesting Copilot review
// automatically is explicitly out of scope for the core loop for now.
export async function requestCopilotReview(prNumber: number): Promise<void> {
  await gh(['pr', 'edit', String(prNumber), '--add-reviewer', 'copilot']);
}
