import { DAY_MS, pct } from '@apps/dashboard/src/lib/format.js';

// How Métricas writes its numbers (#222).

// A time, the way a person says it: minutes, hours or days.
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} h`;
  const d = ms / DAY_MS;
  return `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} d`;
}

export const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : n.toFixed(digits).replace('.', ','));
export const percent = (f: number | null | undefined) => (f === null || f === undefined ? '—' : pct(f));

// A bar's label: the day of the week for 7 days, the week's first day otherwise.
export function bucketLabel(bucket: { from: string }, days: number): string {
  const d = new Date(Date.parse(bucket.from) + 1);
  return days === 7 ? ['do', 'lu', 'ma', 'mi', 'ju', 'vi', 'sá'][d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}`;
}

// The subscription's money: whole dollars from 20 up.
export const money = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : `$${usd >= 20 ? Math.round(usd).toLocaleString('en') : usd.toFixed(2).replace('.', ',')}`);
export const when = (iso: string) => new Date(iso).toLocaleString('es', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const day = (ms: number) => new Date(ms).toLocaleDateString('es', { weekday: 'short', day: 'numeric' });
export const left = (ms: number) => (ms > DAY_MS ? `${Math.floor(ms / DAY_MS)} d ${Math.round((ms % DAY_MS) / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 3_600_000))} h`);
