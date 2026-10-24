import type { PortalRequest, RequestEvent } from '../portal/requests.js';
import { buckets, median, percentile, type Period } from './compute.js';

// Métricas → Pedidos (#428): how the portal's requests are attended to —
// what comes in, how long each stretch takes and whose wait it is (ronin's,
// the person's or the team's), who of the team takes them, and where they
// wait. Pure, like compute.ts: the page's numbers are tested here. Times
// are calendar time, from each request's own record (its dates, its
// events, the dev's decision); a big request's owner is its issue's
// assignee on GitHub.

const DAY = 86_400_000;
// A request waiting for a dev longer than this is listed.
const DEV_WAIT_MS = DAY;
const LIST = 10;

export interface RequestMetricsInput {
  requests: PortalRequest[];
  // The portal's accounts, by id: their names.
  people: Map<string, string>;
  // The assignees of an issue of the product repo (Métricas' GitHub cache).
  assignees: (repo: string, issue: number) => string[];
  days: Period;
  now: number;
}

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const within = (v: number, a: number, b: number) => v >= a && v < b;

type Kind<K extends RequestEvent['kind']> = Extract<RequestEvent, { kind: K }>;
const eventsOf = <K extends RequestEvent['kind']>(r: PortalRequest, kind: K) => (r.events ?? []).filter((e): e is Kind<K> => e.kind === kind);
const firstAt = (r: PortalRequest, kind: RequestEvent['kind']) => t(eventsOf(r, kind)[0]?.at);

// When it ended, and how: its PR merged or the team resolved it
// (delivered), the team declined it, the person cancelled it, or it expired
// (unanswered, or answered by ronin with nothing left to do).
type Ending = 'delivered' | 'declined' | 'cancelled' | 'expired' | 'answered';
function ending(r: PortalRequest): { how: Ending; at: number } | null {
  const closed = eventsOf(r, 'closed').at(-1);
  if (closed) return { how: closed.status === 'declined' ? 'declined' : 'delivered', at: t(closed.at) };
  const expired = eventsOf(r, 'expired').at(-1);
  if (expired) return { how: expired.answered ? 'answered' : 'expired', at: t(expired.at) };
  const cancelled = eventsOf(r, 'cancelled').at(-1);
  if (cancelled) return { how: 'cancelled', at: t(cancelled.at) };
  return null;
}

// When it started waiting for a dev's decision: the person's approval, or a
// reported error's last reproduction.
function awaitingDevAt(r: PortalRequest): number {
  if (r.decision?.kind === 'approved') return t(r.decision.at);
  return t(eventsOf(r, 'reproduced').at(-1)?.at);
}

// When it became the team's (a big one): its team issue, or else when
// ronin or the person sent it there.
function teamAt(r: PortalRequest): number {
  const issue = eventsOf(r, 'issue').find((e) => e.team);
  if (issue) return t(issue.at);
  const big = eventsOf(r, 'classified').find((e) => e.verdict === 'big');
  if (big) return t(big.at);
  return r.decision?.kind === 'rejected' ? t(r.decision.at) : NaN;
}
const isBig = (r: PortalRequest) => r.status === 'big' || (Boolean(r.issue) && !r.devDecision && !Number.isNaN(teamAt(r)));

// A stretch of a request's way: whose wait it is, from when to when.
type Whose = 'ronin' | 'persona' | 'equipo' | 'entrega';
interface Stretch { key: string; whose: Whose; label: string; from: number; to: number }

function stretches(r: PortalRequest): Stretch[] {
  const out: Stretch[] = [];
  const add = (key: string, whose: Whose, label: string, from: number, to: number) => {
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) out.push({ key, whose, label, from, to });
  };
  const created = t(r.createdAt);
  const classified = eventsOf(r, 'classified')[0];
  add('leer', 'ronin', 'Leerlo y decidir qué es', created, t(classified?.at));
  if (classified?.verdict === 'minor' && r.prototypes?.length) add('prototipo', 'ronin', 'Armar el prototipo', t(classified.at), t(r.prototypes[0].at));
  if (classified?.verdict === 'error') add('reproducir', 'ronin', 'Reproducir el error', t(classified.at), firstAt(r, 'reproduced'));
  if (r.decision) {
    const shown = r.messages.filter((m) => m.from === 'ronin' && t(m.at) <= t(r.decision!.at)).at(-1);
    add('aprobar', 'persona', 'Aprobar la propuesta', t(shown?.at), t(r.decision.at));
  }
  if (r.devDecision) add('decidir', 'equipo', 'Decidir si se hace', awaitingDevAt(r), t(r.devDecision.at));
  const end = ending(r);
  if (r.devDecision && r.devDecision.kind !== 'decline' && end?.how === 'delivered') add('hacer', 'equipo', 'Hacerlo y mergearlo', t(r.devDecision.at), end.at);
  if (isBig(r) && end && (end.how === 'delivered' || end.how === 'declined')) add('grande', 'equipo', 'Resolver un pedido grande', teamAt(r), end.at);
  if (r.deployed && end?.how === 'delivered') add('desplegar', 'entrega', 'Del merge a la app', end.at, t(r.deployed.at));
  return out;
}

const STRETCHES: Array<[string, Whose, string]> = [
  ['leer', 'ronin', 'Leerlo y decidir qué es'], ['prototipo', 'ronin', 'Armar el prototipo'], ['reproducir', 'ronin', 'Reproducir el error'],
  ['aprobar', 'persona', 'Aprobar la propuesta'],
  ['decidir', 'equipo', 'Decidir si se hace'], ['hacer', 'equipo', 'Hacerlo y mergearlo'], ['grande', 'equipo', 'Resolver un pedido grande'],
  ['desplegar', 'entrega', 'Del merge a la app'],
];

const share = (n: number, of: number) => (of ? n / of : null);
const open = (r: PortalRequest) => !ending(r);

interface Totals {
  opened: number;
  delivered: number;
  deliverMedian: number | null;
  deliverP90: number | null;
  // Of the ones that ended: answered by ronin with nothing to change, and
  // cancelled or expired without an answer.
  ended: number;
  answeredShare: number | null;
  droppedShare: number | null;
  decideMedian: number | null;
}

function totals(requests: PortalRequest[], a: number, b: number): Totals {
  const ends = requests.map((r) => ({ r, end: ending(r) })).filter((x) => x.end && within(x.end.at, a, b));
  const delivered = ends.filter((x) => x.end!.how === 'delivered');
  const times = delivered.map((x) => x.end!.at - t(x.r.createdAt));
  const decided = requests.filter((r) => r.devDecision && within(t(r.devDecision.at), a, b)).map((r) => t(r.devDecision!.at) - awaitingDevAt(r)).filter(Number.isFinite);
  return {
    opened: requests.filter((r) => within(t(r.createdAt), a, b)).length,
    delivered: delivered.length,
    deliverMedian: median(times),
    deliverP90: percentile(times, 0.9),
    ended: ends.length,
    answeredShare: share(ends.filter((x) => x.end!.how === 'answered').length, ends.length),
    droppedShare: share(ends.filter((x) => x.end!.how === 'cancelled' || x.end!.how === 'expired').length, ends.length),
    decideMedian: median(decided),
  };
}

export function computeRequestMetrics({ requests, people, assignees, days, now }: RequestMetricsInput) {
  const a = now - days * DAY, b = now, pa = a - days * DAY;
  const all = requests.map((r) => ({ r, s: stretches(r) }));
  const ownersOf = (r: PortalRequest) => (r.issue ? assignees(r.repo, r.issue.number) : []);

  // The team waits on these now: a dev's decision, or a big one open.
  const waitingDev = requests.filter((r) => r.status === 'awaiting-dev');
  const bigOpen = requests.filter((r) => r.status === 'big');

  const times = STRETCHES.map(([key, whose, label]) => {
    const xs = all.flatMap(({ s }) => s.filter((x) => x.key === key && within(x.to, a, b)).map((x) => x.to - x.from));
    return { key, whose, label, count: xs.length, median: median(xs), p90: percentile(xs, 0.9) };
  });

  // Who of the team: the dev who decided, the owner of a big one, who wrote
  // to the person, took a prioritario away or closed it from the tablero.
  const team = new Map<string, { login: string; decisions: number; deploy: number; review: number; decline: number; decideTimes: number[]; bigOpen: number; bigOldest: number | null; bigClosed: number; bigTimes: number[]; messages: number; unprioritized: number; closed: number }>();
  const of = (login: string) => {
    let p = team.get(login);
    if (!p) team.set(login, (p = { login, decisions: 0, deploy: 0, review: 0, decline: 0, decideTimes: [], bigOpen: 0, bigOldest: null, bigClosed: 0, bigTimes: [], messages: 0, unprioritized: 0, closed: 0 }));
    return p;
  };
  for (const r of requests) {
    const d = r.devDecision;
    if (d && within(t(d.at), a, b)) {
      const p = of(d.by);
      p.decisions++;
      p[d.kind]++;
      const took = t(d.at) - awaitingDevAt(r);
      if (Number.isFinite(took)) p.decideTimes.push(took);
    }
    if (isBig(r)) {
      const end = ending(r);
      for (const login of ownersOf(r)) {
        const p = of(login);
        if (!end) {
          p.bigOpen++;
          const since = now - teamAt(r);
          if (Number.isFinite(since)) p.bigOldest = Math.max(p.bigOldest ?? 0, since);
        } else if (within(end.at, a, b) && (end.how === 'delivered' || end.how === 'declined')) {
          p.bigClosed++;
          if (Number.isFinite(teamAt(r))) p.bigTimes.push(end.at - teamAt(r));
        }
      }
    }
    for (const e of r.events ?? []) {
      if (!within(t(e.at), a, b)) continue;
      if (e.kind === 'team-message') of(e.by).messages++;
      if (e.kind === 'priority-removed') of(e.by).unprioritized++;
      if (e.kind === 'closed' && e.by) of(e.by).closed++;
    }
  }

  // Each account of the portal: what it asked and how it went, prioritarios included.
  const accounts = new Map<string, { id: string; name: string; opened: number; delivered: number; prioritized: number; unprioritized: number; dropped: number }>();
  for (const r of requests) {
    const acc = accounts.get(r.userId) ?? { id: r.userId, name: people.get(r.userId) ?? 'Cuenta borrada', opened: 0, delivered: 0, prioritized: 0, unprioritized: 0, dropped: 0 };
    const end = ending(r);
    if (within(t(r.createdAt), a, b)) acc.opened++;
    if (end && within(end.at, a, b)) {
      if (end.how === 'delivered') acc.delivered++;
      if (end.how === 'cancelled' || end.how === 'expired') acc.dropped++;
    }
    if (r.priority && within(t(r.priority.at), a, b)) {
      acc.prioritized++;
      if (r.priority.removed) acc.unprioritized++;
    }
    if (acc.opened || acc.delivered || acc.dropped || acc.prioritized) accounts.set(r.userId, acc);
  }

  // Prioritarios (#430): how many, how many taken away, and whether a dev
  // decides them sooner.
  const marked = requests.filter((r) => r.priority && within(t(r.priority.at), a, b));
  const decideOf = (pick: (r: PortalRequest) => boolean) => median(requests.filter((r) => r.devDecision && within(t(r.devDecision.at), a, b) && pick(r)).map((r) => t(r.devDecision!.at) - awaitingDevAt(r)).filter(Number.isFinite));

  // What came out of it.
  const decidedByPerson = requests.filter((r) => r.decision && within(t(r.decision.at), a, b));
  const devDecided = requests.filter((r) => r.devDecision && within(t(r.devDecision.at), a, b));
  const bugs = requests.filter((r) => r.bug && within(t(r.createdAt), a, b) && eventsOf(r, 'reproduced').length);
  const deploys = requests.flatMap((r) => eventsOf(r, 'deploy').filter((e) => e.state !== 'published' && within(t(e.at), a, b)));

  // By app: what each asks for and how long it takes.
  const apps = new Map<string, { repo: string; app: string; opened: number; delivered: number; times: number[] }>();
  for (const r of requests) {
    const key = `${r.repo}:${r.app}`;
    const x = apps.get(key) ?? { repo: r.repo, app: r.app, opened: 0, delivered: 0, times: [] };
    const end = ending(r);
    if (within(t(r.createdAt), a, b)) x.opened++;
    if (end?.how === 'delivered' && within(end.at, a, b)) {
      x.delivered++;
      x.times.push(end.at - t(r.createdAt));
    }
    if (x.opened || x.delivered) apps.set(key, x);
  }

  const item = (r: PortalRequest, since: number) => ({ number: r.number, repo: r.repo, title: r.title, person: people.get(r.userId) ?? 'Cuenta borrada', since: new Date(since).toISOString(), prioritized: Boolean(r.priority && !r.priority.removed) });
  const oldestFirst = <T extends { since: string }>(xs: T[]) => xs.sort((x, y) => x.since.localeCompare(y.since));
  const slowDev = oldestFirst(waitingDev.map((r) => item(r, awaitingDevAt(r))).filter((x) => now - t(x.since) > DEV_WAIT_MS));
  const unowned = oldestFirst(bigOpen.filter((r) => !ownersOf(r).length).map((r) => item(r, Number.isFinite(teamAt(r)) ? teamAt(r) : t(r.createdAt))));
  const unanswered = oldestFirst(requests.filter((r) => r.personReplied && open(r)).map((r) => item(r, t(r.personReplied))));

  return {
    days,
    current: totals(requests, a, b),
    previous: totals(requests, pa, a),
    // Now, not over the period.
    waiting: { dev: waitingDev.length, big: bigOpen.length },
    series: buckets(days, now).map((bk) => {
      const x = totals(requests, bk.a, bk.b);
      return { from: new Date(bk.a).toISOString(), to: new Date(bk.b).toISOString(), opened: x.opened, delivered: x.delivered, deliverMedian: x.deliverMedian };
    }),
    times,
    team: [...team.values()].map(({ decideTimes, bigTimes, ...p }) => ({ ...p, decideMedian: median(decideTimes), bigMedian: median(bigTimes) })).sort((x, y) => y.decisions + y.bigClosed - (x.decisions + x.bigClosed) || x.login.localeCompare(y.login)),
    accounts: [...accounts.values()].sort((x, y) => y.opened - x.opened || y.prioritized - x.prioritized || x.name.localeCompare(y.name, 'es')),
    priority: { marked: marked.length, removed: marked.filter((r) => r.priority!.removed).length, decideMedian: decideOf((r) => Boolean(r.priority && !r.priority.removed)), normalDecideMedian: decideOf((r) => !r.priority || Boolean(r.priority.removed)) },
    quality: {
      proposalsDecided: decidedByPerson.length,
      rejectedShare: share(decidedByPerson.filter((r) => r.decision!.kind === 'rejected').length, decidedByPerson.length),
      // Proposals each one took, with or without a prototype.
      proposalsPerRequest: decidedByPerson.length ? decidedByPerson.reduce((sum, r) => sum + (r.prototypes?.length ?? 0) + (r.proposals ?? 0), 0) / decidedByPerson.length : null,
      devDecided: devDecided.length,
      declinedShare: share(devDecided.filter((r) => r.devDecision!.kind === 'decline').length, devDecided.length),
      bugs: bugs.length,
      reproducedShare: share(bugs.filter((r) => eventsOf(r, 'reproduced').some((e) => e.reproduced)).length, bugs.length),
      deploys: deploys.length,
      deploysFailed: deploys.filter((e) => e.state === 'failed').length,
    },
    apps: [...apps.values()].map(({ times: xs, ...x }) => ({ ...x, deliverMedian: median(xs) })).sort((x, y) => y.opened - x.opened || x.app.localeCompare(y.app)),
    health: {
      slowDev: slowDev.slice(0, LIST), slowDevTotal: slowDev.length,
      unowned: unowned.slice(0, LIST), unownedTotal: unowned.length,
      unanswered: unanswered.slice(0, LIST), unansweredTotal: unanswered.length,
    },
  };
}

export type RequestMetrics = ReturnType<typeof computeRequestMetrics>;
