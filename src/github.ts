import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, LABEL_MANAGED, LABEL_STATES, LABEL_BUG, type SpecStatus } from './config.js';
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

// `gh api` has no --repo/-R flag at all (unlike `gh pr`/`gh issue`), so it
// can't go through gh() above: it would fail outright with "unknown flag:
// --repo". It resolves the {owner}/{repo} placeholders from the current
// directory's git remote or $GH_REPO — and the supervisor's cwd is ValerIA's
// own checkout, not PRODUCT_REPO_PATH, so those placeholders would target the
// wrong repo anyway. Every caller therefore spells out
// `repos/${config.productRepo}/...` literally instead.
async function ghApi(args: string[]): Promise<string> {
  const token = await getInstallationToken();
  const { stdout } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
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
  const dir = await mkdtemp(join(tmpdir(), 'valeria-issue-body-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    await gh(['issue', 'edit', String(issueNumber), '--body-file', bodyFile]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ATTEMPT_LABEL_RE = /^valeria:attempts-(\d+)$/;

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
  await ensureLabel(`valeria:attempts-${next}`);
  // `gh issue edit`, not `gh pr edit` — see the note on setPrState below.
  const args = ['issue', 'edit', String(prNumber), '--add-label', `valeria:attempts-${next}`];
  if (current > 0) args.push('--remove-label', `valeria:attempts-${current}`);
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
  const dir = await mkdtemp(join(tmpdir(), 'valeria-issue-'));
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

// Swaps the current valeria:* state label for `next`. Only one state label is
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
}

export async function getPullRequestStatus(prNumber: number): Promise<PullRequestStatus> {
  const stdout = await gh([
    'pr', 'view', String(prNumber),
    '--json', 'number,state,reviewDecision,statusCheckRollup,mergeable,headRefName,baseRefName,isDraft',
  ]);
  const raw = JSON.parse(stdout) as {
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    reviewDecision: PullRequestStatus['reviewDecision'] | null;
    statusCheckRollup: Array<{ conclusion: string | null }>;
    mergeable: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  };
  return {
    number: raw.number,
    state: raw.state,
    reviewDecision: raw.reviewDecision ?? '',
    // A still-running CheckRun reports conclusion as "" (empty string), not
    // null — discovered live on PR #238, where an in-progress "Integration
    // Tests" run got misread as an actual failure and spuriously triggered
    // fix-e2e. Treat both null and "" as "not concluded yet".
    checksPassing: raw.statusCheckRollup.length > 0 && raw.statusCheckRollup.every((c) => c.conclusion === 'SUCCESS'),
    checksPending: raw.statusCheckRollup.length === 0 || raw.statusCheckRollup.some((c) => !c.conclusion),
    mergeable: raw.mergeable === 'MERGEABLE',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft,
  };
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
  // merges — see docs/superpowers/specs/2026-07-28-stacked-prs-design.md §1)
  // BEFORE deleting the branch. GitHub does NOT auto-retarget dependent PRs
  // when their base branch is deleted, contrary to what this function used
  // to assume — it auto-CLOSES them instead, even with a clean,
  // conflict-free diff. Discovered live: PR #231 got closed this way when
  // PR #230's branch was deleted by an earlier version of this function
  // that passed `--delete-branch` straight to `gh pr merge`, racing
  // GitHub's own (nonexistent) retarget behavior.
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
  // propagate the error, instead of costing a whole retry cycle (or worse,
  // never running the branch delete below) over a response-layer flake.
  for (const dependent of await listOpenPrsWithBase(status.headRefName)) {
    try {
      await ghApi(['api', '--method', 'PATCH', `repos/${config.productRepo}/pulls/${dependent}`, '-f', `base=${status.baseRefName}`]);
    } catch (error) {
      const current = await getPullRequestStatus(dependent);
      if (current.baseRefName !== status.baseRefName) throw error;
    }
  }
  await ghApi(['api', '--method', 'DELETE', `repos/${config.productRepo}/git/refs/heads/${status.headRefName}`]);
}

export function branchPrefix(issueNumber: number): string {
  return `valeria/${issueNumber}/`;
}

// Slice branches are created as `valeria/<issue>/<slice-slug>` (see agent-task.ts),
// so every open PR for an issue's stack is found by branch prefix instead of
// maintaining a separate mapping. Can return more than one now that several
// slices of the same issue can be in flight at once (see
// docs/superpowers/specs/2026-07-28-stacked-prs-design.md).
export async function getOpenPrsForIssue(issueNumber: number): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
  const matches = prs.filter((pr) => pr.headRefName.startsWith(branchPrefix(issueNumber)));
  return Promise.all(matches.map((pr) => getPullRequestStatus(pr.number)));
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

const EVIDENCE_COMMENT_MARKER = '<!-- valeria:e2e-evidence -->';

export async function hasEvidenceComment(prNumber: number): Promise<boolean> {
  const stdout = await gh(['pr', 'view', String(prNumber), '--json', 'comments']);
  const comments = (JSON.parse(stdout) as { comments: Array<{ body: string }> }).comments;
  return comments.some((c) => c.body.includes(EVIDENCE_COMMENT_MARKER));
}

// Never edits an existing comment — gh has no direct "edit PR comment by id"
// and posting fresh is simpler than resolving the REST comment id from gh's
// GraphQL-shaped --json output. Two call sites, with different cadences:
// the automatic slice-publish path in processSlicePr (still gated by
// hasEvidenceComment, checked by that caller — once per PR), and the
// mention-triggered path in tick.ts's mentions block (ungated — a fresh
// comment per publish). See
// docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
export async function postEvidenceComment(prNumber: number, imageUrls: string[]): Promise<void> {
  // Plain links, not `![]()` image embeds: ValerIA (where evidence lives) is
  // a private repo, and GitHub renders embedded images through its Camo
  // proxy, which fetches anonymously and can never authenticate to private
  // raw content — the image just fails to render for every viewer,
  // regardless of their own repo access. A plain link instead sends the
  // viewer's own browser (with their own GitHub session) straight to
  // raw.githubusercontent.com, which works for anyone who already has repo
  // access, same as clicking through to any other private-repo file.
  const body = [
    EVIDENCE_COMMENT_MARKER,
    '## Evidencia e2e (Playwright)',
    ...imageUrls.map((url, i) => `[Screenshot ${i + 1}](${url})`),
  ].join('\n\n');

  const dir = await mkdtemp(join(tmpdir(), 'valeria-evidence-comment-'));
  const bodyFile = join(dir, 'body.md');
  try {
    await writeFile(bodyFile, body, 'utf8');
    await gh(['pr', 'comment', String(prNumber), '--body-file', bodyFile]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SpecPr {
  number: number;
  headRefName: string;
}

// Discovery source of truth: a spec PR is ready for this runner once a
// human has applied `label` (see claim.ts's runnerLabel) AND marked it
// ready for review. Still-draft PRs are excluded on purpose — the human
// can keep iterating on the spec without the agent touching it. Already
// in-progress/done ones are excluded so a spec PR is only ever picked up
// once. See docs/DESIGN.md §1.
export async function listAssignedSpecPrs(label: string): Promise<SpecPr[]> {
  const stdout = await gh([
    'pr', 'list',
    '--label', label,
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

// Discovery source of truth for the bug-intake path: an issue is ready for
// this runner once a human has applied both bmedical's own `bugfix` label
// and this runner's assignment label (see claim.ts's runnerLabel) — no
// draft/ready step like a spec PR has, since a GitHub issue has no draft
// state. Already-managed issues (label `valeria` present) or already in a
// tracked state (ready/in-progress/blocked/done) are excluded so an issue is
// only ever picked up once — mirrors listAssignedSpecPrs's filter above. See
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
export async function listAssignedBugIssues(label: string): Promise<BugIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--label', LABEL_BUG,
    '--label', label,
    '--state', 'open',
    '--json', 'number,title,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  return raw
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_MANAGED))
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_STATES['in-progress'] || l.name === LABEL_STATES.done || l.name === LABEL_STATES.blocked))
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
  const dir = await mkdtemp(join(tmpdir(), 'valeria-spec-pr-comment-'));
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
}

interface RawApiComment {
  id: number;
  body: string;
  reactions: { eyes: number };
  pull_request_review_id?: number | null;
}

function reactionsPath(kind: 'issue' | 'review'): string {
  return kind === 'issue' ? 'issues/comments' : 'pulls/comments';
}

// per_page=100 (the API default is 30): comments come back oldest-first, so
// on a busy PR the newest ones — where a fresh mention lives — would fall on
// a page never fetched, silently. 100 is the API maximum.
export async function listIssueComments(prNumber: number): Promise<Comment[]> {
  const stdout = await ghApi(['api', `repos/${config.productRepo}/issues/${prNumber}/comments?per_page=100`]);
  const raw = JSON.parse(stdout) as RawApiComment[];
  return raw.map((c) => ({ id: c.id, kind: 'issue' as const, body: c.body, reactionsEyes: c.reactions.eyes }));
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
    ghApi(['api', `repos/${config.productRepo}/pulls/${prNumber}/comments?per_page=100`]),
    ghApi(['api', `repos/${config.productRepo}/pulls/${prNumber}/reviews?per_page=100`]),
  ]);
  const rawComments = JSON.parse(commentsStdout) as RawApiComment[];
  const rawReviews = JSON.parse(reviewsStdout) as RawReview[];
  const pendingReviewIds = new Set(rawReviews.filter((r) => r.state === 'PENDING').map((r) => r.id));

  return rawComments
    .filter((c) => !(c.pull_request_review_id != null && pendingReviewIds.has(c.pull_request_review_id)))
    .map((c) => ({ id: c.id, kind: 'review' as const, body: c.body, reactionsEyes: c.reactions.eyes }));
}

export async function hasBotReaction(commentId: number, kind: 'issue' | 'review', botLogin: string): Promise<boolean> {
  const stdout = await ghApi([
    'api',
    `repos/${config.productRepo}/${reactionsPath(kind)}/${commentId}/reactions?content=eyes&per_page=100`,
  ]);
  const raw = JSON.parse(stdout) as Array<{ user: { login: string } }>;
  return raw.some((r) => r.user.login === botLogin);
}

export async function addReaction(commentId: number, kind: 'issue' | 'review', content: 'eyes'): Promise<void> {
  await ghApi([
    'api',
    `repos/${config.productRepo}/${reactionsPath(kind)}/${commentId}/reactions`,
    '-f',
    `content=${content}`,
  ]);
}
