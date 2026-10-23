import { useEffect, useRef, useState } from 'react';

// What helps the eye follow a change (#372): a short highlight on what
// changed by itself or what was jumped to, and the words of it for a screen
// reader. With less motion asked for, the highlight shows without fading
// (app.css): only its time here ends it.

export const FLASH_MS = 1200;

// True for a moment each time `value` changes after the first time it's
// seen. `seen` keeps the last value across mounts (a row that leaves the
// list and comes back doesn't flash for that). With `when`, only changes to
// a value it accepts.
export function useFlash(key: string, value: string | undefined, seen: Map<string, string>, when?: (value: string) => boolean): boolean {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    if (value === undefined) return;
    const before = seen.get(key);
    seen.set(key, value);
    if (before === undefined || before === value || (when && !when(value))) return;
    setOn(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), FLASH_MS);
  }, [key, value, seen, when]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return on;
}

// Where a jump landed (j/k, a link to a thread or a file): outlined for a
// moment, from the start each time.
const landed = new WeakMap<HTMLElement, number>();
export function landOn(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.classList.remove('landed');
  // A new frame, so the same element's animation starts again.
  void el.offsetWidth;
  el.classList.add('landed');
  clearTimeout(landed.get(el));
  landed.set(el, window.setTimeout(() => el.classList.remove('landed'), FLASH_MS));
}

// The words of something that changed on screen, for a screen reader: the
// shell's live region (Shell.tsx) says them.
type Listener = (text: string) => void;
const listeners = new Set<Listener>();
export function announce(text: string) {
  for (const listener of listeners) listener(text);
}
export function onAnnounce(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
