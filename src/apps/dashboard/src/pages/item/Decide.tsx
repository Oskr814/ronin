import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useHost, type ItemView } from '../../host.js';
import { checksChip, itemParam, oneOr } from './model.js';

// Deciding a PR ronin opened (#195): its page asks what's decided, not how
// to review it: merge it, ask ronin for an adjustment, or close it. Always
// in the header, so on every tab, and a key away (A, P, X). A PR by anyone
// else keeps the review panel.

export type DecideKind = 'approve' | 'adjust' | 'close';
export const DECIDE_QUICK = ['Agregá un test para este caso', 'Revertí una de las decisiones propias', 'Separá esto en otro PR'];

export interface Deciding {
  kind: DecideKind;
  text: string;
  closeIssue: boolean;
  sending: boolean;
  error: string | null;
}

// What was just decided here, for a few minutes: GitHub takes a moment to
// show it. Kept while the person is elsewhere.
const DECIDED_SHOWN_MS = 10 * 60_000;
interface Decided {
  at: number;
  kind: DecideKind;
  url?: string;
  autoMerge: boolean;
  issue: boolean;
  count: number;
}
const decided = new Map<string, Decided>();

export function useDecide(v: ItemView | null) {
  const host = useHost();
  const [p, setP] = useState<Deciding | null>(null);
  const [focusText, setFocusText] = useState(0);
  const pending = v?.files.pending.length ?? 0;
  const open = (kind: DecideKind) => {
    if (!v) return;
    const next = p?.kind === kind ? null : { kind, text: '', closeIssue: true, sending: false, error: null };
    setP(next);
    // The pending comments it carries.
    if (next && !v.files.data) host.loadFiles(v.item.id);
    setFocusText((n) => n + 1);
  };
  const send = async () => {
    if (!v || !p || p.sending) return;
    if (p.kind === 'adjust' && !p.text.trim() && !pending) return;
    const id = v.item.id;
    setP({ ...p, sending: true, error: null });
    try {
      const sent = (await ok(client.api.items[':id'].decision.$post({ param: itemParam(id), json: { decision: p.kind, text: p.text, closeIssue: p.closeIssue } }))) as { url: string; autoMergeUrl?: string; issueUrl?: string };
      setP(null);
      decided.set(id, { at: Date.now(), kind: p.kind, url: sent.url, autoMerge: Boolean(sent.autoMergeUrl), issue: Boolean(sent.issueUrl), count: pending });
      host.toast(p.kind === 'approve' ? 'Aprobaste el PR.' : p.kind === 'adjust' ? 'Se lo mandaste a ronin.' : 'Cerraste el PR.', sent.url);
      host.reread(id, true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return host.unauthorized(e.message);
      setP({ ...p, sending: false, error: `No se pudo: ${(e as Error).message}` });
    }
  };
  const addQuick = (i: number) => {
    if (!p) return;
    setP({ ...p, text: `${p.text.trim() ? `${p.text.replace(/\s+$/, '')}\n` : ''}${DECIDE_QUICK[i]}.` });
    setFocusText((n) => n + 1);
  };
  return { p, setP, open, send, addQuick, focusText, refocus: () => setFocusText((n) => n + 1), close: () => setP(null) };
}
export type Decide = ReturnType<typeof useDecide>;

export function DecidedNote({ id }: { id: string }) {
  const done = decided.get(id);
  if (!done || Date.now() - done.at > DECIDED_SHOWN_MS) return null;
  const what = done.kind === 'approve'
    ? `Aprobaste el PR${done.autoMerge ? ' y le pediste el auto-merge a ronin' : ''}.`
    : done.kind === 'adjust'
      ? `Le pediste un ajuste a ronin${done.count ? ` con ${oneOr(done.count, 'un comentario', `${done.count} comentarios`)} de Archivos` : ''}. Lo toma en el próximo tick.`
      : `Cerraste el PR${done.issue ? ' y su issue' : ''}.`;
  return <div className="decided">{what}{done.url && <> <a href={done.url} target="_blank" rel="noopener">Ver ↗</a></>}</div>;
}

export function DecideBar({ v, decide }: { v: ItemView; decide: Decide }) {
  const { p } = decide;
  const button = (kind: DecideKind, cls: string, label: string, key: string, title: string) => (
    <button className={cls} aria-haspopup="dialog" aria-expanded={p?.kind === kind} title={title} onClick={(e) => {
      e.stopPropagation();
      decide.open(kind);
    }}>{label} <kbd>{key}</kbd></button>
  );
  return (
    <div className="actions dwrap">{button('close', 'gh dbtn danger', 'Cerrar', 'X', 'Cerrar el PR (X)')}{button('adjust', 'gh dbtn run', 'Ajustar', 'P', 'Pedirle un ajuste a ronin (P)')}{button('approve', 'act-btn dbtn ok', 'Aprobar', 'A', 'Aprobar y mergear (A)')}{p && <Drop v={v} decide={decide} p={p} />}</div>
  );
}

function Drop({ v, decide, p }: { v: ItemView; decide: Decide; p: Deciding }) {
  const host = useHost();
  const text = useRef<HTMLTextAreaElement>(null);
  const d = v.detail!.data!;
  const pr = d.pr!;
  const n = v.files.pending.length;
  const me = host.me();
  const bot = d.ronin;
  // The text keeps the focus when it's asked for (opened, a suggestion added), its end selected.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [decide.focusText]);
  const err = p.error ? <p className="bad">{p.error}</p> : null;
  const footer = (keys: string, cls: string, label: string, disabled = false) => (
    <footer><span className="m"><kbd>{keys}</kbd> {p.kind === 'approve' ? 'confirma' : p.kind === 'close' ? 'cierra' : 'manda'} · <kbd>Esc</kbd></span><button className="btn-s" onClick={decide.close}>Cancelar</button><button className={`btn-s ${cls}`} disabled={p.sending || disabled} onClick={() => void decide.send()}>{label}</button></footer>
  );
  if (p.kind === 'approve') {
    const checks = checksChip(v.item.pr?.checks);
    const autoMerge = !pr.labels?.includes('ronin:auto-merge') && pr.mergeable !== 'CONFLICTING';
    const when = pr.mergeable === 'CONFLICTING' ? <>Tiene conflictos con {pr.baseRefName ?? 'la base'}: no se va a mergear hasta que se resuelvan.</>
      : checks?.[0] === 'crit' ? <><span className="crit">Un check falla: no se va a mergear hasta que pase.</span> Quizá conviene <b>Ajustar</b>.</>
        : checks?.[0] === 'run' ? 'ronin lo mergea apenas pasen los checks.' : 'ronin lo mergea en el próximo tick.';
    return (
      <div className="drop ok" role="dialog" aria-label="Aprobar y mergear"><div className="dt">Lo aprobás como <b>{me}</b>{autoMerge && <> y comentás <code>{`@${bot} /auto-merge`}</code> a tu nombre</>}. {when}
        {n > 0 && <p className="warnbox">{oneOr(n, 'Tu comentario', `Tus ${n} comentarios`)} de Archivos {n === 1 ? 'va' : 'van'} con la aprobación, pero ronin no {n === 1 ? 'lo atiende' : 'los atiende'}: para eso, <b>Ajustar</b>.</p>}</div>{err}
        {footer('↵', 'ok-solid', 'Aprobar y mergear')}</div>
    );
  }
  if (p.kind === 'close') {
    const issue = v.item.kind === 'issue' ? v.item.number : d.issue?.number;
    return (
      <div className="drop crit" role="dialog" aria-label="Cerrar el PR"><textarea id="dtext" ref={text} rows={3} placeholder="Por qué lo cerrás (opcional). Queda como comentario en el PR." value={p.text} onChange={(e) => decide.setP({ ...p, text: e.target.value })} />
        {d.pedido && issue !== undefined && <p className="help">Es el pedido P-{d.pedido.number} del portal: si cerrás también el issue, este motivo le llega a quien lo pidió, en el portal y por correo. Sin motivo, recibe el aviso de siempre.</p>}
        {issue !== undefined && <label className="dchk"><input type="checkbox" id="dissue" checked={p.closeIssue} onChange={(e) => decide.setP({ ...p, closeIssue: e.target.checked })} /><span>Cerrar también el issue #{issue} <kbd>I</kbd><small>Si queda abierto, ronin lo bloquea y avisa: se queda sin PR para seguir.</small></span></label>}{err}
        {footer('Ctrl ↵', 'danger-solid', 'Cerrar el PR')}</div>
    );
  }
  return (
    <div className="drop" role="dialog" aria-label="Pedir un ajuste"><textarea id="dtext" ref={text} rows={4} placeholder="¿Qué debería cambiar ronin?" value={p.text} onChange={(e) => decide.setP({ ...p, text: e.target.value })} />
      <div className="quick">{DECIDE_QUICK.map((q, i) => <button key={q} onClick={() => decide.addQuick(i)}><kbd>{i + 1}</kbd> {q}</button>)}</div>
      {n > 0 && <div className="carry">✎ Incluye {oneOr(n, 'tu comentario', `tus ${n} comentarios`)} de Archivos</div>}<p className="how">{n
        ? <>Se manda una revisión con {oneOr(n, 'tu comentario', `tus ${n} comentarios`)} y después <code>{`@${bot} /fix-comments`}</code> con este texto, a tu nombre.</>
        : <>Se comenta <code>{`@${bot}`}</code> y este texto en el PR, a tu nombre.</>}</p>{err}
      {footer('Ctrl ↵', 'primary', 'Mandar a ronin', !p.text.trim() && !n)}</div>
  );
}

// The keys of an open adjustment or closing, with the focus off its text:
// 1–3 a suggestion, I the issue's box, Ctrl ↵ sends. Any other key goes back
// to the text and is typed there, so nothing typed lands somewhere else.
// True when the key was its.
export function decideKey(event: KeyboardEvent, decide: Decide): boolean {
  const { p } = decide;
  const text = document.getElementById('dtext') as HTMLTextAreaElement | null;
  if (!p || p.kind === 'approve' || p.sending || !text) return false;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void decide.send();
    return true;
  }
  const at = document.activeElement;
  if (at === text || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return false;
  // A button or the box of the dropdown keep their space.
  if (event.key === ' ' && at?.closest('.drop')) return false;
  if (p.kind === 'adjust' && DECIDE_QUICK[Number(event.key) - 1]) {
    event.preventDefault();
    decide.addQuick(Number(event.key) - 1);
    return true;
  }
  if (p.kind === 'close' && event.key.toLowerCase() === 'i' && document.getElementById('dissue')) {
    event.preventDefault();
    decide.setP({ ...p, closeIssue: !p.closeIssue });
    return true;
  }
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
  return true;
}
