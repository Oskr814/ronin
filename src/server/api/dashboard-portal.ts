import { readFile } from 'node:fs/promises';
import type { RepoEntry } from '../../core/repo-context.js';
import type { PortalUser } from '../../portal/accounts.js';
import { prototypePatchPath, requestImagePath, type PortalMessage, type PortalRequest, type RequestEvent, type Verdict } from '../../portal/requests.js';
import type { RunSummary } from './dashboard-data.js';

// The request portal's requests on the dashboard (#132): every one of the
// repos the session sees, for anyone who sees them (the accounts stay the
// admins', portal-admin.ts). A request has no issue until ronin opens one,
// so its page is its own: the conversation, what ronin did with it (its
// events and its runs) and, once it has them, its issue's and PR's runs.

// Who it waits on now: the person (to answer or decide), ronin (reading it,
// drawing a prototype, reproducing an error, opening its issue, making the
// change) or the dev
// team (its issue, or approving the PR). Null: nobody — closed, or ronin
// answered and the person may write again if they want.
export type WaitsOn = 'person' | 'ronin' | 'team' | null;

export function waitsOn(r: Pick<PortalRequest, 'status' | 'issue' | 'pr'>): WaitsOn {
  switch (r.status) {
    case 'thinking':
    case 'minor':
    case 'reproducing':
      return 'ronin';
    case 'asking':
    case 'proposed':
      return 'person';
    case 'approved':
    case 'fixing':
      return r.pr ? 'team' : 'ronin';
    case 'big':
      return r.issue ? 'team' : 'ronin';
    default:
      return null;
  }
}

export const isOpen = (r: Pick<PortalRequest, 'status'>) => !['done', 'resolved', 'declined', 'cancelled'].includes(r.status);

// The runs that were about it: its own (portal-request, portal-prototype,
// portal-reproduce)
// and, once it has them, its issue's and its PR's.
export function requestRuns(r: Pick<PortalRequest, 'number' | 'repo' | 'issue' | 'pr'>, runs: RunSummary[]): RunSummary[] {
  return runs.filter((run) => run.repo === r.repo && (run.portalRequest === r.number
    || (r.issue && run.issueNumber === r.issue.number)
    || (r.pr && (run.prNumber === r.pr || run.issueNumber === r.pr))));
}

const appName = (entries: RepoEntry[], r: PortalRequest) => entries.find((e) => e.productRepo === r.repo)?.portal?.apps[r.app]?.name ?? r.app;
const lastAt = (r: PortalRequest, runs: RunSummary[]) => [r.updatedAt, ...runs.map((run) => run.endedAt ?? run.startedAt)].sort().at(-1)!;

export interface RequestRow {
  number: number;
  repo: string;
  app: string;
  appName: string;
  title: string;
  status: PortalRequest['status'];
  waitsOn: WaitsOn;
  // A run of it is going right now.
  running: boolean;
  person: string;
  issue?: number;
  pr?: number;
  prototypes: number;
  questions: number;
  decision?: 'approved' | 'rejected';
  verdict?: Verdict['kind'];
  // A reported error (#137).
  bug: boolean;
  createdAt: string;
  // Its last change or its last run's, whichever is later.
  lastAt: string;
}

export function requestRow(r: PortalRequest, user: PortalUser | undefined, entries: RepoEntry[], runs: RunSummary[]): RequestRow {
  const own = requestRuns(r, runs);
  return {
    number: r.number,
    repo: r.repo,
    app: r.app,
    appName: appName(entries, r),
    title: r.title,
    status: r.status,
    waitsOn: waitsOn(r),
    running: own.some((run) => run.state === 'running'),
    person: user?.name ?? 'Cuenta borrada',
    ...(r.issue ? { issue: r.issue.number } : {}),
    ...(r.pr ? { pr: r.pr } : {}),
    prototypes: r.prototypes?.length ?? 0,
    questions: r.questions,
    ...(r.decision ? { decision: r.decision.kind } : {}),
    ...(r.verdict ? { verdict: r.verdict.kind } : {}),
    bug: Boolean(r.bug),
    createdAt: r.createdAt,
    lastAt: lastAt(r, own),
  };
}

// One line of its activity, oldest first: a message, one of its events, or
// a run.
export type ActivityEntry =
  | { type: 'message'; at: string; message: PortalMessage; first: boolean; prototype?: number }
  | { type: 'event'; at: string; event: RequestEvent }
  | { type: 'run'; at: string; run: RunSummary };

// Requests from before #132 have no events: what's in them anyway (the
// verdict, the decision) stands in, and their issue goes last, with no time.
function legacyEvents(r: PortalRequest): RequestEvent[] {
  const out: RequestEvent[] = [];
  if (r.verdict) out.push({ kind: 'classified', verdict: r.verdict.kind, at: r.verdict.at });
  if (r.decision) out.push({ kind: 'decided', decision: r.decision.kind, at: r.decision.at });
  return out.filter((e) => e.at);
}

export function activity(r: PortalRequest, runs: RunSummary[]): { entries: ActivityEntry[]; untimed: RequestEvent[] } {
  const events = r.events?.length ? r.events : legacyEvents(r);
  const prototypeOf = new Map((r.prototypes ?? []).map((p) => [p.messageId, p.round]));
  const entries: ActivityEntry[] = [
    ...r.messages.map((message, i): ActivityEntry => ({ type: 'message', at: message.at, message, first: i === 0, ...(prototypeOf.has(message.id) ? { prototype: prototypeOf.get(message.id) } : {}) })),
    ...events.map((event): ActivityEntry => ({ type: 'event', at: event.at, event })),
    ...runs.map((run): ActivityEntry => ({ type: 'run', at: run.startedAt, run })),
  ];
  // Stable: at the same instant, the order above (a reply before its email).
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const untimed: RequestEvent[] = !r.events?.length && r.issue ? [{ kind: 'issue', number: r.issue.number, team: r.status !== 'approved' && r.status !== 'fixing' && r.status !== 'done', at: '' }] : [];
  return { entries, untimed };
}

export function requestDetail(r: PortalRequest, user: PortalUser | undefined, entries: RepoEntry[], runs: RunSummary[]) {
  const own = requestRuns(r, runs);
  return {
    ...requestRow(r, user, entries, runs),
    email: user?.email ?? null,
    messages: r.messages,
    verdict: r.verdict ?? null,
    prototypes: r.prototypes ?? [],
    bug: r.bug ?? null,
    decision: r.decision ?? null,
    issue: r.issue ?? null,
    pr: r.pr ?? null,
    // The release its change went out in (#158).
    deployed: r.deployed ?? null,
    activity: activity(r, own),
    runs: [...own].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    costUsd: own.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  };
}

// A file of the request, by the name it has in request.json: never a path
// the URL makes up.
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export async function requestImage(r: PortalRequest, file: string): Promise<{ type: string; data: Buffer } | null> {
  if (!r.messages.some((m) => m.images.includes(file))) return null;
  const type = IMAGE_TYPES[file.split('.').pop()?.toLowerCase() ?? ''];
  if (!type) return null;
  try {
    return { type, data: await readFile(requestImagePath(r.number, file)) };
  } catch {
    return null;
  }
}

export async function requestPatch(r: PortalRequest, round: number, of: 'prototype' | 'reproduction' = 'prototype'): Promise<string | null> {
  const file = (of === 'prototype' ? r.prototypes : r.bug?.reproductions)?.find((p) => p.round === round)?.patch;
  if (!file) return null;
  return readFile(prototypePatchPath(r.number, file), 'utf8').catch(() => null);
}
