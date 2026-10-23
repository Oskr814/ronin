import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// A prototype's shots, or a reproduction's (#407): each before goes with
// the after of the same number (p1-antes-2 with p1-despues-2, r1-error-1
// with r1-arreglo-1). The tablero and the portal show them in pairs, and a
// click opens them to compare at full size, with what each one shows. The
// page's CSS styles .cmp.

export interface Shot { src: string; caption: string }
export interface Pair { before?: Shot; after?: Shot }

const SIDE = /-(antes|despues|error|arreglo)-(\d+)\.\w+$/;

// `src(file)`: where the page reads each image. Null when the images aren't
// a before and an after (what the person sent).
export function pairsOf(m: { images: string[]; captions?: string[] }, src: (file: string) => string = (f) => f): Pair[] | null {
  const byNumber = new Map<string, Pair>();
  for (const [i, file] of m.images.entries()) {
    const side = SIDE.exec(file);
    if (!side) return null;
    const pair = byNumber.get(side[2]) ?? {};
    // "Antes: …", "Después: …": the label is the side's.
    const caption = (m.captions?.[i] ?? '').replace(/^(Antes|Después):\s*/i, '');
    pair[side[1] === 'antes' || side[1] === 'error' ? 'before' : 'after'] = { src: src(file), caption };
    byNumber.set(side[2], pair);
  }
  return byNumber.size ? [...byNumber.values()] : null;
}

const LABEL = { before: 'Antes', after: 'Después' } as const;
type Mode = 'both' | 'before' | 'after';

export function Compare({ pairs, start, close }: { pairs: Pair[]; start: number; close: () => void }) {
  const [at, setAt] = useState(start);
  // On a phone, one at a time.
  const [mode, setMode] = useState<Mode>(() => (typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches ? 'after' : 'both'));
  const pair = pairs[at];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowRight') setAt((i) => (i + 1) % pairs.length);
      else if (event.key === 'ArrowLeft') setAt((i) => (i + pairs.length - 1) % pairs.length);
      else if (event.key === ' ') {
        event.preventDefault();
        setMode((m) => (m === 'before' ? 'after' : m === 'after' ? 'before' : m));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close, pairs.length]);
  const sides = (['before', 'after'] as const).filter((k) => pair[k] && (mode === 'both' || mode === k));
  return createPortal(
    <div className="cmp" role="dialog" aria-modal="true" aria-label="Comparar antes y después">
      <div className="cmp-bar">
        <b>{pairs.length > 1 ? `Captura ${at + 1} de ${pairs.length}` : 'Antes y después'}</b>
        {pairs.length > 1 && <span className="kb">← → otra captura</span>}
        <span className="sp" />
        {(['both', 'before', 'after'] as const).map((k) => <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{k === 'both' ? 'Lado a lado' : LABEL[k]}</button>)}
        <button onClick={close}>Cerrar ✕</button>
      </div>
      <div className={`cmp-stage ${sides.length === 1 ? 'one' : ''}`}>{sides.map((k) => (
        <div key={k} className={`cmp-side ${k}`}><div className="h"><b>{LABEL[k]}</b>{pair[k]!.caption}</div><img src={pair[k]!.src} alt={`${LABEL[k]}: ${pair[k]!.caption}`} /></div>
      ))}</div>
    </div>,
    document.body,
  );
}
