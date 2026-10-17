import type { RepoEntry } from './repo-context.js';

// Linear's API (#101, entrega 2): projects and cycles, read with the
// workspace's API key. Opt-in per repo (`"linear": { "apiKeyEnv": "…" }` in
// repos.json, the key itself in .env); a repo without it, or whose key is
// missing, reads nothing and everything works as before. GitHub stays the
// source of truth: a Linear issue is matched to its GitHub issue by the
// attachment the sync leaves on it (the GitHub issue's URL).

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 15_000;

export function linearKey(entry: RepoEntry): string | null {
  const name = entry.linear?.apiKeyEnv;
  return (name && process.env[name]) || null;
}

async function query<T>(key: string, text: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`Linear respondió ${res.status}: ${body.errors?.[0]?.message ?? res.statusText}`);
  return body.data;
}

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface LinearIssue {
  // The identifier people use ("RED-214").
  id: string;
  // Linear's own id, for writing to it.
  uuid?: string;
  title: string;
  url: string;
  state: { name: string; type: LinearStateType };
  project?: { id: string; name: string };
  assignee?: string;
  // The GitHub issue it syncs with, in this repo.
  githubNumber?: number;
  cycle?: { number: number; name?: string; current: boolean };
}

export interface LinearCycle {
  team: string;
  number: number;
  name?: string;
  startsAt: string;
  endsAt: string;
  // Issues in the cycle and how many of them were done, one value per day
  // since it started (Linear's own history, the one its cycle graph uses).
  scopeHistory: number[];
  doneHistory: number[];
  issues: LinearIssue[];
}

interface RawIssue {
  id?: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: LinearStateType };
  project: { id: string; name: string } | null;
  assignee?: { displayName: string } | null;
  cycle?: { number: number; name: string | null; isActive: boolean } | null;
  attachments: { nodes: Array<{ url: string }> };
}

const ISSUE_FIELDS = 'identifier title url state { name type } project { id name } assignee { displayName }';
const issuesPrefix = (entry: RepoEntry) => `https://github.com/${entry.productRepo}/issues/`;

function toIssue(raw: RawIssue, prefix: string): LinearIssue {
  const github = raw.attachments.nodes.map((a) => a.url).find((url) => url.startsWith(prefix));
  const number = github ? Number(/^(\d+)/.exec(github.slice(prefix.length))?.[1]) : NaN;
  return {
    id: raw.identifier,
    ...(raw.id ? { uuid: raw.id } : {}),
    title: raw.title,
    url: raw.url,
    state: raw.state,
    ...(raw.project ? { project: raw.project } : {}),
    ...(raw.assignee ? { assignee: raw.assignee.displayName } : {}),
    ...(Number.isInteger(number) ? { githubNumber: number } : {}),
    ...(raw.cycle ? { cycle: { number: raw.cycle.number, ...(raw.cycle.name ? { name: raw.cycle.name } : {}), current: raw.cycle.isActive } } : {}),
  };
}

const BY_URL_QUERY = `query($urls: [String!], $prefix: String!) {
  issues(first: 100, filter: { attachments: { some: { url: { in: $urls } } } }) {
    nodes { id ${ISSUE_FIELDS} cycle { number name isActive } attachments(first: 3, filter: { url: { startsWith: $prefix } }) { nodes { url } } }
  }
}`;

// The Linear issue of each of these GitHub issues that has one, by number.
export async function linearIssuesFor(entry: RepoEntry, key: string, numbers: number[]): Promise<Map<number, LinearIssue>> {
  const prefix = issuesPrefix(entry);
  const found = new Map<number, LinearIssue>();
  for (let i = 0; i < numbers.length; i += 100) {
    const urls = numbers.slice(i, i + 100).map((n) => `${prefix}${n}`);
    const data = await query<{ issues: { nodes: RawIssue[] } }>(key, BY_URL_QUERY, { urls, prefix });
    for (const raw of data.issues.nodes) {
      const issue = toIssue(raw, prefix);
      if (issue.githubNumber !== undefined) found.set(issue.githubNumber, issue);
    }
  }
  return found;
}

// The team is the one this repo's issues sync with: any issue linked to the
// repo says which, so repos.json doesn't need to.
const CYCLE_QUERY = `query($prefix: String!) {
  issues(first: 1, filter: { attachments: { some: { url: { startsWith: $prefix } } } }) {
    nodes { team { key activeCycle {
      number name startsAt endsAt issueCountHistory completedIssueCountHistory
      issues(first: 250, filter: { state: { type: { neq: "canceled" } } }) {
        nodes { ${ISSUE_FIELDS} attachments(first: 3, filter: { url: { startsWith: $prefix } }) { nodes { url } } }
      }
    } } }
  }
}`;

interface RawCycle {
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  issues: { nodes: RawIssue[] };
}

// The current cycle of the repo's team, or null when it has none running
// (or no issue of the repo is in Linear yet).
export async function currentCycle(entry: RepoEntry, key: string): Promise<LinearCycle | null> {
  const prefix = issuesPrefix(entry);
  const data = await query<{ issues: { nodes: Array<{ team: { key: string; activeCycle: RawCycle | null } }> } }>(key, CYCLE_QUERY, { prefix });
  const team = data.issues.nodes[0]?.team;
  const cycle = team?.activeCycle;
  if (!team || !cycle) return null;
  return {
    team: team.key,
    number: cycle.number,
    ...(cycle.name ? { name: cycle.name } : {}),
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    scopeHistory: cycle.issueCountHistory,
    doneHistory: cycle.completedIssueCountHistory,
    issues: cycle.issues.nodes.map((raw) => ({ ...toIssue(raw, prefix), cycle: { number: cycle.number, ...(cycle.name ? { name: cycle.name } : {}), current: true } })),
  };
}

// What a new issue can be put in (#101, entrega 3): the team's projects that
// are still going and its cycles that haven't ended, current one first.
export interface LinearPlanning {
  projects: Array<{ id: string; name: string }>;
  cycles: Array<{ id: string; number: number; name?: string; startsAt: string; endsAt: string; current: boolean }>;
}

const PLANNING_QUERY = `query($prefix: String!) {
  issues(first: 1, filter: { attachments: { some: { url: { startsWith: $prefix } } } }) {
    nodes { team {
      projects(first: 100, filter: { state: { nin: ["completed", "canceled"] } }) { nodes { id name } }
      cycles(first: 4, filter: { isPast: { eq: false } }, orderBy: createdAt) { nodes { id number name startsAt endsAt isActive } }
    } }
  }
}`;

export async function teamPlanning(entry: RepoEntry, key: string): Promise<LinearPlanning | null> {
  type Raw = { issues: { nodes: Array<{ team: { projects: { nodes: Array<{ id: string; name: string }> }; cycles: { nodes: Array<{ id: string; number: number; name: string | null; startsAt: string; endsAt: string; isActive: boolean }> } } }> } };
  const data = await query<Raw>(key, PLANNING_QUERY, { prefix: issuesPrefix(entry) });
  const team = data.issues.nodes[0]?.team;
  if (!team) return null;
  return {
    projects: [...team.projects.nodes].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    cycles: team.cycles.nodes
      .map((c) => ({ id: c.id, number: c.number, ...(c.name ? { name: c.name } : {}), startsAt: c.startsAt, endsAt: c.endsAt, current: c.isActive }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  };
}

const PROJECT_QUERY = `query($name: String!) { projects(first: 2, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } } }`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A project named in repos.json, by its id or its name; null if there's no
// such project (or the name matches more than one).
export async function resolveProject(key: string, nameOrId: string): Promise<string | null> {
  if (UUID.test(nameOrId)) return nameOrId;
  const data = await query<{ projects: { nodes: Array<{ id: string }> } }>(key, PROJECT_QUERY, { name: nameOrId });
  return data.projects.nodes.length === 1 ? data.projects.nodes[0].id : null;
}

const UPDATE_MUTATION = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

// Puts a Linear issue in a project and/or a cycle.
export async function updateIssue(key: string, uuid: string, input: { projectId?: string; cycleId?: string }): Promise<void> {
  const data = await query<{ issueUpdate: { success: boolean } }>(key, UPDATE_MUTATION, { id: uuid, input });
  if (!data.issueUpdate.success) throw new Error('Linear no aplicó el cambio');
}

