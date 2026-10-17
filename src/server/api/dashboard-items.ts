import type { OpenPr } from '../../core/github.js';
import type { LinearIssue } from '../../core/linear-api.js';
import type { BlockRecord } from '../../core/local-state.js';
import { itemKey, type RunState, type RunSummary } from './dashboard-data.js';
import type { PreviewView, RepoGithub } from './dashboard-github.js';

// The dashboard's sidebar (#65): what ronin has going in each repo, put
// together from GitHub (the issues it manages, their slices, the open PRs)
// and from this runner's own runs. An issue ronin manages shows up whether
// or not an agent ran on it lately; a run about anything else (a human's PR
// it reviewed, a changelog entry) shows up for as long as it's recent.

export type ItemStatus = 'running' | 'blocked' | 'waiting' | RunState;

export interface CheckView {
  name: string;
  outcome: 'passed' | 'pending' | 'failed';
}

export interface SliceView {
  index: number;
  title: string;
  prNumber: number | null;
  status: 'merged' | 'open' | 'pending' | 'closed';
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
  // What it's waiting for, when no agent is on it.
  note?: string;
  lastRun?: RunSummary;
  runs: number;
  slices?: SliceView[];
  // The PR that's moving: a PR item's own, or an issue's lowest open slice PR.
  pr?: PrView;
  preview?: PreviewView;
  block?: BlockRecord;
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

// The run keys an item's history is made of: an issue's (issueRunKeys) when
// GitHub lists it, otherwise just its own.
export function itemRunKeys(id: string, gh: RepoGithub | undefined): string[] {
  const number = Number(/#(\d+)$/.exec(id)?.[1] ?? NaN);
  const issue = gh?.issues.find((i) => i.number === number && i.status !== 'other');
  return issue && `${gh!.repo}#${issue.number}` === id ? issueRunKeys(gh!.repo, issue) : [id];
}

const newestFirst = (a: RunSummary, b: RunSummary) => b.startedAt.localeCompare(a.startedAt);

function runStatus(runs: RunSummary[]): RunState {
  return runs.some((run) => run.state === 'running') ? 'running' : runs[0].state;
}

const ORDER: Record<string, number> = { running: 0, blocked: 1, waiting: 2 };

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

    for (const issue of gh.issues) {
      if (issue.status === 'other') continue;
      const id = `${repo}#${issue.number}`;
      const keys = issueRunKeys(repo, issue);
      for (const key of keys) seen.add(key);
      const itemRuns = keys.flatMap((key) => runsByKey.get(key) ?? []).sort(newestFirst);
      const slices: SliceView[] = issue.slices.map((slice) => {
        const open = slice.prNumber !== null ? prs.get(slice.prNumber) : undefined;
        return {
          index: slice.index,
          title: slice.title,
          prNumber: slice.prNumber,
          status: slice.checked ? 'merged' : open ? 'open' : slice.prNumber !== null ? 'closed' : 'pending',
          ...(open ? { checks: checksOf(open), reviewDecision: open.reviewDecision } : {}),
        };
      });
      const moving = slices.find((s) => s.status === 'open');
      const movingPr = moving?.prNumber != null ? prs.get(moving.prNumber) : undefined;
      const running = itemRuns.some((run) => run.state === 'running');
      const blocked = issue.status === 'blocked';
      const nextSlice = slices.find((s) => s.status === 'pending');
      const preview = previewFor(slices.flatMap((s) => (s.prNumber !== null ? [s.prNumber] : [])));
      items.push({
        id,
        repo,
        number: issue.number,
        kind: 'issue',
        title: issue.title,
        url: issue.url,
        status: running ? 'running' : blocked ? 'blocked' : 'waiting',
        ...(!running && !blocked ? { note: movingPr ? prNote(movingPr) : nextSlice ? `por arrancar la slice ${nextSlice.index + 1}` : 'en curso' } : {}),
        ...(itemRuns[0] ? { lastRun: itemRuns[0] } : {}),
        runs: itemRuns.length,
        slices,
        ...(movingPr ? { pr: prView(movingPr) } : {}),
        ...(preview ? { preview } : {}),
        ...(blocked && gh.blocks[issue.number] ? { block: gh.blocks[issue.number] } : {}),
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
        status: itemRuns.length ? runStatus(itemRuns) : 'waiting',
        note: 'PR de exploración abierto',
        ...(itemRuns[0] ? { lastRun: itemRuns[0] } : {}),
        runs: itemRuns.length,
        pr: prView(pr),
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
    items.push({
      id,
      repo: last.repo,
      ...(number !== undefined ? { number } : {}),
      kind: last.issueNumber !== undefined ? 'issue' : last.prNumber !== undefined ? 'pr' : 'other',
      title: open?.title ?? last.sliceTitle ?? (last.issueNumber !== undefined ? `Issue #${last.issueNumber}` : last.prNumber !== undefined ? `PR #${last.prNumber}` : last.label),
      ...(open ? { url: open.url, pr: prView(open) } : {}),
      status: runStatus(itemRuns),
      lastRun: last,
      runs: itemRuns.length,
      ...(preview ? { preview } : {}),
    });
  }

  const activity = (item: Item) => item.lastRun?.endedAt ?? item.lastRun?.startedAt ?? '';
  return items.sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || activity(b).localeCompare(activity(a)));
}
