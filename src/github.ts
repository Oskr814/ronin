import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, LABEL_MANAGED, LABEL_STATES, type SpecStatus } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';

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
  statusCheckRollup: Array<{ conclusion: string | null }>;
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  body: string | null;
}

function toPullRequestStatus(raw: RawPr): PullRequestStatus {
  return {
    number: raw.number,
    state: raw.state,
    reviewDecision: raw.reviewDecision ?? '',
    // A still-running CheckRun reports conclusion as "" (empty string), not
    // null — discovered live on PR #238, where an in-progress "Integration
    // Tests" run got misread as an actual failure and spuriously triggered
    // fix-e2e. Treat both null and "" as "not concluded yet".
    //
    // NEUTRAL and SKIPPED are concluded-but-not-a-failure (e.g. a workflow
    // that no-ops on this diff, or a required-only check GitHub skips) —
    // `gh pr checks` itself doesn't count them as failures. Discovered live
    // on PR #601: a NEUTRAL/SKIPPED entry alongside otherwise-SUCCESS checks
    // made checksPassing false while checksPending was also false, spuriously
    // triggering fix-e2e on a PR with nothing actually failing.
    checksPassing: raw.statusCheckRollup.length > 0
      && raw.statusCheckRollup.every((c) => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'),
    checksPending: raw.statusCheckRollup.length === 0 || raw.statusCheckRollup.some((c) => !c.conclusion),
    mergeable: raw.mergeable === 'MERGEABLE',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft,
    body: raw.body ?? '',
  };
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

async function listOpenPrsWithBase(baseBranch: string): Promise<number[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--base', baseBranch, '--json', 'number']);
  return (JSON.parse(stdout) as Array<{ number: number }>).map((p) => p.number);
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

  // Retarget any PR still based on this now-merged branch onto this PR's own
  // base (always `main` in practice, since only the bottom of a stack ever
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
  for (const dependent of await listOpenPrsWithBase(status.headRefName)) {
    try {
      await ghApi(['api', '--method', 'PATCH', `repos/${activeRepo().productRepo}/pulls/${dependent}`, '-f', `base=${status.baseRefName}`]);
    } catch (error) {
      const current = await getPullRequestStatus(dependent);
      if (current.baseRefName !== status.baseRefName) throw error;
    }
  }
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
// agent-task.ts's 'fix-issue' prompt).
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
  reactions: { eyes: number };
  pull_request_review_id?: number | null;
  user: { login: string } | null;
  path?: string;
  line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
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
  return raw.map((c) => ({ id: c.id, kind: 'issue' as const, body: c.body, reactionsEyes: c.reactions.eyes, authorLogin: c.user?.login ?? '' }));
}

interface RawReview {
  id: number;
  state: string;
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

export async function hasBotReaction(commentId: number, kind: 'issue' | 'review', botLogin: string): Promise<boolean> {
  const stdout = await ghApi([
    'api',
    `repos/${activeRepo().productRepo}/${reactionsPath(kind)}/${commentId}/reactions?content=eyes&per_page=100`,
  ]);
  const raw = JSON.parse(stdout) as Array<{ user: { login: string } }>;
  return raw.some((r) => r.user.login === botLogin);
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

// Exploration's weekly PR (exploration-pr.ts) — see docs/DESIGN.md §11.7.

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
  // Replies inside a thread point at its first comment; only first comments
  // carry feedback on a file.
  inReplyToId?: number;
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
    ...(c.in_reply_to_id ? { inReplyToId: c.in_reply_to_id } : {}),
  }));
}

export async function createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    for (const label of labels) await ensureLabel(label);
    const stdout = await gh(['issue', 'create', '--title', title, '--body-file', bodyFile, ...labels.flatMap((l) => ['--label', l])]);
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
