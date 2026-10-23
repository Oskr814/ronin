// Moving around an item's page with the keyboard (#195), as in vim where it
// fits: j/k the next unit of the tab (a section, a comment; a file and a
// finding have their own), d/u half a page, gg/G the top and the bottom.
// The digits go to a tab, and ]p/[p to the next PR that waits on a
// decision. Two-key sequences wait a moment for their second key.

import { landOn, reducedMotion } from '@apps/dashboard/src/lib/motion.js';

export const KEY_SEQ_MS = 900;
export const UNITS: Record<string, string> = { pr: '.page .psec, .page .md > :is(h1, h2, h3), .conv .comments > article', issue: '.page .md > :is(h1, h2, h3), .conv .comments > article' };

const units = (tab: string) => (UNITS[tab] ? [...document.querySelectorAll<HTMLElement>(`#doc :is(${UNITS[tab]})`)] : []);

// The unit j/k is on (`at`, in the tab `key`), marked again after the page is drawn.
export function markUnit(tab: string | null, at: { key: string; i: number } | null, key: string) {
  if (!tab || !UNITS[tab]) return;
  const all = units(tab);
  const on = at?.key === key ? all[at.i] : null;
  for (const el of all) el.classList.toggle('kcur', el === on);
}

// The next or the previous unit: where j/k is now.
export function moveUnit(tab: string, key: string, at: { key: string; i: number } | null, step: number): { key: string; i: number } | null {
  const all = units(tab);
  const scroller = document.getElementById('doc');
  if (!all.length) {
    scroller?.scrollBy({ top: step * 80 });
    return at;
  }
  const from = at?.key === key ? Math.min(at.i, all.length - 1) : -1;
  const i = Math.max(0, Math.min(all.length - 1, from < 0 ? (step > 0 ? 0 : all.length - 1) : from + step));
  const next = { key, i };
  markUnit(tab, next, key);
  all[i].scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  landOn(all[i]);
  return next;
}
