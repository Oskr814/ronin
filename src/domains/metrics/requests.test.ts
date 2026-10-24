import { describe, it, expect } from 'vitest';
import type { PortalRequest, RequestEvent } from '../portal/requests.js';
import { computeRequestMetrics } from './requests.js';

// Invented requests of an invented repo, around a fixed now.
const NOW = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000, D = 24 * H;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ev = (msAgo: number, e: Record<string, unknown>) => ({ ...e, at: at(msAgo) }) as RequestEvent;

function request(n: number, over: Partial<PortalRequest> = {}): PortalRequest {
  return { number: n, userId: 'u1', repo: 'acme/tienda', app: 'backoffice', title: `Pedido ${n}`, status: 'thinking', messages: [], questions: 0, createdAt: at(10 * D), updatedAt: at(D), ...over };
}

// Asked 10 days ago, read in 1 h, prototype 2 h later, approved 1 h after
// it, decided by a dev 5 h later, merged a day later and deployed 3 h after.
const delivered = request(1, {
  status: 'done',
  messages: [{ id: 1, from: 'person', text: 'x', images: [], at: at(10 * D) }, { id: 2, from: 'ronin', text: 'prototipo', images: [], at: at(10 * D - 3 * H) }],
  prototypes: [{ round: 1, summary: '', messageId: 2, at: at(10 * D - 3 * H) }],
  decision: { kind: 'approved', at: at(10 * D - 4 * H) },
  devDecision: { kind: 'review', by: 'ana-dev', at: at(10 * D - 9 * H) },
  deployed: { tag: 'v1', at: at(9 * D - 9 * H - 3 * H) },
  events: [ev(10 * D - H, { kind: 'classified', verdict: 'minor' }), ev(9 * D - 9 * H, { kind: 'closed', status: 'done' }), ev(9 * D - 12 * H, { kind: 'deploy', tag: 'v1', state: 'deployed', prerelease: false })],
});
// Prioritario, waiting for a dev two days.
const waiting = request(2, {
  status: 'awaiting-dev', userId: 'u2', createdAt: at(3 * D),
  decision: { kind: 'approved', at: at(2 * D) },
  priority: { impact: 'blocks', reason: 'x', at: at(2 * D) },
  events: [ev(3 * D - H, { kind: 'classified', verdict: 'minor' })],
});
// A big one, its issue assigned to beto-dev, open 4 days.
const big = request(3, { status: 'big', issue: { number: 30, url: '' }, createdAt: at(5 * D), events: [ev(4 * D, { kind: 'issue', number: 30, team: true })] });
// A big one, nobody assigned, and the person answered the team.
const unowned = request(4, { status: 'big', issue: { number: 40, url: '' }, createdAt: at(6 * D), personReplied: at(H), events: [ev(5 * D, { kind: 'issue', number: 40, team: true }), ev(2 * D, { kind: 'team-message', by: 'beto-dev' })] });
// Answered by ronin and closed on its own; one cancelled.
const answered = request(5, { status: 'cancelled', createdAt: at(4 * D), events: [ev(3 * D, { kind: 'expired', answered: true })] });
const cancelled = request(6, { status: 'cancelled', createdAt: at(2 * D), events: [ev(D, { kind: 'cancelled' })] });
// Prioritario the team took away, then declined.
const removed = request(7, {
  status: 'declined', createdAt: at(6 * D),
  decision: { kind: 'approved', at: at(5 * D) },
  priority: { impact: 'deadline', deadline: '2026-10-30', reason: 'x', at: at(5 * D), removed: { by: 'ana-dev', reason: 'no', at: at(4 * D) } },
  devDecision: { kind: 'decline', by: 'ana-dev', at: at(4 * D), reason: 'no' },
  events: [ev(4 * D, { kind: 'priority-removed', by: 'ana-dev' }), ev(4 * D, { kind: 'closed', status: 'declined' })],
});
// From before the period.
const old = request(8, { status: 'done', createdAt: at(50 * D), events: [ev(45 * D, { kind: 'closed', status: 'done' })] });

const metrics = (days: 7 | 30 = 30) => computeRequestMetrics({
  requests: [delivered, waiting, big, unowned, answered, cancelled, removed, old],
  people: new Map([['u1', 'Ana Pérez'], ['u2', 'Luis Gómez']]),
  assignees: (repo, n) => (repo === 'acme/tienda' && n === 30 ? ['beto-dev'] : []),
  days,
  now: NOW,
});

describe('Métricas → Pedidos (#428)', () => {
  it('counts what came in, what was delivered and how it ended', () => {
    const m = metrics();
    expect(m.current).toMatchObject({ opened: 7, delivered: 1, deliverMedian: D + 9 * H, ended: 4, answeredShare: 0.25, droppedShare: 0.25 });
    expect(m.previous).toMatchObject({ opened: 1, delivered: 1 });
    expect(m.waiting).toEqual({ dev: 1, big: 2 });
    // 30 days in 8 weeks, as Trabajo: the oldest one falls in the first.
    expect(m.series.reduce((s, x) => s + x.opened, 0)).toBe(8);
  });

  it('times each stretch, by whose wait it is', () => {
    const t = Object.fromEntries(metrics().times.map((x) => [x.key, x]));
    expect(t.leer).toMatchObject({ whose: 'ronin', count: 2, median: H });
    expect(t.prototipo).toMatchObject({ count: 1, median: 2 * H });
    expect(t.aprobar).toMatchObject({ whose: 'persona', count: 1, median: H });
    expect(t.decidir).toMatchObject({ whose: 'equipo', count: 2, median: (5 * H + D) / 2 });
    expect(t.hacer).toMatchObject({ count: 1, median: D });
    expect(t.desplegar).toMatchObject({ whose: 'entrega', count: 1, median: 3 * H });
    expect(t.reproducir.count).toBe(0);
  });

  it('credits the team: who decided, who owns a big one, who wrote or took a priority away', () => {
    const team = Object.fromEntries(metrics().team.map((x) => [x.login, x]));
    expect(team['ana-dev']).toMatchObject({ decisions: 2, review: 1, decline: 1, unprioritized: 1, bigOpen: 0 });
    expect(team['beto-dev']).toMatchObject({ decisions: 0, bigOpen: 1, bigOldest: 4 * D, messages: 1 });
  });

  it('shows each account of the portal, with its prioritarios', () => {
    expect(metrics().accounts).toEqual([
      { id: 'u1', name: 'Ana Pérez', opened: 6, delivered: 1, prioritized: 1, unprioritized: 1, dropped: 1 },
      { id: 'u2', name: 'Luis Gómez', opened: 1, delivered: 0, prioritized: 1, unprioritized: 0, dropped: 0 },
    ]);
    expect(metrics().priority).toMatchObject({ marked: 2, removed: 1 });
  });

  it('lists where they wait now, the oldest first', () => {
    const h = metrics().health;
    expect(h.slowDev.map((x) => [x.number, x.prioritized])).toEqual([[2, true]]);
    expect(h.unowned.map((x) => x.number)).toEqual([4]);
    expect(h.unanswered.map((x) => x.number)).toEqual([4]);
  });

  it('keeps to the period', () => {
    const m = metrics(7);
    expect(m.current.opened).toBe(6);
    expect(m.quality).toMatchObject({ devDecided: 1, declinedShare: 1, deploys: 0 });
    expect(m.apps).toEqual([{ repo: 'acme/tienda', app: 'backoffice', opened: 6, delivered: 0, deliverMedian: null }]);
  });
});
