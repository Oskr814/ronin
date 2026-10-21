import type { ReactNode } from 'react';

// A state in its color (the class of the page's CSS: ok, warn, run, idle,
// crit, plain…) and its words.
export function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}
