import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { reviewed, showDoc, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { goFile } from './files/model.js';
import { itemParam, sameLogin, type ItemPage } from './model.js';

// The review panel (#111): finishing the review as in GitHub's "Review
// changes", with a summary, Comment, Approve or Request changes, and the
// pending comments it carries. It drops from the button that opened it:
// the page's head, or the Archivos toolbar.

export type ReviewAt = 'head' | 'files';
type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface Reviewing {
  at: ReviewAt;
  event: ReviewEvent;
  text: string;
  fix: boolean;
  autoMerge: boolean;
  sending: boolean;
  error: string | null;
}

const REVIEW_EVENTS: Array<[ReviewEvent, string, string, string]> = [
  ['COMMENT', 'Comentar', '', 'Sin aprobar ni bloquear: solo deja los comentarios.'],
  ['APPROVE', 'Aprobar', 'ok', 'El PR queda aprobado.'],
  ['REQUEST_CHANGES', 'Pedir cambios', 'crit', 'El PR no se puede mergear hasta que lo apruebes o se descarte tu revisión.'],
];
const REVIEW_SENT: Record<ReviewEvent, string> = { COMMENT: 'Mandaste tu revisión', APPROVE: 'Aprobaste el PR', REQUEST_CHANGES: 'Pediste cambios' };
const REVIEW_DECISION: Partial<Record<ReviewEvent, 'APPROVED' | 'CHANGES_REQUESTED'>> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' };

// On an issue, the button says which PR it reviews.
export const reviewLabel = (v: ItemPage) => (v.item.kind === 'issue' ? `Revisar PR #${v.detail!.data!.pr!.number}` : 'Revisar');

// Whether approving offers the auto-merge: only to approve, on a PR that
// doesn't have it yet, isn't a draft (ronin doesn't read commands on a
// human's draft) and doesn't conflict (the command would refuse it), and
// never along with /fix-comments.
function autoMergeChoice(event: ReviewEvent, v: ItemPage, withFix: boolean): 'offer' | 'with-fix' | null {
  const d = v.detail?.data;
  if (event !== 'APPROVE' || !d?.ronin || !d.pr || d.pr.isDraft || d.pr.mergeable === 'CONFLICTING' || d.pr.labels?.includes('ronin:auto-merge')) return null;
  return withFix ? 'with-fix' : 'offer';
}

export function useReview(v: ItemPage | null) {
  const shell = useShell();
  const session = useSession();
  const [p, setP] = useState<Reviewing | null>(null);
  const open = (at: ReviewAt) => {
    if (!v) return;
    const next = p?.at === at ? null : { at, event: 'COMMENT' as const, text: '', fix: true, autoMerge: true, sending: false, error: null };
    setP(next);
    if (next && !v.files.data) v.files.load();
  };
  // What's sent, from the panel's state: the event (only Comment on one's
  // own PR), /fix-comments on ronin's when there's something to fix.
  const shape = (r: Reviewing) => {
    const data = v?.files.data;
    if (!v || !data) return null;
    const event: ReviewEvent = sameLogin(data.author, session.me) ? 'COMMENT' : r.event;
    const d = v.detail?.data;
    const pending = v.files.pending.length;
    const fixable = Boolean(d?.ronin && sameLogin(data.author, d.ronin) && (pending > 0 || event === 'REQUEST_CHANGES'));
    return { data, event, fixable, autoMerge: autoMergeChoice(event, v, fixable && r.fix) === 'offer' && r.autoMerge };
  };
  const send = async () => {
    const s = p && shape(p);
    if (!v || !p || !s || p.sending) return;
    const id = v.item.id;
    setP({ ...p, sending: true, error: null });
    try {
      const sent = (await ok(client.api.items[':id'].files.actions.$post({ param: itemParam(id), json: { action: 'submit', event: s.event, text: p.text, commitId: s.data.headSha, fixComments: Boolean(s.fixable && p.fix), autoMerge: s.autoMerge } }))) as { url?: string; fixUrl?: string; autoMergeUrl?: string };
      setP(null);
      const decision = REVIEW_DECISION[s.event];
      if (decision) reviewed(id, s.data.pr, decision);
      shell.toast(`${REVIEW_SENT[s.event]}${sent.fixUrl ? '; ronin ya tiene el /fix-comments' : ''}${sent.autoMergeUrl ? ' y le pediste el auto-merge' : ''}.`, sent.url);
      v.files.reread();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setP({ ...p, sending: false, error: `No se pudo: ${(e as Error).message}` });
    }
  };
  const discard = async () => {
    if (!v || !p) return;
    const n = v.files.pending.length;
    if (!confirm(`¿Descartar tu revisión${n ? ` con ${n} comentario${n === 1 ? '' : 's'}` : ''}? No se puede deshacer.`)) return;
    const id = v.item.id;
    setP({ ...p, sending: true });
    try {
      await ok(client.api.items[':id'].files.actions.$post({ param: itemParam(id), json: { action: 'discard' } }));
      setP(null);
      shell.toast('Descartaste tu revisión.');
      v.files.reread();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setP({ ...p, sending: false, error: `No se pudo: ${(e as Error).message}` });
    }
  };
  return { p, setP, open, send, discard, shape, close: () => setP(null) };
}
export type Review = ReturnType<typeof useReview>;

export function ReviewPanel({ v, review }: { v: ItemPage; review: Review }) {
  const session = useSession();
  const p = review.p!;
  const panel = useRef<HTMLDivElement>(null);
  const sum = useRef<HTMLTextAreaElement>(null);
  // The summary takes the focus when the panel opens with the PR read.
  const focus = useRef(Boolean(v.files.data));
  useLayoutEffect(() => {
    if (focus.current) sum.current?.focus();
  }, []);
  // Under the Archivos toolbar it lives inside the diffs' scroller: it ends
  // where that ends, not past it.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || getComputedStyle(el).position !== 'absolute') return;
    const bottom = el.closest('.fdiffs')?.getBoundingClientRect().bottom ?? window.innerHeight;
    el.style.maxHeight = `${Math.max(240, bottom - el.getBoundingClientRect().top - 12)}px`;
  });
  const { files } = v;
  const head = <header><h2>Terminar la revisión</h2><span className="m">{files.data ? `de PR #${files.data.pr}, ` : ''}como {session.me}</span><button className="x" aria-label="Cerrar" onClick={review.close}>×</button></header>;
  if (!files.data) return <div className="rpanel" role="dialog" aria-label="Terminar la revisión" ref={panel}>{head}<div className="rbody"><p className="m">{files.error ? `No se pudo leer el PR: ${files.error}` : 'Leyendo el PR…'}</p></div></div>;
  const s = review.shape(p)!;
  const own = sameLogin(files.data.author, session.me);
  const pend = files.pending;
  const d = v.detail?.data;
  const autoMerge = d?.pr?.labels?.includes('ronin:auto-merge');
  const merge = autoMergeChoice(s.event, v, s.fixable && p.fix);
  const where = (c: (typeof pend)[number]) => `${c.path.split('/').pop()}${c.subject === 'file' ? '' : c.line ? ` · línea ${c.line}` : ''}`;
  const can = !p.sending && (s.event !== 'COMMENT' || pend.length > 0 || p.text.trim());
  return (
    <div className="rpanel" role="dialog" aria-label="Terminar la revisión" ref={panel}>{head}<div className="rbody">
      <textarea id="rsum" ref={sum} rows={3} placeholder="Resumen (opcional). Va arriba de la revisión, como en GitHub." value={p.text} onChange={(e) => review.setP({ ...p, text: e.target.value })} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void review.send();
      }} />
      <div className="rev">{REVIEW_EVENTS.map(([value, label, cls, help]) => {
        const off = own && value !== 'COMMENT';
        const why = value === 'APPROVE' && autoMerge ? 'El PR tiene ronin:auto-merge: se mergea cuando pasen los checks.' : help;
        return <label key={value} className={off ? 'off' : ''} title={off ? 'GitHub no deja aprobar ni pedir cambios en tu propio PR' : undefined}><input type="radio" name="rev" value={value} checked={s.event === value} disabled={off} onChange={() => review.setP({ ...p, event: value })} /><b className={cls}>{label}</b><small>{off ? 'No se puede en tu propio PR.' : why}</small></label>;
      })}</div>
      {/* ronin reads a review's comments, not its summary, and acts on them only when asked. */}
      {s.fixable && <label className="rfix"><input type="checkbox" id="rfix" checked={p.fix} onChange={(e) => review.setP({ ...p, fix: e.target.checked })} /><span><b>Que ronin los atienda ahora</b><small>Después de la revisión comenta <code>{`@${d!.ronin} /fix-comments`}</code> a tu nombre.</small></span></label>}
      {(merge === 'offer' || merge === 'with-fix') && <label className={`rfix${merge === 'with-fix' ? ' off' : ''}`}><input type="checkbox" id="ram" checked={merge === 'offer' && p.autoMerge} disabled={merge === 'with-fix'} onChange={(e) => review.setP({ ...p, autoMerge: e.target.checked })} /><span><b>Mergear apenas pasen los checks</b><small>{merge === 'with-fix'
        ? 'No junto con /fix-comments: se mergearía antes de que ronin los atienda. Pedí el auto-merge cuando estén.'
        : <>Después de aprobar comenta <code>{`@${d!.ronin} /auto-merge`}</code> a tu nombre (el label <code>ronin:auto-merge</code>).</>}</small></span></label>}
      <div className="rlist"><div className="rh">En tu revisión<span>{pend.length ? `${pend.length} comentario${pend.length === 1 ? '' : 's'}` : ''}</span></div>{pend.length
        ? pend.map((c) => <button key={c.nodeId} className="ri" onClick={() => {
          review.close();
          goFile(v.item.id, c.path, c.nodeId);
          showDoc(v.item.id, 'files');
        }}><span className="w">{where(c)}{c.isNew ? '' : ' · respuesta'}</span><span className="t">{c.body.replace(/```suggestion[\s\S]*?```/g, '[cambio sugerido]').trim().split('\n')[0]}</span></button>)
        : <p className="m">Ningún comentario todavía: hacé clic en el número de una línea en Archivos.</p>}</div></div>
      <footer>{p.error ? <span className="bad">{p.error}</span> : <span className="m">{pend.length ? 'Hasta mandarla, nadie ve tus comentarios.' : ''}</span>}{files.review && <button className="btn-s danger" disabled={p.sending} onClick={() => void review.discard()}>Descartar</button>}<button className="btn-s primary" disabled={!can} onClick={() => void review.send()}>{p.sending ? 'Enviando…' : 'Mandar revisión'}</button></footer></div>
  );
}
