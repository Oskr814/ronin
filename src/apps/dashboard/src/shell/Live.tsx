import { createElement, useLayoutEffect, useRef } from 'react';
import { clock } from '../lib/runs.js';

// A clock the shell moves every second (tickClocks): how long since
// `since`, or how long until `until`. React only writes it when it draws;
// the second after, the shell does.
export function Live({ as = 'span', className, since, until, text }: { as?: 'span' | 'dd'; className?: string; since?: string; until?: string; text: string }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = text;
  });
  return createElement(as, { ref, className, 'data-since': since, 'data-until': until });
}

export function tickClocks() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = clock(Date.now() - Date.parse(el.dataset.since!));
  for (const el of document.querySelectorAll<HTMLElement>('[data-until]')) el.textContent = clock(Date.parse(el.dataset.until!) - Date.now());
}
