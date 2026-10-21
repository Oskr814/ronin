import { useEffect, useState } from 'react';

const MIN = 60e3;

// "hace 5m", as app.js writes it.
export function short(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'recién';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
export const ago = (iso: string | null | undefined, now = Date.now()) => (iso ? `hace ${short(now - Date.parse(iso))}` : '');

// The time now, again every half minute: what "hace…" is counted from.
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
