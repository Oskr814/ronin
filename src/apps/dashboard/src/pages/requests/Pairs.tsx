import { useState } from 'react';
import { Compare, type Pair } from '@ui/components/Compare.js';

// A prototype's or a reproduction's shots in the tablero (#407): small,
// a pair per box, so Ahora doesn't fill up with images; a click opens them
// to compare, with what each one shows.

export function Pairs({ pairs }: { pairs: Pair[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="pd-pairs">{pairs.map((pair, i) => (
        <button key={i} className="pd-pair" title={pair.after?.caption ?? pair.before?.caption} onClick={() => setOpen(i)}>
          {pair.before && <figure className="before"><img src={pair.before.src} alt={`Antes: ${pair.before.caption}`} loading="lazy" /><figcaption>Antes</figcaption></figure>}
          {pair.before && pair.after && <span className="arr">→</span>}
          {pair.after && <figure className="after"><img src={pair.after.src} alt={`Después: ${pair.after.caption}`} loading="lazy" /><figcaption>Después</figcaption></figure>}
        </button>
      ))}</div>
      {open !== null && <Compare pairs={pairs} start={open} close={() => setOpen(null)} />}
    </>
  );
}
