import type { PointerEvent } from 'react';

// The tooltip of the charts: the one element app.js also uses (#tip), shown
// next to the pointer with a part's numbers.
const tipEl = () =>
  document.getElementById('tip') ?? Object.assign(document.body.appendChild(document.createElement('div')), { id: 'tip', className: 'tip', role: 'tooltip' });

// What a chart's part (an .mt-hit) gets to show its tip.
export const tip = (text: string) => ({
  onPointerMove(e: PointerEvent) {
    const el = tipEl();
    el.textContent = text;
    el.style.opacity = '1';
    el.style.left = `${Math.min(e.clientX + 14, innerWidth - 300)}px`;
    el.style.top = `${e.clientY + 14}px`;
  },
  onPointerLeave() {
    tipEl().style.opacity = '0';
  },
});
