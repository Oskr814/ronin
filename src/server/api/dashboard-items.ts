import type { GithubState, OpenPr } from '../../core/github.js';
import type { LinearIssue } from '../../core/linear-api.js';
import type { BlockRecord } from '../../core/local-state.js';
import { itemKey, type RunState, type RunSummary } from './dashboard-data.js';
import type { PreviewView, RepoGithub } from './dashboard-github.js';

// The dashboard's sidebar (#65, #100): every open issue of each repo, put
// together from GitHub (the issues, ronin's slices, the open PRs and the
// issue each one belongs to) and from this runner's own runs. A PR lives
// inside its issue, and a run on it counts as the issue's. Listed without
// searching: ronin's issues, the ones it worked on in the last days and the
// exploration PR; the rest of the open issues are found by searching. A run
// on something that's no issue (a PR without one, a changelog entry) is an
// item too, shown only while it runs and in Hoy.

// 'open': an issue nobody is on.
export type ItemStatus = 'running' | 'blocked' | 'waiting' | 'open' | RunState;

export interface CheckView {
  name: string;
  outcome: 'passed' | 'pending' | 'failed';
}

export interface SliceView {
  index: number;
  title: string;
  prNumber: number | null;
  status: 'merged' | 'open' | 'pending' | 'closed';
  // Its PR is open as a draft.
  draft?: boolean;
  checks?: 'passed' | 'pending' | 'failed' | 'none';
  reviewDecision?: OpenPr['reviewDecision'];
}

export interface PrView {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  reviewDecision: OpenPr['reviewDecision'];
  checks: CheckView[];
}

export interface Item {
  id: string;
  repo: string;
  number?: number;
  kind: 'issue' | 'pr' | 'other';
  title: string;
  url?: string;
  status: ItemStatus;
  // How it stands on GitHub, drawn with GitHub's icon (#129); unknown for an
  // old closed one, or what's no issue nor PR.
  github?: GithubState;
  // What it's waiting for, when no agent is on it.
  note?: string;
  lastRun?: RunSummary;
  runs: number;
  slices?: SliceView[];
  // The PR that's moving: a PR item's own, or an issue's lowest open slice PR.
  pr?: PrView;
  preview?: PreviewView;
  block?: BlockRecord;
  // Shown in the sidebar without searching.
  listed: boolean;
  // The exploration PR, fixed on top of its repo.
  pinned?: boolean;
  // Every open PR of the issue, to find it by a PR's number.
  prs?: number[];
  // Its Linear issue, for a repo with a Linear key (added by the snapshot, #101).
  linear?: LinearIssue;
}

function checksOf(pr: OpenPr): SliceView['checks'] {
  if (pr.checks.length === 0) return 'none';
  if (pr.checks.some((c) => c.outcome === 'failed')) return 'failed';
  if (pr.checks.some((c) => c.outcome === 'pending')) return 'pending';
  return 'passed';
}

function prView(pr: OpenPr): PrView {
  return { number: pr.number, title: pr.title, url: pr.url, author: pr.author, isDraft: pr.isDraft, reviewDecision: pr.reviewDecision, checks: pr.checks };
}

// What an open PR waits for, in the words of someone looking at it.
export function prNote(pr: OpenPr): string {
  const checks = checksOf(pr);
  if (pr.mergeable === 'CONFLICTING') return `conflictos en #${pr.number}`;
  if (checks === 'failed') return `checks fallando en #${pr.number}`;
  if (checks === 'pending') return `checks corriendo en #${pr.number}`;
  if (pr.reviewDecision === 'APPROVED') return `aprobado, falta el merge de #${pr.number}`;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return `cambios pedidos en #${pr.number}`;
  if (pr.isDraft) return `#${pr.number} en draft`;
  return `esperando review en #${pr.number}`;
}

function byKey(runs: RunSummary[]): Map<string, RunSummary[]> {
  const map = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = itemKey(run);
    map.set(key, [...(map.get(key) ?? []), run]);
  }
  return map;
}

// The run keys that belong to an issue: its own, and those of its slices'
// PRs. A run on a slice PR alone (/resolve-conflicts, a preview's data) is
// keyed by the PR, but it's work on the issue: it shows there, not as an
// item of its own (#85).
export function issueRunKeys(repo: string, issue: { number: number; slices: Array<{ prNumber: number | null }> }): string[] {
  return [`${repo}#${issue.number}`, ...issue.slices.flatMap((s) => (s.prNumber !== null ? [`${repo}#${s.prNumber}`] : []))];
}

// The PRs of an issue, by the links the repo read made (linkPrs).
function linkedPrs(gh: RepoGithub, issue: number): number[] {
  return Object.entries(gh.prIssue).filter(([, n]) => n === issue).map(([pr]) => Number(pr));
}

// The run keys an item's history is made of: an open issue's (issueRunKeys
// plus its PRs') when GitHub lists it, otherwise just its own.
export function itemRunKeys(id: string, gh: RepoGithub | undefined): string[] {
  const number = Number(/#(\d+)$/.exec(id)?.[1] ?? NaN);
  if (!gh || `${gh.repo}#${number}` !== id) return [id];
  const own = gh.issues.find((i) => i.number === number);
  if (!own && !gh.openIssues.some((i) => i.number === number)) return [id];
  return [...new Set([...issueRunKeys(gh.repo, { number, slices: own?.slices ?? [] }), ...linkedPrs(gh, number).map((pr) => `${gh.repo}#${pr}`)])];
}

const newestFirst = (a: RunSummary, b: RunSummary) => b.startedAt.localeCompare(a.startedAt);

function runStatus(runs: RunSummary[]): RunState {
  return runs.some((run) => run.state === 'running') ? 'running' : runs[0].state;
}

// `runs`: newest first (listRuns). `github`: one per repo, or missing for a
// repo GitHub couldn't be read for — its runs still show.
export function buildItems(repos: string[], runs: RunSummary[], github: Array<RepoGithub | undefined>): Item[] {
  const runsByKey = byKey(runs);
  const items: Item[] = [];
  const seen = new Set<string>();

  for (const [i, repo] of repos.entries()) {
    const gh = github[i];
    if (!gh) continue;
    const prs = new Map(gh.prs.map((pr) => [pr.number, pr]));
    const previewFor = (numbers: number[]) => gh.previews.find((p) => numbers.includes(p.prNumber));

    const managed = new Map(gh.issues.map((issue) => [issue.number, issue]));
    const issues = [...gh.issues, ...gh.openIssues.filter((issue) => !managed.has(issue.number))];
    for (const issue of issues) {
      const own = managed.get(issue.number);
      const tracked = own !== undefined && own.status !== 'other';
      const id = `${repo}#${issue.number}`;
      const linked = linkedPrs(gh, issue.number);
      const keys = [...new Set([...issueRunKeys(repo, { number: issue.number, slices: own?.slices ?? [] }), ...linked.map((n) => `${repo}#${n}`)])];
      for (const key of keys) seen.add(key);
      const itemRuns = keys.flatMap((key) => runsByKey.get(key) ?? []).sort(newestFirst);
      const slices: SliceView[] = (own?.slices ?? []).map((slice) => {
        const open = slice.prNumber !== null ? prs.get(slice.prNumber) : undefined;
        return {
          index: slice.index,
          title: slice.title,
          prNumber: slice.prNumber,
          status: slice.checked ? 'merged' : open ? 'open' : slice.prNumber !== null ? 'closed' : 'pending',
          ...(open ? { checks: checksOf(open), reviewDecision: open.reviewDecision, ...(open.isDraft ? { draft: true } : {}) } : {}),
        };
      });
      const moving = slices.find((s) => s.status === 'open');
      // A ronin issue's lowest open slice; anyone else's issue, its first open PR.
      const movingPr = moving?.prNumber != null ? prs.get(moving.prNumber) : own ? undefined : linked.map((n) => prs.get(n)).find(Boolean);
      const running = itemRuns.some((run) => run.state === 'running');
      const blocked = own?.status === 'blocked';
      const nextSlice = slices.find((s) => s.status === 'pending');
      const preview = previewFor([...slices.flatMap((s) => (s.prNumber !== null ? [s.prNumber] : [])), ...linked]);
      let note: string | undefined;
      if (!running && !blocked) {
        if (tracked) note = movingPr ? prNote(movingPr) : nextSlice ? `por arrancar la slice ${nextSlice.index + 1}` : 'en curso';
        else if (movingPr) note = prNote(movingPr);
      }
      items.push({
        id,
        repo,
        number: issue.number,
        kind: 'issue',
        title: issue.title,
        url: issue.url,
        github: 'open',
        status: running ? 'running' : blocked ? 'blocked' : tracked || movingPr ? 'waiting' : itemRuns[0]?.state ?? 'open',
        ...(note ? { note } : {}),
        ...(itemRuns[0] ? { lastRun: itemRuns[0] } : {}),
        runs: itemRuns.length,
        ...(slices.length ? { slices } : {}),
        ...(movingPr ? { pr: prView(movingPr) } : {}),
        ...(preview ? { preview } : {}),
        ...(blocked && gh.blocks[issue.number] ? { block: gh.blocks[issue.number] } : {}),
        listed: own !== undefined || itemRuns.length > 0,
        ...(linked.length ? { prs: linked } : {}),
      });
    }

    // ronin's rolling exploration PR, whether or not it ran lately.
    for (const pr of gh.prs) {
      if (!pr.headRefName.startsWith('ronin/exploration/')) continue;
      const id = `${repo}#${pr.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const itemRuns = runsByKey.get(id) ?? [];
      items.push({
        id, repo, number: pr.number, kind: 'pr', title: pr.title, url: pr.url,
        github: pr.isDraft ? 'draft' : 'open',
        status: itemRuns.length ? runStatus(itemRuns) : 'waiting',
        note: 'PR de exploración abierto',
        ...(itemRuns[0] ? { lastRun: itemRuns[0] } : {}),
        runs: itemRuns.length,
        pr: prView(pr),
        listed: true,
        pinned: true,
      });
    }
  }

  // Everything else that ran lately: a human's PR it reviewed, an issue it
  // answered, a changelog entry, an issue that has since closed.
  for (const [id, itemRuns] of runsByKey) {
    if (seen.has(id)) continue;
    const last = itemRuns[0];
    const number = last.issueNumber ?? last.prNumber;
    const repoIndex = repos.indexOf(last.repo);
    const open = number !== undefined && repoIndex >= 0 ? github[repoIndex]?.prs.find((pr) => pr.number === number) : undefined;
    const preview = number !== undefined && repoIndex >= 0 ? github[repoIndex]?.previews.find((p) => p.prNumber === number) : undefined;
    const state: GithubState | undefined = open ? (open.isDraft ? 'draft' : 'open') : number !== undefined && repoIndex >= 0 ? github[repoIndex]?.closed?.[number] : undefined;
    items.push({
      id,
      repo: last.repo,
      ...(number !== undefined ? { number } : {}),
      kind: last.issueNumber !== undefined ? 'issue' : last.prNumber !== undefined ? 'pr' : 'other',
      title: open?.title ?? last.sliceTitle ?? (last.issueNumber !== undefined ? `Issue #${last.issueNumber}` : last.prNumber !== undefined ? `PR #${last.prNumber}` : last.label),
      ...(open ? { url: open.url, pr: prView(open) } : {}),
      ...(state ? { github: state } : {}),
      status: runStatus(itemRuns),
      lastRun: last,
      runs: itemRuns.length,
      ...(preview ? { preview } : {}),
      // An issue ronin worked on lately is listed while it's still pending
      // work: not once GitHub says it closed (completed or not planned), which
      // shows only while it's the one open, or found by searching. One whose
      // state is unknown (a repo GitHub couldn't be read for) stays listed. A
      // PR without an issue or a changelog entry only shows while it runs and
      // in Hoy.
      listed: last.issueNumber !== undefined && state !== 'completed' && state !== 'not_planned',
    });
  }

  // A fixed order, the newest issue or PR first: one doesn't jump to the top
  // of the sidebar because a run started on it (a preview's data, a
  // review) — its dot says it's running. What has no number (a changelog
  // entry) goes last, the latest first.
  const activity = (item: Item) => item.lastRun?.endedAt ?? item.lastRun?.startedAt ?? '';
  return items.sort((a, b) => (b.number ?? -1) - (a.number ?? -1) || activity(b).localeCompare(activity(a)));
}
