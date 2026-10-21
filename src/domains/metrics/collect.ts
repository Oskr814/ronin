import { join } from 'node:path';
import { config } from '../../core/config.js';
import { ghGraphql } from '../../core/github.js';
import { readJson, writeJson } from '../portal/json-store.js';

// What Métricas reads from GitHub (#222), per repo: issues and PRs with what
// their times come from (when they closed and how, who they're assigned to,
// the review requests and reviews, the labels ronin put on them) and the
// releases. Kept in METRICS_DATA_DIR so each read only asks for what changed
// since the last one, by updatedAt; the first one brings HISTORY_DAYS back,
// and every open issue and PR however old.

export interface MIssue {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  // How it closed; null while open. A duplicate counts as not planned.
  reason: 'completed' | 'not_planned' | null;
  assignees: string[];
  labels: string[];
  reopenedAt: string[];
  // Each time ronin:blocked was put on it.
  blockedAt: string[];
}

export interface MPr {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  draft: boolean;
  // The last time it left draft: a review asked of a draft waits for this.
  readyAt: string | null;
  requests: Array<{ reviewer: string; at: string }>;
  reviews: Array<{ author: string; state: string; at: string }>;
  // How many ronin:attempts-<n> labels it got: fix attempts, by review or CI.
  attempts: number;
  closes: number[];
}

export interface MRelease {
  tag: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface RepoData {
  repo: string;
  syncedAt: string;
  issues: Record<string, MIssue>;
  prs: Record<string, MPr>;
  releases: MRelease[];
}

export const HISTORY_DAYS = 180;
// Read again from a little before the last read: an item updated while it
// was going could have come in a page already read.
const OVERLAP_MS = 5 * 60_000;
// A guard against a loop, not a limit anyone should reach: 200 pages are
// 10 000 issues.
const MAX_PAGES = 200;
const DAY = 86_400_000;

type Graphql = typeof ghGraphql;

interface Page<T> {
  data: { repository: Record<string, { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> };
}

const issuesQuery = (states: string) => `
query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $after, states: ${states}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title createdAt updatedAt closedAt stateReason
        author { login }
        assignees(first: 10) { nodes { login } }
        labels(first: 30) { nodes { name } }
        timelineItems(first: 100, itemTypes: [REOPENED_EVENT, LABELED_EVENT]) {
          nodes { __typename ... on ReopenedEvent { createdAt } ... on LabeledEvent { createdAt label { name } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const prsQuery = (states: string) => `
query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 40, after: $after, states: ${states}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title createdAt updatedAt mergedAt closedAt isDraft
        author { login }
        closingIssuesReferences(first: 5) { nodes { number } }
        reviews(first: 50) { nodes { author { login } state submittedAt } }
        timelineItems(first: 100, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, LABELED_EVENT]) {
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
            ... on ReadyForReviewEvent { createdAt }
            ... on LabeledEvent { createdAt label { name } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const RELEASES_QUERY = `
query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    releases(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { tagName createdAt publishedAt isPrerelease isDraft }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface RawEvent { __typename: string; createdAt?: string; label?: { name: string }; requestedReviewer?: { login?: string } | null }
export interface RawIssue {
  number: number; title: string; createdAt: string; updatedAt: string; closedAt: string | null; stateReason: string | null;
  author: { login: string } | null;
  assignees: { nodes: Array<{ login: string }> };
  labels: { nodes: Array<{ name: string }> };
  timelineItems: { nodes: RawEvent[] };
}
export interface RawPr {
  number: number; title: string; createdAt: string; updatedAt: string; mergedAt: string | null; closedAt: string | null; isDraft: boolean;
  author: { login: string } | null;
  closingIssuesReferences: { nodes: Array<{ number: number }> };
  reviews: { nodes: Array<{ author: { login: string } | null; state: string; submittedAt: string | null }> };
  timelineItems: { nodes: RawEvent[] };
}

const BLOCKED_LABEL = 'ronin:blocked';
const ATTEMPTS_LABEL = /^ronin:attempts-\d+$/;

export function toIssue(raw: RawIssue): MIssue {
  const events = raw.timelineItems.nodes;
  return {
    number: raw.number,
    title: raw.title,
    author: raw.author?.login ?? '',
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: raw.closedAt,
    reason: raw.closedAt ? (raw.stateReason === 'NOT_PLANNED' || raw.stateReason === 'DUPLICATE' ? 'not_planned' : 'completed') : null,
    assignees: raw.assignees.nodes.map((a) => a.login),
    labels: raw.labels.nodes.map((l) => l.name),
    reopenedAt: events.filter((e) => e.__typename === 'ReopenedEvent' && e.createdAt).map((e) => e.createdAt!),
    blockedAt: events.filter((e) => e.__typename === 'LabeledEvent' && e.label?.name === BLOCKED_LABEL && e.createdAt).map((e) => e.createdAt!),
  };
}

export function toPr(raw: RawPr): MPr {
  const events = raw.timelineItems.nodes;
  const ready = events.filter((e) => e.__typename === 'ReadyForReviewEvent' && e.createdAt).map((e) => e.createdAt!);
  return {
    number: raw.number,
    title: raw.title,
    author: raw.author?.login ?? '',
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    draft: raw.isDraft,
    readyAt: ready.length ? ready[ready.length - 1] : null,
    // A team asked for review has no login: only people count.
    requests: events.filter((e) => e.__typename === 'ReviewRequestedEvent' && e.requestedReviewer?.login && e.createdAt).map((e) => ({ reviewer: e.requestedReviewer!.login!, at: e.createdAt! })),
    // A pending review (not submitted yet) has no date.
    reviews: raw.reviews.nodes.filter((r) => r.submittedAt).map((r) => ({ author: r.author?.login ?? '', state: r.state, at: r.submittedAt! })),
    attempts: events.filter((e) => e.__typename === 'LabeledEvent' && ATTEMPTS_LABEL.test(e.label?.name ?? '')).length,
    closes: raw.closingIssuesReferences.nodes.map((i) => i.number),
  };
}

// Pages newest-updated first until one older than `since` (epoch ms).
async function pages<T extends { updatedAt: string }>(graphql: Graphql, query: string, field: string, owner: string, repo: string, since: number): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await graphql<Page<T>>(query, { owner, repo, after });
    const { nodes, pageInfo } = raw.data.repository[field];
    const fresh = nodes.filter((n) => Date.parse(n.updatedAt) >= since);
    out.push(...fresh);
    if (fresh.length < nodes.length || !pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return out;
}

// Every published release of the last `since` (epoch ms), read whole each
// time: there are few, and one can be edited or deleted.
async function releases(graphql: Graphql, owner: string, repo: string, since: number): Promise<MRelease[]> {
  type Raw = { tagName: string; createdAt: string; publishedAt: string | null; isPrerelease: boolean; isDraft: boolean };
  const out: MRelease[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await graphql<Page<Raw>>(RELEASES_QUERY, { owner, repo, after });
    const { nodes, pageInfo } = raw.data.repository.releases;
    out.push(...nodes.filter((r) => !r.isDraft && r.publishedAt).map((r) => ({ tag: r.tagName, publishedAt: r.publishedAt!, prerelease: r.isPrerelease })));
    if (nodes.some((r) => Date.parse(r.createdAt) < since) || !pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return out;
}

const filePath = (repo: string) => join(config.metrics.dataDir, 'repos', `${repo.replace('/', '__')}.json`);

export function readRepoData(repo: string): Promise<RepoData | null> {
  return readJson<RepoData | null>(filePath(repo), () => null);
}

// Brings the repo's file up to date with GitHub and returns it.
export async function syncRepo(repo: string, now = Date.now(), graphql: Graphql = ghGraphql): Promise<RepoData> {
  const [owner, name] = repo.split('/');
  const previous = await readRepoData(repo);
  const since = previous ? Date.parse(previous.syncedAt) - OVERLAP_MS : now - HISTORY_DAYS * DAY;
  const data: RepoData = previous ?? { repo, syncedAt: '', issues: {}, prs: {}, releases: [] };

  const reads: Array<Promise<void>> = [
    pages<RawIssue>(graphql, issuesQuery('[OPEN, CLOSED]'), 'issues', owner, name, since).then((list) => { for (const raw of list) data.issues[raw.number] = toIssue(raw); }),
    pages<RawPr>(graphql, prsQuery('[OPEN, CLOSED, MERGED]'), 'pullRequests', owner, name, since).then((list) => { for (const raw of list) data.prs[raw.number] = toPr(raw); }),
    releases(graphql, owner, name, now - HISTORY_DAYS * DAY).then((list) => { data.releases = list; }),
  ];
  // The first read: what's open, however long ago it last moved.
  if (!previous) {
    reads.push(
      pages<RawIssue>(graphql, issuesQuery('[OPEN]'), 'issues', owner, name, 0).then((list) => { for (const raw of list) data.issues[raw.number] ??= toIssue(raw); }),
      pages<RawPr>(graphql, prsQuery('[OPEN]'), 'pullRequests', owner, name, 0).then((list) => { for (const raw of list) data.prs[raw.number] ??= toPr(raw); }),
    );
  }
  await Promise.all(reads);
  data.syncedAt = new Date(now).toISOString();
  await writeJson(filePath(repo), data);
  return data;
}
