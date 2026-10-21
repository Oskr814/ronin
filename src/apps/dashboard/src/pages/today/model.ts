import type { Snapshot, Today } from '@apps/dashboard/src/api.js';
import { DAY_MS } from '@apps/dashboard/src/lib/format.js';

export type Cycle = Today['cycles'][number];
export type Item = Snapshot['items'][number];

// Read again this often while Hoy is open, as often as the shell reads the snapshot.
export const EVERY_MS = 5000;

export const cycleName = (c: { name?: string; number: number }) => c.name || `Ciclo ${c.number}`;
export const dayMonth = (iso: string) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace('.', '');
// A cycle ends at midnight: its last day is the one before.
export const endDay = (iso: string) => dayMonth(new Date(Date.parse(iso) - 1).toISOString());

// The cycle's issues by where they stand: ronin's by what GitHub says of
// them, the team's by their Linear state (domains/items/linear.ts).
export const BUCKETS: Array<[string, string, string]> = [
  ['done', 'hechos', 'var(--ok)'],
  ['ronin', 'ronin trabaja', 'var(--run)'],
  ['review', 'en review', 'var(--warn)'],
  ['blocked', 'esperan a alguien', 'var(--crit)'],
  ['started', 'en curso, del equipo', 'var(--lin)'],
  ['todo', 'sin empezar', 'var(--faint)'],
];

export function niceMax(v: number) {
  const step = v <= 10 ? 2 : v <= 50 ? 10 : v <= 100 ? 20 : 50;
  return Math.max(step, Math.ceil(v / step) * step);
}

// Issues in the cycle against issues done, day by day (Linear's history),
// over the whole cycle so what's left to go shows as room.
export const BURN = { W: 400, H: 180, l: 28, r: 96, t: 10, b: 20 };
export function burnGeometry(c: Cycle) {
  const total = Math.max(1, Math.round((Date.parse(c.endsAt) - Date.parse(c.startsAt)) / DAY_MS));
  const max = niceMax(Math.max(...c.scopeHistory, 1));
  const x = (d: number) => BURN.l + (d / total) * (BURN.W - BURN.l - BURN.r);
  const y = (v: number) => BURN.t + (1 - v / max) * (BURN.H - BURN.t - BURN.b);
  return { total, max, x, y };
}

// What waits on a person, to act on: blocked issues, ronin's PRs waiting for
// a review or a merge (the longest waiting first), the exploration PR and
// the previews that are up.
export function attention(snap: Snapshot, now: number) {
  const items = snap.items;
  const blocked = items.filter((i) => i.status === 'blocked');
  const waitedSince = (i: Item) => Date.parse(i.lastRun?.endedAt ?? i.lastRun?.startedAt ?? '') || now;
  const review = items.filter((i) => i.kind === 'issue' && i.slices?.length && i.status === 'waiting' && i.pr && !i.pr.isDraft && i.pr.reviewDecision !== 'CHANGES_REQUESTED'
    && !i.pr.checks.some((c) => c.outcome !== 'passed')).sort((a, b) => waitedSince(a) - waitedSince(b));
  const exploration = items.filter((i) => i.kind === 'pr' && i.note === 'PR de exploración abierto');
  return { blocked, review, exploration, previews: snap.previews, waitedSince };
}
export type Attention = ReturnType<typeof attention>;
