// Small formats the pages share, written as app.js writes them.

export const DAY_MS = 24 * 60 * 60_000;

export const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export const isMobile = () => matchMedia('(max-width: 760px)').matches;

// A moment, and its time of day, as app.js writes them.
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
export const repoShort = (repo: string) => repo.split('/')[1] ?? repo;

// A week of numbers as a line, the last one marked (today, this week).
export function Sparkline({ values }: { values: Array<number | null> }) {
  const w = 120, h = 22;
  const vals = values.map((v) => v ?? 0);
  const max = Math.max(...vals, 1e-9);
  const pt = (v: number, k: number) => [(k / Math.max(1, vals.length - 1)) * w, h - 2 - (v / max) * (h - 4)];
  const d = vals.map((v, k) => `${k ? 'L' : 'M'}${pt(v, k).map((n) => n.toFixed(1)).join(',')}`).join('');
  const [lx, ly] = pt(vals[vals.length - 1], vals.length - 1);
  return (
    <svg width={w} height={h} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="3" fill="var(--run)" />
    </svg>
  );
}
