import type { FocusEvent, PointerEvent } from 'react';

// The tooltip of the charts: one element for all of them (#tip), shown
// next to the pointer with a part's numbers.
const tipEl = () =>
  document.getElementById('tip') ?? Object.assign(document.body.appendChild(document.createElement('div')), { id: 'tip', className: 'tip', role: 'tooltip' });

function show(text: string, x: number, y: number) {
  const el = tipEl();
  el.textContent = text;
  el.style.opacity = '1';
  el.style.left = `${Math.min(x + 14, innerWidth - 300)}px`;
  el.style.top = `${y + 14}px`;
}

export const hideTip = () => {
  tipEl().style.opacity = '0';
};

// What a chart's part (an .mt-hit, a run's bar) gets to show its tip: by
// the pointer, or under it when it's reached with the keyboard.
export const tip = (text: string) => ({
  onPointerMove(e: PointerEvent) {
    show(text, e.clientX, e.clientY);
  },
  onPointerLeave: hideTip,
  onFocus(e: FocusEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    show(text, r.left, r.bottom);
  },
  onBlur: hideTip,
});
