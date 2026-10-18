import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, LABEL_MANAGED, LABEL_STATES, type SpecStatus } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
import type { FailedCheck } from './failure-signature.js';

const execFileAsync = promisify(execFile);

// All gh invocations use execFile with an argv array (never a shell string) so
// issue/PR titles and bodies coming from spec content can't be interpreted as
// shell syntax. GH_TOKEN is set explicitly per-call from the dedicated
// `ronin` account's PAT rather than relying on `gh auth login` state on the
// host, so every issue/PR is authored by that account regardless of who
// else is logged into `gh` there.
async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', [...args, '--repo', activeRepo().productRepo], {
    env: { ...process.env, GH_TOKEN: config.githubToken },
  });
  return stdout;
}

// `gh api` has no --repo/-R flag at all (unlike `gh pr`/`gh issue`), so it
// can't go through gh() above: it would fail outright with "unknown flag:
// --repo". It resolves the {owner}/{repo} placeholders from the current
// directory's git remote or $GH_REPO — and the supervisor's cwd is ronin's
// own checkout, not PRODUCT_REPO_PATH, so those placeholders would target the
// wrong repo anyway. Every caller therefore spells out
// `repos/${activeRepo().productRepo}/...` literally instead.
async function ghApi(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: config.githubToken },
    // A big PR's files with their patches (getPrFiles) are well over the 1 MB default.
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const ensuredLabels = new Set<string>();

// GitHub rejects `--add-label` for a label that doesn't exist in the repo
// yet — unlike topics, labels aren't auto-created. `--force` makes this
// idempotent (create-or-update), and the in-process cache avoids repeating
// the call for a label already confirmed this tick.
async function ensureLabel(name: string): Promise<void> {
  if (ensuredLabels.has(name)) return;
  await gh(['label', 'create', name, '--force', '--color', 'ededed']);
  ensuredLabels.add(name);
}

export async function getIssueLabels(issueNumber: number): Promise<string[]> {
  const stdout = await gh(['issue', 'view', String(issueNumber), '--json', 'labels']);
  return (JSON.parse(stdout) as { labels: Array<{ name: string }> }).labels.map((l) => l.name);
}

export async function addIssueLabel(issueNumber: number, label: string): Promise<void> {
  await ensureLabel(label);
  await gh(['issue', 'edit', String(issueNumber), '--add-label', label]);
}

export async function removeIssueLabel(issueNumber: number, label: string): Promise<void> {
  await gh(['issue', 'edit', String(issueNumber), '--remove-label', label]);
}

// Who an issue is assigned to, read fresh.
export async function getIssueAssignees(issueNumber: number): Promise<string[]> {
  const raw = JSON.parse(await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${issueNumber}`])) as { assignees?: Array<{ login: string }> };
  return (raw.assignees ?? []).map((a) => a.login);
}

// Open or closed, and why it closed: COMPLETED (done, e.g. by its PR's
// merge) or NOT_PLANNED. Through the REST API: the runner's gh (2.45) has
// no stateReason in `issue view --json`.
export async function getIssueState(issueNumber: number): Promise<{ state: 'OPEN' | 'CLOSED'; stateReason: string }> {
  const raw = JSON.parse(await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${issueNumber}`])) as { state: string; state_reason?: string | null };
  return { state: raw.state.toUpperCase() as 'OPEN' | 'CLOSED', stateReason: (raw.state_reason ?? '').toUpperCase() };
}

export async function getIssueBody(issueNumber: number): Promise<string> {
  const stdout = await gh(['issue', 'view', String(issueNumber), '--json', 'body']);
  return (JSON.parse(stdout) as { body: string }).body;
}

export async function setIssueBody(issueNumber: number, body: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-body-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    await gh(['issue', 'edit', String(issueNumber), '--body-file', bodyFile]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ATTEMPT_LABEL_RE = /^ronin:attempts-(\d+)$/;

// Tracks how many fix attempts (review, e2e, rebase, or an issue-level
// transient exception) a PR or tracking issue has been through, as a label
// swap — same pattern as the state labels. See docs/BLOCKING.md for the
// limits this is checked against. `gh issue view` (not `gh pr view`) — PRs
// are issues under the hood and this label read is shared with plain
// tracking-issue numbers (see the issueErrorRetryLimit path in tick.ts),
// which aren't resolvable via `gh pr view`.
//
// Deliberately NOT used for the checks-pending wait (see tick.ts /
// local-state.ts) — that budget is large (tens of ticks) and a label swap
// every tick floods the issue's activity timeline with noise. This one stays
// label-based because its limits are small (2-3), so the escalation history
// staying visible on the issue is actually useful.
// The counter as `labels` show it: 0 without one.
export function attemptCountFromLabels(labels: string[]): number {
  const match = labels.map((l) => l.match(ATTEMPT_LABEL_RE)).find((m) => m !== null);
  return match ? Number(match[1]) : 0;
}

// Back to 0: the issue-level error counter counts errors in a row, not ever.
export async function resetAttemptCount(number: number, current: number): Promise<void> {
  await gh(['issue', 'edit', String(number), '--remove-label', `ronin:attempts-${current}`]);
}

// A failure of `gh` that a later retry fixes on its own: GitHub answering
// 5xx, 429 or 499, or the network between here and GitHub. Never a reason
// to block on a human — Bmedical/bmedical#350 was blocked by one
// `HTTP 500: 500 Internal Server Error (https://api.github.com/graphql)`.
const TRANSIENT_GH_RE = /HTTP (5\d\d|429|499)\b|secondary rate limit|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|i\/o timeout|TLS handshake timeout|connection reset|unexpected EOF|could not resolve host|Bad Gateway|Service Unavailable|Gateway Timeout/i;

export function isTransientGhError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Command failed: gh\b/.test(message) && TRANSIENT_GH_RE.test(message);
}

export async function getAttemptCount(prNumber: number): Promise<number> {
  const stdout = await gh(['issue', 'view', String(prNumber), '--json', 'labels']);
  const labels = (JSON.parse(stdout) as { labels: Array<{ name: string }> }).labels.map((l) => l.name);
  const match = labels.map((l) => l.match(ATTEMPT_LABEL_RE)).find((m) => m !== null);
  return match ? Number(match[1]) : 0;
}

export async function incrementAttemptCount(prNumber: number): Promise<number> {
  const current = await getAttemptCount(prNumber);
  const next = current + 1;
  await ensureLabel(`ronin:attempts-${next}`);
  // `gh issue edit`, not `gh pr edit` — see the note on setPrState below.
  const args = ['issue', 'edit', String(prNumber), '--add-label', `ronin:attempts-${next}`];
  if (current > 0) args.push('--remove-label', `ronin:attempts-${current}`);
  await gh(args);
  return next;
}

export interface TrackingIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export async function listTrackingIssues(state: SpecStatus, issueState: 'open' | 'closed' = 'open'): Promise<TrackingIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--label', LABEL_MANAGED,
    '--label', LABEL_STATES[state],
    '--state', issueState,
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
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    await ensureLabel(LABEL_MANAGED);
    await ensureLabel(LABEL_STATES.ready);
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

// Swaps the current ronin:* state label for `next`. Only one state label is
// ever present at a time — see docs/DESIGN.md §2.1.
export async function setIssueState(issueNumber: number, next: SpecStatus): Promise<void> {
  const current = await gh(['issue', 'view', String(issueNumber), '--json', 'labels']);
  const labels = (JSON.parse(current) as { labels: Array<{ name: string }> }).labels.map((l) => l.name);
  const staleStateLabels = Object.values(LABEL_STATES).filter((l) => labels.includes(l) && l !== LABEL_STATES[next]);

  await ensureLabel(LABEL_STATES[next]);
  const args = ['issue', 'edit', String(issueNumber), '--add-label', LABEL_STATES[next]];
  for (const stale of staleStateLabels) args.push('--remove-label', stale);
  await gh(args);
}

export interface PullRequestStatus {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';
  checksPassing: boolean;
  // True while CI hasn't finished yet (no checks reported at all, or any
  // entry still queued/in-progress, conclusion === null) — distinguishes
  // "not done running" from "actually failed" (checksPassing === false for
  // both, otherwise indistinguishable to a caller). See final review Fix 6.
  checksPending: boolean;
  mergeable: boolean;
  headRefName: string;
  // The branch this PR merges into. Needed to notice when the bottom of a
  // stack's base never got auto-retargeted to the root branch (e.g. a human
  // merged the predecessor from the GitHub UI without --delete-branch) — see
  // final review Fix 1.
  baseRefName: string;
  isDraft: boolean;
  // Read so the supervisor can tell whether a ronin PR already carries the
  // command cheat sheet (see help.ts's withHelpFooter) without a per-PR call.
  body: string;
}

// Same field set works for both `gh pr view` (one PR) and `gh pr list` (many)
// — confirmed via `gh pr list --json` with no value, which prints the list of
// valid fields and includes every one of these. Shared so the two call sites
// (a single fresh re-read vs. the batched per-tick list) can never drift
// apart and silently stop returning a field the other relies on.
const PR_JSON_FIELDS = 'number,state,reviewDecision,statusCheckRollup,mergeable,headRefName,baseRefName,isDraft,body';

interface RawPr {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  reviewDecision: PullRequestStatus['reviewDecision'] | null;
  statusCheckRollup: RollupEntry[];
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  body: string | null;
}

// One entry of a PR's statusCheckRollup. GitHub mixes two kinds: a CheckRun
// (GitHub Actions and Checks-API apps) reports `conclusion`, a
// StatusContext (the commit statuses API) reports `state` and has no
// `conclusion` at all.
export interface RollupEntry {
  __typename?: 'CheckRun' | 'StatusContext';
  conclusion?: string | null;
  context?: string;
  state?: string;
}

type CheckOutcome = 'passed' | 'pending' | 'failed';

function checkOutcome(c: RollupEntry): CheckOutcome {
  if (c.__typename === 'StatusContext') {
    if (c.state === 'SUCCESS') return 'passed';
    if (c.state === 'FAILURE' || c.state === 'ERROR') return 'failed';
    return 'pending'; // PENDING, EXPECTED
  }
  // A still-running CheckRun reports conclusion as "" (empty string), not
  // null — discovered live on PR #238, where an in-progress "Integration
  // Tests" run got misread as an actual failure and spuriously triggered
  // fix-e2e. Treat both null and "" as "not concluded yet".
  if (!c.conclusion) return 'pending';
  // NEUTRAL and SKIPPED are concluded-but-not-a-failure (e.g. a workflow
  // that no-ops on this diff, or a required-only check GitHub skips) —
  // `gh pr checks` itself doesn't count them as failures. Discovered live
  // on PR #601: a NEUTRAL/SKIPPED entry alongside otherwise-SUCCESS checks
  // made checksPassing false while checksPending was also false, spuriously
  // triggering fix-e2e on a PR with nothing actually failing.
  return c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED' ? 'passed' : 'failed';
}

// What the PR's CI says about its code. ronin's own statuses (ronin/review,
// ronin/fix-comments, ronin/thread-reply — tick.ts's setReviewStatus) are
// left out: they report ronin's work on the PR, not the code. Read as CI, a
// StatusContext (no `conclusion`) used to keep checksPending true forever
// once ronin had reviewed a slice PR (Bmedical/bmedical#401,
// redmotos/shoppingcart#849), and a ronin/* "error" would have sent
// fix-e2e after a CI failure that doesn't exist.
export function checksStatus(rollup: RollupEntry[]): { checksPassing: boolean; checksPending: boolean } {
  const outcomes = rollup
    .filter((c) => !(c.__typename === 'StatusContext' && c.context?.startsWith('ronin/')))
    .map(checkOutcome);
  return {
    checksPassing: outcomes.length > 0 && outcomes.every((o) => o === 'passed'),
    checksPending: outcomes.length === 0 || outcomes.includes('pending'),
  };
}

function toPullRequestStatus(raw: RawPr): PullRequestStatus {
  return {
    number: raw.number,
    state: raw.state,
    reviewDecision: raw.reviewDecision ?? '',
    ...checksStatus(raw.statusCheckRollup),
    mergeable: raw.mergeable === 'MERGEABLE',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft,
    body: raw.body ?? '',
  };
}

// The checks failing on a PR, each with its job log when it's a GitHub
// Actions job — what failure-signature.ts fingerprints. A log that can't be
// read leaves that check with its name alone, never fails the whole read.
const FAILED_CHECKS_MAX = 10;
const JOB_LOG_MAX_BUFFER = 64 * 1024 * 1024;
const ACTIONS_JOB_URL = /\/actions\/runs\/\d+\/job\/(\d+)/;

interface RawCheck {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  context?: string;
  state?: string;
}

export async function getFailedChecks(prNumber: number): Promise<FailedCheck[]> {
  const stdout = await gh(['pr', 'view', String(prNumber), '--json', 'statusCheckRollup']);
  const rollup = (JSON.parse(stdout) as { statusCheckRollup: RawCheck[] }).statusCheckRollup;
  // Same reading of "failed" as toPullRequestStatus's checksPassing; ronin's
  // own statuses (ronin/review, ronin/fix-comments) report its work on the
  // PR, not the code, so they're no part of why CI fails.
  const failed = rollup
    .filter((c) => (c.__typename === 'StatusContext'
      ? (c.state === 'FAILURE' || c.state === 'ERROR') && !c.context?.startsWith('ronin/')
      : !!c.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)))
    .slice(0, FAILED_CHECKS_MAX);
  return Promise.all(failed.map(async (c) => {
    const name = c.name ?? c.context ?? '?';
    const jobId = c.detailsUrl?.match(ACTIONS_JOB_URL)?.[1];
    if (!jobId) return { name, log: '' };
    try {
      const { stdout: jobLog } = await execFileAsync('gh', ['api', `repos/${activeRepo().productRepo}/actions/jobs/${jobId}/logs`], {
        env: { ...process.env, GH_TOKEN: config.githubToken },
        maxBuffer: JOB_LOG_MAX_BUFFER,
      });
      return { name, log: jobLog };
    } catch (error) {
      log.info(`getFailedChecks: no se pudo leer el log del job ${jobId} (PR #${prNumber}): ${(error as Error).message}`);
      return { name, log: '' };
    }
  }));
}

export async function getPullRequestStatus(prNumber: number): Promise<PullRequestStatus> {
  const stdout = await gh(['pr', 'view', String(prNumber), '--json', PR_JSON_FIELDS]);
  return toPullRequestStatus(JSON.parse(stdout) as RawPr);
}

// Every open PR must fit in one page — gh pr list defaults to 30 results, far
// below what a page of results returns once several specs are in flight at
// once. No config knob: there's no legitimate reason to tune this per
// environment, only room to raise it if the warning below ever fires.
const PR_LIST_LIMIT = 300;

// Single batched read behind tick()'s whole per-issue loop, replacing what
// used to be one `gh pr list` + one `gh pr view` per PR per issue — see
// docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. Filters
// client-side to ronin's own branches (`ronin/<issue>/slice-N` — see
// stack.ts's sliceBranch) since PRODUCT_REPO also carries ordinary human PRs
// under the same `--state open`.
export async function listAllOpenRoninPrs(): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_JSON_FIELDS]);
  const raw = (JSON.parse(stdout) as RawPr[]).filter((pr) => pr.headRefName.startsWith('ronin/'));
  if (raw.length === PR_LIST_LIMIT) {
    log.error(`listAllOpenRoninPrs: alcanzó el límite de ${PR_LIST_LIMIT} — puede haber PRs no traídos, subir PR_LIST_LIMIT`);
  }
  return raw.map(toPullRequestStatus);
}

// --- for the dashboard (#65): the whole repo in two reads ---

// Every open issue ronin manages, with its body (the slice checklist).
export async function listOpenManagedIssues(): Promise<Array<TrackingIssue & { body: string }>> {
  const stdout = await gh(['issue', 'list', '--label', LABEL_MANAGED, '--state', 'open', '--limit', '200', '--json', 'number,title,url,labels,body']);
  return (JSON.parse(stdout) as Array<{ number: number; title: string; url: string; labels: Array<{ name: string }>; body: string | null }>)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, labels: issue.labels.map((l) => l.name), body: issue.body ?? '' }));
}

export interface OpenPr {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  reviewDecision: PullRequestStatus['reviewDecision'];
  checks: Array<{ name: string; outcome: 'passed' | 'pending' | 'failed' }>;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
}

// Every open PR — ronin's and everyone else's — with its checks one by one.
export async function listOpenPrsWithChecks(): Promise<OpenPr[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,title,url,author,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,mergeable']);
  type Raw = { number: number; title: string; url: string; author: { login: string } | null; isDraft: boolean; headRefName: string; baseRefName: string; reviewDecision: PullRequestStatus['reviewDecision'] | null; statusCheckRollup: Array<RollupEntry & { name?: string }>; mergeable?: OpenPr['mergeable'] };
  return (JSON.parse(stdout) as Raw[]).map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? '',
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    reviewDecision: pr.reviewDecision ?? '',
    checks: (pr.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? '?', outcome: checkOutcome(c) })),
    ...(pr.mergeable ? { mergeable: pr.mergeable } : {}),
  }));
}

export interface OpenIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

// Every open issue of the repo, ronin's or not: what the dashboard's search
// looks through (#100).
export async function listOpenIssues(): Promise<OpenIssue[]> {
  const stdout = await gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,url,labels']);
  return (JSON.parse(stdout) as Array<{ number: number; title: string; url: string; labels: Array<{ name: string }> }>)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, labels: issue.labels.map((l) => l.name) }));
}

const CLOSING_ISSUES_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number closingIssuesReferences(first: 5) { nodes { number } } }
    }
  }
}`;

// The issues each open PR closes ("Closes #N", or linked by hand), by PR
// number. GraphQL: this gh's `pr list` doesn't know closingIssuesReferences.
export async function listPrClosingIssues(): Promise<Record<number, number[]>> {
  const [owner, repo] = activeRepo().productRepo.split('/');
  type Raw = { data: { repository: { pullRequests: { nodes: Array<{ number: number; closingIssuesReferences: { nodes: Array<{ number: number }> } }> } } } };
  const raw = JSON.parse(await ghApi(['api', 'graphql', '-f', `query=${CLOSING_ISSUES_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`])) as Raw;
  return Object.fromEntries(raw.data.repository.pullRequests.nodes.map((pr) => [pr.number, pr.closingIssuesReferences.nodes.map((i) => i.number)]));
}

// How an issue or PR stands on GitHub, as GitHub draws it (#129): open (a PR
// maybe a draft), an issue closed as completed or not planned, a PR merged
// or closed without merging.
export type GithubState = 'open' | 'draft' | 'completed' | 'not_planned' | 'merged' | 'closed';

const RECENTLY_CLOSED_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    issues(states: CLOSED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number stateReason } }
    pullRequests(states: [CLOSED, MERGED], first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state } }
  }
}`;

export function closedState(kind: 'issue' | 'pr', state: string, stateReason?: string | null): GithubState {
  if (kind === 'pr') return state === 'MERGED' ? 'merged' : 'closed';
  return stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed';
}

// The last 100 issues and PRs closed (by latest update), each with how it
// closed: what the dashboard lists that isn't open anymore is what ronin
// worked on lately. GraphQL: the runner's gh (2.45) has no stateReason.
export async function listRecentlyClosed(): Promise<Record<number, GithubState>> {
  const [owner, repo] = activeRepo().productRepo.split('/');
  type Raw = { data: { repository: { issues: { nodes: Array<{ number: number; stateReason: string | null }> }; pullRequests: { nodes: Array<{ number: number; state: string }> } } } };
  const raw = JSON.parse(await ghApi(['api', 'graphql', '-f', `query=${RECENTLY_CLOSED_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`])) as Raw;
  const { issues, pullRequests } = raw.data.repository;
  return Object.fromEntries([
    ...issues.nodes.map((i) => [i.number, closedState('issue', 'CLOSED', i.stateReason)] as const),
    ...pullRequests.nodes.map((p) => [p.number, closedState('pr', p.state)] as const),
  ]);
}

// Whether #number is an issue or a PR, open or closed; null if the repo has
// neither. For opening by number something the dashboard doesn't list.
export async function itemKindOf(number: number): Promise<'issue' | 'pr' | null> {
  try {
    const raw = JSON.parse(await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${number}`])) as { pull_request?: unknown };
    return raw.pull_request ? 'pr' : 'issue';
  } catch (error) {
    if (/HTTP 404|HTTP 410/.test((error as Error).message)) return null;
    throw error;
  }
}

// An issue or PR as the dashboard's item page shows it (#85): its body and
// its general comments, oldest first. A PR adds its branches, whether it
// merges cleanly, its reviews and its review threads (the inline comments).
export interface Discussion {
  number: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  url: string;
  state: string;
  // A closed issue's: COMPLETED or NOT_PLANNED.
  stateReason?: string;
  // A PR's.
  isDraft?: boolean;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt: string; url: string }>;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  baseRefName?: string;
  headRefName?: string;
  // Only the ones that say something: a body, or a decision. GitHub makes an
  // empty review for every batch of inline comments; those are in `threads`.
  reviews?: Array<{ author: string; body: string; state: string; submittedAt: string }>;
  threads?: DiscussionThread[];
  // A PR's: GitHub's verdict, and where each reviewer stands (their latest
  // approval or request for changes still standing). Kept on an issue's page,
  // which leaves its PR's reviews out.
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';
  decisions?: Array<{ author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' }>;
}

// Each reviewer's latest decision, in the order they took it: a later
// comment-only review leaves it standing, a dismissal takes it away.
export function reviewerDecisions(reviews: Array<{ author: string; state: string; submittedAt: string }>): NonNullable<Discussion['decisions']> {
  const latest = new Map<string, { state: string; at: string }>();
  for (const r of [...reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (!r.author || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    latest.delete(r.author);
    latest.set(r.author, { state: r.state, at: r.submittedAt });
  }
  return [...latest].flatMap(([author, { state }]) => (state === 'APPROVED' || state === 'CHANGES_REQUESTED' ? [{ author, state }] : []));
}

export interface DiscussionThread {
  path: string | null;
  // On the current head; null once the code under it changed (isOutdated).
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  url: string;
  comments: Array<{ author: string; body: string; createdAt: string; url: string }>;
}

const DISCUSSION_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 50) { nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}`;

async function getDiscussionThreads(prNumber: number): Promise<DiscussionThread[]> {
  const [owner, repo] = activeRepo().productRepo.split('/');
  type Raw = { data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null; originalLine: number | null; comments: { nodes: Array<{ author: { login: string } | null; body: string; createdAt: string; url: string }> } }> } } } } };
  const raw = JSON.parse(await ghApi(['api', 'graphql', '-f', `query=${DISCUSSION_THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${prNumber}`])) as Raw;
  return raw.data.repository.pullRequest.reviewThreads.nodes
    .filter((t) => t.comments.nodes.length > 0)
    .map((t) => ({
      path: t.path,
      line: t.line ?? t.originalLine,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      url: t.comments.nodes[0].url,
      comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? '', body: c.body, createdAt: c.createdAt, url: c.url })),
    }));
}

export async function getDiscussion(kind: 'issue' | 'pr', number: number): Promise<Discussion> {
  const fields = 'number,title,body,author,createdAt,url,state,labels,comments' + (kind === 'pr' ? ',mergeable,baseRefName,headRefName,reviews,isDraft,reviewDecision' : '');
  type Raw = Omit<Discussion, 'author' | 'comments' | 'body' | 'labels' | 'reviews' | 'threads' | 'reviewDecision' | 'decisions'> & {
    reviewDecision?: Discussion['reviewDecision'] | null;
    body: string | null;
    author: { login: string } | null;
    labels: Array<{ name: string }>;
    comments: Array<{ author: { login: string } | null; body: string; createdAt: string; url: string }>;
    reviews?: Array<{ author: { login: string } | null; body: string; state: string; submittedAt: string }>;
  };
  const [raw, threads] = await Promise.all([
    gh([kind, 'view', String(number), '--json', fields]).then((out) => JSON.parse(out) as Raw),
    kind === 'pr' ? getDiscussionThreads(number) : undefined,
  ]);
  const { reviews, reviewDecision, ...rest } = raw;
  const all = reviews?.map((r) => ({ author: r.author?.login ?? '', body: r.body, state: r.state, submittedAt: r.submittedAt }));
  // How a closed issue closed, which this gh can't say (#129).
  const stateReason = kind === 'issue' && raw.state === 'CLOSED' ? (await getIssueState(number).catch(() => undefined))?.stateReason : undefined;
  return {
    ...rest,
    ...(stateReason ? { stateReason } : {}),
    ...(all ? { reviews: all.filter((r) => r.body.trim() || ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)), decisions: reviewerDecisions(all) } : {}),
    ...(kind === 'pr' ? { reviewDecision: reviewDecision ?? '' } : {}),
    ...(threads ? { threads } : {}),
    body: raw.body ?? '',
    author: raw.author?.login ?? '',
    labels: raw.labels.map((l) => l.name),
    comments: raw.comments.map((c) => ({ author: c.author?.login ?? '', body: c.body, createdAt: c.createdAt, url: c.url })),
  };
}

// A PR's changed files as "Files changed" shows them (#111): each with its
// patch, which GitHub leaves out for a binary or too big a file. GitHub lists
// at most 3000.
export interface PrFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

// `prId`: its node id, which GraphQL's mutations on it take.
export async function getPrFiles(prNumber: number): Promise<{ prId: string; author: string; headSha: string; baseSha: string; files: PrFile[] }> {
  const path = `repos/${activeRepo().productRepo}/pulls/${prNumber}`;
  const [pr, lines] = await Promise.all([
    ghApi(['api', path, '--jq', '{id: .node_id, author: .user.login, head: .head.sha, base: .base.sha}']).then((out) => JSON.parse(out) as { id: string; author: string; head: string; base: string }),
    ghApi(['api', '--paginate', `${path}/files?per_page=100`, '--jq', '.[] | {path: .filename, previousPath: .previous_filename, status, additions, deletions, patch}']),
  ]);
  const files = lines.split('\n').filter(Boolean).map((line) => {
    const { previousPath, patch, ...file } = JSON.parse(line) as PrFile & { previousPath: string | null; patch: string | null };
    return { ...file, ...(previousPath ? { previousPath } : {}), ...(patch ? { patch } : {}) };
  });
  return { prId: pr.id, author: pr.author, headSha: pr.head, baseSha: pr.base, files };
}

// A review thread where the diff puts it (#111): on a side and a line (or a
// range startLine..line), or on the whole file. `line` is null once the code
// under it changed (isOutdated); `originalLine` is where it was written.
export interface DiffThread {
  id: string;
  path: string;
  subject: 'line' | 'file';
  side: 'LEFT' | 'RIGHT';
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  url: string;
  comments: Array<{ id: number; author: string; body: string; createdAt: string; url: string }>;
}

const DIFF_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path subjectType diffSide line startLine originalLine
          comments(first: 100) { nodes { databaseId author { login } body createdAt url } }
        }
      }
    }
  }
}`;

export async function getDiffThreads(prNumber: number): Promise<DiffThread[]> {
  const [owner, repo] = activeRepo().productRepo.split('/');
  type Node = { id: string; isResolved: boolean; isOutdated: boolean; path: string; subjectType: 'LINE' | 'FILE'; diffSide: 'LEFT' | 'RIGHT'; line: number | null; startLine: number | null; originalLine: number | null; comments: { nodes: Array<{ databaseId: number; author: { login: string } | null; body: string; createdAt: string; url: string }> } };
  type Raw = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } } } };
  const threads: DiffThread[] = [];
  let after: string | null = null;
  do {
    const raw = JSON.parse(await ghApi(['api', 'graphql', '-f', `query=${DIFF_THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${prNumber}`, ...(after ? ['-f', `after=${after}`] : [])])) as Raw;
    const page = raw.data.repository.pullRequest.reviewThreads;
    for (const t of page.nodes) {
      if (t.comments.nodes.length === 0) continue;
      threads.push({
        id: t.id,
        path: t.path,
        subject: t.subjectType === 'FILE' ? 'file' : 'line',
        side: t.diffSide,
        line: t.line,
        startLine: t.startLine,
        originalLine: t.originalLine,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        url: t.comments.nodes[0].url,
        comments: t.comments.nodes.map((c) => ({ id: c.databaseId, author: c.author?.login ?? '', body: c.body, createdAt: c.createdAt, url: c.url })),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return threads;
}

// A file's text at a commit, for the lines around a diff's hunks.
export async function getFileAt(sha: string, path: string): Promise<string> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return ghApi(['api', `repos/${activeRepo().productRepo}/contents/${encoded}?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw']);
}

export interface ExternalPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

interface RawExternalPr {
  number: number;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author: { login: string } | null;
  isCrossRepository: boolean;
}

export interface RawExternalPrForFilter {
  isDraft: boolean;
  author: { login: string } | null;
}

// Extracted from listAllOpenExternalPrs's own filter so the two guards that
// keep ronin from reviewing its own PRs and work-in-progress drafts are
// directly testable — pure logic, no `gh` shelling. A null author (deleted
// account / ghost) is never the bot, so it stays in.
export function isExternalReviewable(pr: RawExternalPrForFilter, botLogin: string): boolean {
  return !pr.isDraft && pr.author?.login !== botLogin;
}

// Counterpart to listAllOpenRoninPrs above, for the opposite set: every open
// PR ronin did NOT open (author excluded, not branch-name-filtered — see
// docs/superpowers/specs/2026-08-20-external-pr-review-design.md). Draft PRs
// are excluded here too, same as the rest of the pipeline.
export async function listAllOpenExternalPrs(): Promise<ExternalPr[]> {
  const stdout = await gh([
    'pr', 'list',
    '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,isDraft,headRefName,headRefOid,baseRefName,author,isCrossRepository',
  ]);
  const raw = JSON.parse(stdout) as RawExternalPr[];
  if (raw.length === PR_LIST_LIMIT) {
    log.error(`listAllOpenExternalPrs: alcanzó el límite de ${PR_LIST_LIMIT} — puede haber PRs no traídos, subir PR_LIST_LIMIT`);
  }
  return raw
    .filter((pr) => isExternalReviewable(pr, config.githubLogin))
    .map((pr) => ({ number: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName, isCrossRepository: pr.isCrossRepository }));
}

// Every open PR, drafts and forks included — what decides which /preview
// worktrees still have a PR to show (see preview.ts's sweepPreviews).
// …and the commit each one is at, to notice a preview left behind by new
// commits.
export async function listOpenPrHeads(): Promise<Array<{ number: number; headRefOid: string }>> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,headRefOid']);
  return JSON.parse(stdout) as Array<{ number: number; headRefOid: string }>;
}

export interface PrHead {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  title: string;
  body: string;
}

// Every open PR, with what auto-merge.ts decides on: its review and checks
// (read the same way as listAllOpenRoninPrs), whether it conflicts with its
// base, and its labels. All of them, not just the labeled ones: a PR whose
// base is another open PR's branch is part of a stack, and merging it would
// land it in that branch instead of the root.
export interface AutoMergeCandidate {
  status: PullRequestStatus;
  conflicting: boolean;
  labels: string[];
}

export async function listOpenPrsForAutoMerge(): Promise<AutoMergeCandidate[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', `${PR_JSON_FIELDS},labels`]);
  const raw = JSON.parse(stdout) as Array<RawPr & { labels: Array<{ name: string }> }>;
  return raw.map((pr) => ({
    status: toPullRequestStatus(pr),
    conflicting: pr.mergeable === 'CONFLICTING',
    labels: pr.labels.map((l) => l.name),
  }));
}

export async function getPrHead(prNumber: number): Promise<PrHead> {
  return JSON.parse(await gh(['pr', 'view', String(prNumber), '--json', 'state,headRefOid,headRefName,baseRefName,isCrossRepository,title,body'])) as PrHead;
}

async function listOpenPrsWithBase(baseBranch: string): Promise<number[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--base', baseBranch, '--json', 'number']);
  return (JSON.parse(stdout) as Array<{ number: number }>).map((p) => p.number);
}

// Called after ronin's own merges (mergePullRequest) and after a human
// merges a slice PR (tick.ts's syncMergedSlices).
export async function retargetDependents(mergedBranch: string, newBase: string): Promise<void> {
  // Retargets any PR still based on this now-merged branch onto the merged
  // PR's own base (always `main` in practice, since only the bottom of a stack ever
  // merges — see docs/superpowers/specs/2026-07-28-stacked-prs-design.md §1).
  // GitHub does NOT auto-retarget dependent PRs when their base branch is
  // deleted, contrary to what this function used to assume — it auto-CLOSES
  // them instead, even with a clean, conflict-free diff. Discovered live: PR
  // #231 got closed this way when PR #230's branch was deleted, racing
  // GitHub's own (nonexistent) retarget behavior. So this stays explicit.
  // REST, not `gh pr edit` — the latter also fetches the updated PR back
  // (including project-card fields) to print it, and that GraphQL query now
  // errors on any repo that ever touched Projects Classic, even though the
  // base-branch edit itself already succeeded. Discovered live: PR #238 was
  // already correctly retargeted to main after this "failed".
  //
  // Same class of bug shows up on this PATCH call too — discovered live on
  // PR #239, which threw "422 Validation Failed" here yet ended up with the
  // right base anyway. So a throw doesn't necessarily mean the retarget
  // didn't happen: re-check the actual base before deciding whether to
  // propagate the error, instead of costing a whole retry cycle over a
  // response-layer flake.
  for (const dependent of await listOpenPrsWithBase(mergedBranch)) {
    try {
      await ghApi(['api', '--method', 'PATCH', `repos/${activeRepo().productRepo}/pulls/${dependent}`, '-f', `base=${newBase}`]);
    } catch (error) {
      const current = await getPullRequestStatus(dependent);
      if (current.baseRefName !== newBase) throw error;
    }
  }
}

// Hard gate lives here, not just in docs: refuses to merge anything without
// an explicit human approval, regardless of what a caller passes in.
export async function mergePullRequest(prNumber: number): Promise<void> {
  const status = await getPullRequestStatus(prNumber);
  if (status.reviewDecision !== 'APPROVED') {
    throw new Error(`Refusing to merge PR #${prNumber}: reviewDecision is "${status.reviewDecision}", not APPROVED`);
  }
  // --squash fails outright on bmedical — squash merges are disabled at the
  // repo settings level (found live: `gh pr merge --squash` errors with
  // "Squash merges are not allowed on this repository"). --merge is what's
  // actually enabled there (along with --rebase); hardcoded rather than
  // detected at runtime since PRODUCT_REPO is a single fixed target today.
  await gh(['pr', 'merge', String(prNumber), '--merge']);

  await retargetDependents(status.headRefName, status.baseRefName);
  // No manual branch delete here: PRODUCT_REPO has "Automatically delete
  // head branches" enabled at the repo-settings level (confirmed live via
  // `gh api repos/<repo> --jq .delete_branch_on_merge` → true), so GitHub
  // deletes the branch itself right after the merge above. An earlier
  // version of this function also issued its own
  // `DELETE git/refs/heads/<branch>` call here as a safety net, but that
  // raced GitHub's own automatic deletion and lost, throwing an unhandled
  // "422 Reference does not exist" that crashed the run. Discovered live.
}


// Opt-in only (config.requestCopilotReview) — requesting Copilot review
// automatically is explicitly out of scope for the core loop for now.
// NOTE: untested against the same `gh pr edit` GraphQL/Projects-Classic bug
// documented on setPrState below — `--add-reviewer` has no `gh issue edit`
// equivalent (reviewers aren't an issue concept), so if this turns out to
// hit the same bug when the flag gets turned on, it'll need `gh api` directly.
export async function requestCopilotReview(prNumber: number): Promise<void> {
  await gh(['pr', 'edit', String(prNumber), '--add-reviewer', 'copilot']);
}

export interface SpecPr {
  number: number;
  headRefName: string;
}

// Discovery source of truth: a spec PR is ready for this runner once a
// human has assigned it to the `ronin` account (GitHub's native Assignees
// field, filtered server-side by `gh`) AND marked it ready for review.
// Still-draft PRs are excluded on purpose — the human can keep iterating on
// the spec without the agent touching it. Already in-progress/done ones are
// excluded so a spec PR is only ever picked up once. See docs/DESIGN.md §1.
export async function listAssignedSpecPrs(): Promise<SpecPr[]> {
  const stdout = await gh([
    'pr', 'list',
    '--assignee', config.githubLogin,
    '--state', 'open',
    '--json', 'number,isDraft,headRefName,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; isDraft: boolean; headRefName: string; labels: Array<{ name: string }> }>;
  return raw
    .filter((pr) => !pr.isDraft)
    .filter((pr) => !pr.labels.some((l) => l.name === LABEL_STATES['in-progress'] || l.name === LABEL_STATES.done || l.name === LABEL_STATES.blocked))
    .map((pr) => ({ number: pr.number, headRefName: pr.headRefName }));
}

export interface BugIssue {
  number: number;
  title: string;
}

// Discovery source of truth for the direct-issue-intake path: any issue is
// ready for this runner once a human has assigned it to the `ronin` account
// (GitHub's native Assignees field, filtered server-side by `gh`) — no label
// required, no draft/ready step like a spec PR has, since a GitHub issue has
// no draft state. Already-managed issues (label `ronin` present) or already
// in a tracked state (ready/in-progress/blocked/done) are excluded so an
// issue is only ever picked up once — mirrors listAssignedSpecPrs's filter
// above. See docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md
// (original design, since generalized from bug-only intake to any assigned
// issue — clarity is now judged per-issue by the agent itself, see
// slices/prompts.ts's 'fix-issue' prompt).
export async function listAssignedIssues(): Promise<BugIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--assignee', config.githubLogin,
    '--state', 'open',
    '--json', 'number,title,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  return raw
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_MANAGED))
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_STATES['in-progress'] || l.name === LABEL_STATES.done || l.name === LABEL_STATES.blocked))
    .map((issue) => ({ number: issue.number, title: issue.title }));
}

// Discovery source for the `/spike` command (see spike.ts): every open issue
// not yet in ronin's normal pipeline, regardless of assignee — unlike
// listAssignedIssues above, /spike is meant to run *before* an issue is
// handed off, so there's no --assignee filter here. Same LABEL_MANAGED
// exclusion as listAssignedIssues: once an issue is ronin-managed, it's
// tracked by the main pipeline instead and /spike no longer applies to it.
export async function listOpenUnmanagedIssues(): Promise<BugIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--state', 'open',
    '--json', 'number,title,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  return raw
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_MANAGED))
    .map((issue) => ({ number: issue.number, title: issue.title }));
}

// Swaps state labels on a spec PR the same way setIssueState does on a
// tracking issue — same LABEL_STATES vocabulary applied to a different
// resource type. PRs and issues share the same underlying label set (a PR
// number is an issue number), so this reads/writes the identical data
// setIssueState would for that number — no collision risk in practice
// since a spec PR's number and its resulting tracking issue's number are
// always different numbers.
//
// Uses `gh issue edit`, not `gh pr edit`: `gh pr edit --add-label` on this
// org currently fails with a GraphQL error from a deprecated Projects
// (classic) field it queries internally, even though the mutation has
// nothing to do with project boards — found live, see docs/DESIGN.md §1.
// `gh issue edit` performs the identical label mutation without hitting
// that code path, since PRs and issues share the labels endpoint.
export async function setPrState(prNumber: number, next: SpecStatus): Promise<void> {
  const current = await gh(['pr', 'view', String(prNumber), '--json', 'labels']);
  const labels = (JSON.parse(current) as { labels: Array<{ name: string }> }).labels.map((l) => l.name);
  const staleStateLabels = Object.values(LABEL_STATES).filter((l) => labels.includes(l) && l !== LABEL_STATES[next]);

  await ensureLabel(LABEL_STATES[next]);
  const args = ['issue', 'edit', String(prNumber), '--add-label', LABEL_STATES[next]];
  for (const stale of staleStateLabels) args.push('--remove-label', stale);
  await gh(args);
}

// A spec PR can include more than one .md file under config.specDir — e.g.
// bmedical's own convention pairs a specs/<name>-design.md with one or more
// plans/<name>.md. All of them are relevant context for slicing, not just
// whichever happens to sort first — found live against a real PR that had
// exactly this shape (a design doc + two plan docs).
export async function getSpecPathsFromPr(prNumber: number): Promise<string[]> {
  const stdout = await gh(['pr', 'diff', String(prNumber), '--name-only']);
  const files = stdout.trim().split('\n').filter(Boolean);
  const specFiles = files.filter((f) => f.startsWith(config.specDir) && f.endsWith('.md'));
  if (specFiles.length === 0) {
    throw new Error(`PR #${prNumber} has no .md file under ${config.specDir} — can't tell which file(s) are the spec`);
  }
  return specFiles;
}

// Deliberately skips the human-approval gate that mergePullRequest enforces
// — this merges spec documentation, not product code. The human already
// signaled readiness by both assigning the runner label and marking the PR
// ready for review (undrafting it) — see docs/DESIGN.md §1.
export async function mergeSpecPr(prNumber: number): Promise<void> {
  // --merge, not --squash — see the note on mergePullRequest.
  await gh(['pr', 'merge', String(prNumber), '--merge']);
}

export async function commentOnSpecPr(prNumber: number, body: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ronin-spec-pr-comment-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    await gh(['pr', 'comment', String(prNumber), '--body-file', bodyFile]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export interface Comment {
  id: number;
  kind: 'issue' | 'review';
  body: string;
  reactionsEyes: number;
  authorLogin: string;
  createdAt?: string;
  // Inline review comments only: the thread the comment lives in, so a
  // mention like "@ronin arreglá esto" in a reply can be understood without
  // the agent rediscovering what "esto" points at.
  thread?: CommentThread;
}

export interface CommentThread {
  path: string;
  // null when the thread is outdated (its line no longer exists in the diff).
  line: number | null;
  diffHunk: string;
  // Every published comment in the thread, oldest first, including the one
  // this thread is attached to.
  comments: Array<{ id: number; authorLogin: string; body: string }>;
}

export interface RawApiComment {
  id: number;
  body: string;
  created_at?: string;
  reactions: { eyes: number };
  pull_request_review_id?: number | null;
  user: { login: string } | null;
  path?: string;
  line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
  html_url?: string;
}

function reactionsPath(kind: 'issue' | 'review'): string {
  return kind === 'issue' ? 'issues/comments' : 'pulls/comments';
}

// per_page=100 (the API default is 30): comments come back oldest-first, so
// on a busy PR the newest ones — where a fresh mention lives — would fall on
// a page never fetched, silently. 100 is the API maximum.
export async function listIssueComments(prNumber: number): Promise<Comment[]> {
  const stdout = await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${prNumber}/comments?per_page=100`]);
  const raw = JSON.parse(stdout) as RawApiComment[];
  return raw.map((c) => ({ id: c.id, kind: 'issue' as const, body: c.body, reactionsEyes: c.reactions.eyes, authorLogin: c.user?.login ?? '', createdAt: c.created_at }));
}

interface RawReview {
  id: number;
  state: string;
}

interface RawReviewWithCommit {
  login: string;
  state: string;
  commitId: string;
}

// True when some reviewer's standing review (their latest APPROVED,
// CHANGES_REQUESTED or DISMISSED one, which is what GitHub's reviewDecision
// counts) asks for changes on `headSha` itself. A CHANGES_REQUESTED review on
// an older commit means ronin already pushed after it (fix-review, or the
// mention flow answering that same review's inline comments) and GitHub keeps
// the decision until the reviewer re-reviews — firing fix-review again only
// finds nothing to change and burns attempts. Discovered live on
// redmotos/shoppingcart#802.
export function changesRequestedOn(reviews: RawReviewWithCommit[], headSha: string): boolean {
  const standing = new Map<string, RawReviewWithCommit>();
  for (const review of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    standing.set(review.login, review);
  }
  return [...standing.values()].some((r) => r.state === 'CHANGES_REQUESTED' && r.commitId === headSha);
}

export async function changesRequestedOnHead(prNumber: number): Promise<boolean> {
  const [prStdout, reviewsStdout] = await Promise.all([
    ghApi(['api', `repos/${activeRepo().productRepo}/pulls/${prNumber}`, '--jq', '.head.sha']),
    ghApi(['api', '--paginate', `repos/${activeRepo().productRepo}/pulls/${prNumber}/reviews?per_page=100`, '--jq', '.[] | {login: .user.login, state: .state, commitId: .commit_id}']),
  ]);
  const reviews = reviewsStdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as RawReviewWithCommit);
  return changesRequestedOn(reviews, prStdout.trim());
}

// Excluye comentarios que pertenecen a una review todavía en borrador
// (PENDING, no enviada) — no son un pedido real hasta que su autor la
// publica. Ver docs/superpowers/specs/2026-07-28-mention-review-design.md.
export async function listReviewComments(prNumber: number): Promise<Comment[]> {
  const [commentsStdout, reviewsStdout] = await Promise.all([
    ghApi(['api', `repos/${activeRepo().productRepo}/pulls/${prNumber}/comments?per_page=100`]),
    ghApi(['api', `repos/${activeRepo().productRepo}/pulls/${prNumber}/reviews?per_page=100`]),
  ]);
  const rawComments = JSON.parse(commentsStdout) as RawApiComment[];
  const rawReviews = JSON.parse(reviewsStdout) as RawReview[];
  const pendingReviewIds = new Set(rawReviews.filter((r) => r.state === 'PENDING').map((r) => r.id));

  const published = rawComments.filter((c) => !(c.pull_request_review_id != null && pendingReviewIds.has(c.pull_request_review_id)));
  return published.map((c) => ({
    id: c.id,
    kind: 'review' as const,
    body: c.body,
    reactionsEyes: c.reactions.eyes,
    authorLogin: c.user?.login ?? '',
    createdAt: c.created_at,
    thread: threadOf(c, published),
  }));
}

// GitHub replies always point at the thread's first comment (in_reply_to_id
// is never a reply's own id), so grouping by that root rebuilds the thread.
// The root itself carries path/line/diff_hunk for the whole thread.
export function threadOf(comment: RawApiComment, all: RawApiComment[]): CommentThread {
  const rootId = comment.in_reply_to_id ?? comment.id;
  const root = all.find((c) => c.id === rootId) ?? comment;
  const comments = all
    .filter((c) => c.id === rootId || c.in_reply_to_id === rootId)
    .sort((a, b) => a.id - b.id)
    .map((c) => ({ id: c.id, authorLogin: c.user?.login ?? '', body: c.body }));
  return { path: root.path ?? comment.path ?? '', line: root.line ?? null, diffHunk: root.diff_hunk ?? comment.diff_hunk ?? '', comments };
}

// Whether ronin put its 👀 on the comment before `before` (ISO) — back when
// that 👀 meant "done", not "got it" (see processed-comments.ts).
export async function botReactedBefore(commentId: number, kind: 'issue' | 'review', botLogin: string, before: string): Promise<boolean> {
  const stdout = await ghApi([
    'api',
    `repos/${activeRepo().productRepo}/${reactionsPath(kind)}/${commentId}/reactions?content=eyes&per_page=100`,
  ]);
  const raw = JSON.parse(stdout) as Array<{ user: { login: string }; created_at: string }>;
  return raw.some((r) => r.user.login === botLogin && r.created_at < before);
}

// The "got it" 👀 the webhook server puts on a mention the moment it
// arrives, before anything is processed (server/api/webhooks/github.ts). Whether it's
// done is tracked apart (processed-comments.ts). Takes the repo itself: the
// server isn't inside withActiveRepo.
export async function addAckReaction(repo: string, commentId: number, kind: 'issue' | 'review'): Promise<void> {
  await ghApi(['api', `repos/${repo}/${reactionsPath(kind)}/${commentId}/reactions`, '-f', 'content=eyes']);
}

export async function addReaction(commentId: number, kind: 'issue' | 'review', content: 'eyes'): Promise<void> {
  await ghApi([
    'api',
    `repos/${activeRepo().productRepo}/${reactionsPath(kind)}/${commentId}/reactions`,
    '-f',
    `content=${content}`,
  ]);
}

// Replies where the comment was left: inside its own thread for an inline
// review comment, or as a new general comment otherwise. `number` is the PR
// or issue the comment belongs to — issues/{n}/comments works for both,
// since a PR is an issue under the hood.
export async function replyToComment(number: number, comment: Pick<Comment, 'id' | 'kind'>, body: string): Promise<void> {
  const path = comment.kind === 'review'
    ? `repos/${activeRepo().productRepo}/pulls/${number}/comments/${comment.id}/replies`
    : `repos/${activeRepo().productRepo}/issues/${number}/comments`;
  await ghApi(['api', path, '-f', `body=${body}`]);
}

// A general comment on an issue or PR, as ronin, returning it: what a
// dashboard action (#85) leaves as the record of who asked for what, and the
// comment its worker then answers.
export async function postIssueComment(number: number, body: string): Promise<{ id: number; url: string }> {
  const created = JSON.parse(await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${number}/comments`, '-f', `body=${body}`])) as { id: number; html_url: string };
  return { id: created.id, url: created.html_url };
}

// REST, not `gh pr edit --body-file`: `gh pr edit` fails on this org with a
// GraphQL error from a deprecated Projects (classic) field it queries
// internally — see the note on setPrState.
export async function setPullRequestBody(prNumber: number, body: string): Promise<void> {
  await ghApi(['api', '-X', 'PATCH', `repos/${activeRepo().productRepo}/pulls/${prNumber}`, '-f', `body=${body}`]);
}

const REVIEW_THREADS_PAGE_SIZE = 100;
// Comments fetched per thread: the opening comment plus the replies the
// external review reads as history (a human's reason for dismissing it).
const THREAD_COMMENTS_PAGE_SIZE = 20;

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${REVIEW_THREADS_PAGE_SIZE}) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: ${THREAD_COMMENTS_PAGE_SIZE}) {
            nodes {
              author { login }
              body
              url
              reactionGroups { content reactors { totalCount } }
            }
          }
        }
      }
    }
  }
}`;

interface RawThreadComment {
  author: { login: string } | null;
  body: string;
  url?: string;
  reactionGroups?: Array<{ content: string; reactors: { totalCount: number } }>;
}

interface RawReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            isOutdated?: boolean;
            path?: string | null;
            line?: number | null;
            originalLine?: number | null;
            comments: { nodes: RawThreadComment[] };
          }>;
        };
      };
    };
  };
}

export interface ReviewThread {
  id: string;
  body: string;
  // Link to the thread's first comment — used by the external review's
  // closing message to list what is still open.
  url?: string;
}

// A thread the bot opened, open or resolved, with what the external review
// needs to avoid re-raising it or contradicting it: where it is now, what
// people answered and how they reacted to it.
export interface BotThread extends ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  // The line on the current head; null once the code under it changed.
  line: number | null;
  originalLine: number | null;
  replies: Array<{ authorLogin: string; body: string }>;
  thumbsUp: number;
  thumbsDown: number;
}

interface FetchedThread extends BotThread {
  authorLogin: string | null;
}

function reactionCount(comment: RawThreadComment, content: string): number {
  return comment.reactionGroups?.find((g) => g.content === content)?.reactors.totalCount ?? 0;
}

// Every review thread on the PR, open and resolved, unfiltered by author —
// each caller applies its own filters. GraphQL (not REST) because REST has
// no resolved/unresolved field on review comments — see
// docs/superpowers/specs/2026-08-20-external-pr-review-design.md.
async function fetchReviewThreads(prNumber: number): Promise<FetchedThread[]> {
  const [owner, repo] = activeRepo().productRepo.split('/');
  const stdout = await ghApi([
    'api', 'graphql',
    '-f', `query=${REVIEW_THREADS_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `repo=${repo}`,
    '-F', `number=${prNumber}`,
  ]);
  const parsed = JSON.parse(stdout) as RawReviewThreadsResponse;
  const nodes = parsed.data.repository.pullRequest.reviewThreads.nodes;
  // The query asks for `first: 100` with no cursor follow-up — a PR past
  // that many threads silently loses the tail, which would look like the bot
  // "forgetting" its own older open threads. Not paginated (a PR with 100+
  // threads is pathological), but at least visible in the log instead of
  // silent — same treatment as PR_LIST_LIMIT above.
  if (nodes.length === REVIEW_THREADS_PAGE_SIZE) {
    log.error(`fetchReviewThreads: PR #${prNumber} alcanzó el límite de ${REVIEW_THREADS_PAGE_SIZE} threads — puede haber threads no traídos`);
  }
  return nodes
    .filter((t) => t.comments.nodes[0] != null)
    .map((t) => {
      const [first, ...rest] = t.comments.nodes;
      return {
        id: t.id,
        body: first.body,
        url: first.url,
        authorLogin: first.author?.login ?? null,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated ?? false,
        path: t.path ?? null,
        line: t.line ?? null,
        originalLine: t.originalLine ?? null,
        replies: rest.map((c) => ({ authorLogin: c.author?.login ?? '', body: c.body })),
        thumbsUp: reactionCount(first, 'THUMBS_UP'),
        thumbsDown: reactionCount(first, 'THUMBS_DOWN'),
      };
    });
}

async function fetchOpenReviewThreads(prNumber: number): Promise<FetchedThread[]> {
  return (await fetchReviewThreads(prNumber)).filter((t) => !t.isResolved);
}

// Every thread the bot opened, open and resolved — the external review's
// history of its own findings on this PR.
export async function listBotReviewThreads(prNumber: number, botLogin: string): Promise<BotThread[]> {
  const threads = await fetchReviewThreads(prNumber);
  return threads.filter((t) => t.authorLogin === botLogin).map(({ authorLogin: _author, ...thread }) => thread);
}

// Only threads ronin itself opened (first comment's author == botLogin) and
// still unresolved — a human's own thread, or one already resolved, is never
// something this bot should touch.
export async function listBotOpenReviewThreads(prNumber: number, botLogin: string): Promise<ReviewThread[]> {
  const threads = await fetchOpenReviewThreads(prNumber);
  return threads.filter((t) => t.authorLogin === botLogin).map((t) => ({ id: t.id, body: t.body, url: t.url }));
}

// Inverse of listBotOpenReviewThreads: every unresolved thread ronin did NOT
// open (opened by a human, Copilot, or another bot) — the candidate set for
// the /fix-comments command. A thread a human already resolved manually is
// exactly how they opt a finding out of being auto-fixed, so this never
// looks at resolved threads at all.
export async function listExternalOpenReviewThreads(prNumber: number, botLogin: string): Promise<ReviewThread[]> {
  const threads = await fetchOpenReviewThreads(prNumber);
  return threads.filter((t) => t.authorLogin !== botLogin).map((t) => ({ id: t.id, body: t.body }));
}

// Every unresolved thread regardless of who opened it — used by
// fix-comments-external, where the human triggering it is trusted to decide
// this PR's own bot-authored findings (e.g. from an earlier automatic
// external-review pass) are fair game too, not just Copilot/human ones. See
// docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
export async function listAllOpenReviewThreads(prNumber: number): Promise<ReviewThread[]> {
  const threads = await fetchOpenReviewThreads(prNumber);
  return threads.map((t) => ({ id: t.id, body: t.body }));
}

// The SHA the external review last reviewed, as ronin itself recorded it in
// the body of the review (renderReviewMarker). Only reviews carrying that
// marker count: the bot's replies to inline comments (/fix-comments,
// mentions) create review objects too, with whatever commit was current then.
const REVIEW_MARKER_SHA_RE = /<!-- ronin:review v=2 sha=([0-9a-f]{7,40})\b/;

export interface RawReviewForMarker {
  login: string | null;
  body: string | null;
  submittedAt: string | null;
}

export function lastMarkedReviewSha(reviews: RawReviewForMarker[], botLogin: string): string | undefined {
  let latest: { sha: string; at: string } | undefined;
  for (const review of reviews) {
    if (review.login !== botLogin || !review.body || !review.submittedAt) continue;
    const sha = REVIEW_MARKER_SHA_RE.exec(review.body)?.[1];
    if (sha && (!latest || review.submittedAt > latest.at)) latest = { sha, at: review.submittedAt };
  }
  return latest?.sha;
}

export async function getLastReviewedShaFromGitHub(prNumber: number, botLogin: string): Promise<string | undefined> {
  // --jq prints one compact JSON object per line across every page.
  const stdout = await ghApi([
    'api', '--paginate', `repos/${activeRepo().productRepo}/pulls/${prNumber}/reviews?per_page=100`,
    '--jq', '.[] | {login: .user.login, body: .body, submittedAt: .submitted_at}',
  ]);
  const reviews = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawReviewForMarker);
  return lastMarkedReviewSha(reviews, botLogin);
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

// A review with inline comments needs a JSON array body, which `gh api -f`
// can't express — the payload goes through --input from a temp file instead.
// `event` is hardcoded on purpose and has no parameter: a bot review never
// gates the merge (docs/superpowers/specs/2026-08-20-external-pr-review-design.md,
// "Nunca APPROVE ni REQUEST_CHANGES"). `commit_id` pins the review to the
// exact commit that was reviewed; the "last reviewed SHA" is read back from
// the review marker in the body instead (getLastReviewedShaFromGitHub).
export async function postReview(
  prNumber: number,
  review: { commitId: string; body: string; comments: ReviewCommentInput[] },
): Promise<void> {
  const payload = {
    commit_id: review.commitId,
    event: 'COMMENT',
    body: review.body,
    comments: review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      ...(c.startLine != null && c.startLine < c.line ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
      body: c.body,
    })),
  };
  const dir = await mkdtemp(join(tmpdir(), 'ronin-review-'));
  const file = join(dir, 'review.json');
  try {
    await writeFile(file, JSON.stringify(payload));
    await ghApi(['api', '--method', 'POST', `repos/${activeRepo().productRepo}/pulls/${prNumber}/reviews`, '--input', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function resolveReviewThread(threadId: string): Promise<void> {
  await ghApi([
    'api', 'graphql',
    '-f', 'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }',
    '-f', `id=${threadId}`,
  ]);
}

export type ReviewStatusState = 'pending' | 'success' | 'error';

// GitHub caps a commit status `description` at this many characters and
// silently truncates past it — trim ourselves so the message stays legible.
const STATUS_DESCRIPTION_MAX = 140;

// Posts a commit status (context `ronin/review`) on a PR's head commit so a
// human watching the PR can see in its checks box when ronin is running a
// review and how it finished. Deliberately the Commit Status API, not Check
// Runs: check runs are only writable by a GitHub App, and ronin
// authenticates as a plain user PAT (the `ronin` account) — see
// docs/superpowers/specs. The status is bound to one SHA, so a push after a
// `pending` drops the row until the next tick re-posts it.
//
// Purely informational: a failure to post the status must never disturb the
// review flow that called it, so this swallows its own errors after logging
// rather than throwing. `sha` is passed by callers that already hold the
// head oid (the external-review candidates); the slice flows let it resolve
// the oid itself.
export async function setReviewStatus(
  prNumber: number,
  state: ReviewStatusState,
  description: string,
  opts: { sha?: string; context?: string } = {},
): Promise<void> {
  const context = opts.context ?? 'ronin/review';
  try {
    let headSha = opts.sha;
    if (headSha == null) {
      const stdout = await gh(['pr', 'view', String(prNumber), '--json', 'headRefOid']);
      headSha = (JSON.parse(stdout) as { headRefOid: string }).headRefOid;
    }
    await ghApi([
      'api', '--method', 'POST',
      `repos/${activeRepo().productRepo}/statuses/${headSha}`,
      '-f', `state=${state}`,
      '-f', `context=${context}`,
      '-f', `description=${description.slice(0, STATUS_DESCRIPTION_MAX)}`,
    ]);
  } catch (error) {
    log.error(`setReviewStatus(${prNumber}, ${context}, ${state}) failed`, error);
  }
}

export interface Release {
  tagName: string;
  name: string;
  url: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

interface RawRelease {
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

// Used by changelog.ts's findReleasesNeedingChangelog — deliberately not
// filtered here (draft/prerelease exclusion, and the "already handled"
// comparison against lastChangelogRelease) so this stays a thin, testable
// wrapper around the raw listing, same split as every other list* function
// in this file. `gh release list --json` has no `url` field (unlike `gh pr
// list`), so it's built by hand — GitHub's release URLs always follow this
// exact shape.
export async function listReleases(): Promise<Release[]> {
  const stdout = await gh(['release', 'list', '--json', 'tagName,name,publishedAt,isDraft,isPrerelease']);
  const raw = JSON.parse(stdout) as RawRelease[];
  return raw.map((r) => ({ ...r, url: `https://github.com/${activeRepo().productRepo}/releases/tag/${r.tagName}` }));
}

// A deploy (#158, deploy/): the release of a tag ronin already pushed
// (--verify-tag: never one gh would create from the default branch on its
// own). The repo's workflow runs on the tag or on the release.
export async function createRelease(opts: { tag: string; title: string; notes: string; prerelease: boolean }): Promise<string> {
  const stdout = await gh(['release', 'create', opts.tag, '--verify-tag', '--title', opts.title, '--notes', opts.notes, ...(opts.prerelease ? ['--prerelease'] : [])]);
  return stdout.trim().split('\n').at(-1) ?? '';
}

// The PRs merged into `base`, newest first, with the commit their merge
// left on it (a merge commit or the squash): what a deploy carries, by PR
// (#158), in a repo whose merge commits don't name their PR.
export async function listMergedPrs(base: string): Promise<Array<{ number: number; title: string; mergeCommit: string }>> {
  const stdout = await gh(['pr', 'list', '--state', 'merged', '--base', base, '--limit', '100', '--json', 'number,title,mergeCommit']);
  return (JSON.parse(stdout) as Array<{ number: number; title: string; mergeCommit: { oid: string } | null }>)
    .flatMap((p) => (p.mergeCommit ? [{ number: p.number, title: p.title, mergeCommit: p.mergeCommit.oid }] : []));
}

export interface WorkflowRun {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string;
  event: string;
  url: string;
  headSha: string;
}

// The workflow runs a tag set off: GitHub names a tag's (pushed, or
// released) runs after the tag, as it names a branch's.
export async function listTagRuns(tag: string): Promise<WorkflowRun[]> {
  const stdout = await gh(['run', 'list', '--branch', tag, '--limit', '20', '--json', 'databaseId,workflowName,status,conclusion,event,url,headSha']);
  return JSON.parse(stdout) as WorkflowRun[];
}

// Exploration's weekly PR (exploration/pr.ts) — see docs/DESIGN.md §11.7.

export async function findOpenPrByHead(headBranch: string): Promise<PullRequestStatus | null> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--head', headBranch, '--json', PR_JSON_FIELDS]);
  const raw = JSON.parse(stdout) as RawPr[];
  return raw.length > 0 ? toPullRequestStatus(raw[0]) : null;
}

export async function listOpenPrsByHeadPrefix(prefix: string): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_JSON_FIELDS]);
  return (JSON.parse(stdout) as RawPr[]).filter((pr) => pr.headRefName.startsWith(prefix)).map(toPullRequestStatus);
}

// REST, not `gh pr create`: same deprecated-Projects GraphQL failure as `gh
// pr edit` (see setPullRequestBody).
export async function createPullRequest(opts: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<number> {
  const stdout = await ghApi([
    'api', '-X', 'POST', `repos/${activeRepo().productRepo}/pulls`,
    '-f', `head=${opts.head}`, '-f', `base=${opts.base}`, '-f', `title=${opts.title}`, '-f', `body=${opts.body}`,
    '-F', `draft=${opts.draft}`,
  ]);
  return (JSON.parse(stdout) as { number: number }).number;
}

export async function markPullRequestReady(prNumber: number): Promise<void> {
  await gh(['pr', 'ready', String(prNumber)]);
}

export interface FileReviewComment {
  id: number;
  path: string;
  body: string;
  authorLogin: string;
  reactionsEyes: number;
  createdAt?: string;
  // Replies inside a thread point at its first comment; only first comments
  // carry feedback on a file.
  inReplyToId?: number;
  url?: string;
}

export async function listFileReviewComments(prNumber: number): Promise<FileReviewComment[]> {
  const stdout = await ghApi(['api', `repos/${activeRepo().productRepo}/pulls/${prNumber}/comments?per_page=100`]);
  const raw = JSON.parse(stdout) as Array<RawApiComment & { path: string; in_reply_to_id?: number }>;
  return raw.map((c) => ({
    id: c.id,
    path: c.path,
    body: c.body,
    authorLogin: c.user?.login ?? '',
    reactionsEyes: c.reactions.eyes,
    createdAt: c.created_at,
    ...(c.in_reply_to_id ? { inReplyToId: c.in_reply_to_id } : {}),
    ...(c.html_url ? { url: c.html_url } : {}),
  }));
}

// Closes an issue as "not planned", leaving `comment` on it first. False,
// with nothing posted, when it was already closed. REST rather than `gh issue
// close`/`comment`, same reason as setPrState: those go through the GraphQL
// path that trips over Projects (classic).
export async function closeIssueNotPlanned(issueNumber: number, comment: string): Promise<boolean> {
  const path = `repos/${activeRepo().productRepo}/issues/${issueNumber}`;
  const { state } = JSON.parse(await ghApi(['api', path])) as { state: string };
  if (state !== 'open') return false;
  await ghApi(['api', '--method', 'POST', `${path}/comments`, '-f', `body=${comment}`]);
  await ghApi(['api', '--method', 'PATCH', path, '-f', 'state=closed', '-f', 'state_reason=not_planned']);
  return true;
}

export async function createIssue(title: string, body: string, labels: string[], assignees: string[] = []): Promise<{ number: number; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    for (const label of labels) await ensureLabel(label);
    const stdout = await gh(['issue', 'create', '--title', title, '--body-file', bodyFile, ...labels.flatMap((l) => ['--label', l]), ...assignees.flatMap((a) => ['--assignee', a])]);
    const url = stdout.trim();
    return { number: Number(url.split('/').pop()), url };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Every issue (open or closed) with this label, with its body — how
// exploration finds the issue it already opened for a finding.
export async function listIssuesWithLabel(label: string): Promise<Array<{ number: number; body: string; state: string }>> {
  const stdout = await gh(['issue', 'list', '--state', 'all', '--label', label, '--limit', '1000', '--json', 'number,body,state']);
  return JSON.parse(stdout) as Array<{ number: number; body: string; state: string }>;
}

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  await ghApi(['api', `repos/${activeRepo().productRepo}/issues/${issueNumber}/comments`, '-f', `body=${body}`]);
}
