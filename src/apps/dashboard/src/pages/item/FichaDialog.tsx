import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api.js';
import { type ItemView, reread, useMarkdown, useSession, useShell } from '../../shell/hooks.js';
import { FICHA_ACTIONS, fichaCommentText, fichaStatus, postFichaComment, postPrDecision, useExploration, waitingCount, type FichaAsked, type FindingCard } from './fichas.js';

// A finding's dialog (#93: rechazar, pedir cambios, un issue aparte, una
// pregunta), and the two on the whole exploration PR the page's head opens
// (a general comment, finishing the review), with the comment as it will
// be written.

const Dot = ({ cls }: { cls: string }) => <span className={`dot ${cls}`} aria-hidden="true" />;
const Li = ({ f }: { f: FindingCard }) => <li><span className="id">{f.id}</span><span className="t">{f.titulo}</span></li>;

// What approving does, with what's left to look at: the findings that open
// an issue assigned to ronin, the rejected ones, those nobody decided on
// and those ronin is still applying a comment on (approving waits for them).
function ApproveSummary({ id }: { id: string }) {
  const { data } = useExploration(id, true);
  if (!data) return <p className="help">Leyendo las fichas…</p>;
  const status = (f: FindingCard) => fichaStatus(f, data.ronin, id);
  const keep = data.fichas.filter((f) => f.estado !== 'rechazado');
  const rejected = data.fichas.filter((f) => f.estado === 'rechazado');
  const undecided = data.fichas.filter((f) => status(f) === 'decidir');
  const waiting = data.fichas.filter((f) => status(f) === 'esperando');
  return (
    <div className="sum"><p className="sumh"><Dot cls="ok" />Abren su issue y ronin los empieza ({keep.length})</p>{keep.length > 0 && <ul>{keep.map((f) => <Li key={f.id} f={f} />)}</ul>}
      <p className="sumh"><Dot cls="crit" />Rechazadas, sin issue ({rejected.length})</p>{rejected.length > 0 && <ul>{rejected.map((f) => <Li key={f.id} f={f} />)}</ul>}
      {undecided.length > 0 && <p className="warnbox">{undecided.length === 1 ? 'Queda 1 ficha' : `Quedan ${undecided.length} fichas`} sin revisar ({undecided.map((f) => f.id).join(', ')}). Si finalizás, también abren su issue y ronin los empieza.</p>}
      {waiting.length > 0 && <p className="warnbox">ronin todavía está aplicando comentarios en {waiting.map((f) => f.id).join(', ')}. Finalizá cuando responda.</p>}
      <p className="help">Se envía como tu review <b>Approve</b> en GitHub. Con eso ronin marca las fichas, abre un issue por cada una que siga en pie, se lo asigna y mergea el PR. Cada issue arranca como uno asignado a mano.</p></div>
  );
}

// `busy`: whether it's sending, for the page's Escape (which closes it otherwise).
export function FichaDialog({ v, asked, close, busy }: { v: ItemView; asked: FichaAsked; close: () => void; busy: MutableRefObject<boolean> }) {
  const shell = useShell();
  const session = useSession();
  const markdown = useMarkdown();
  const queryClient = useQueryClient();
  const id = v.item.id;
  const pr = v.item.number;
  const meta = FICHA_ACTIONS[asked.action];
  const { data } = useExploration(id, true);
  const [text, setText] = useState('');
  const [redo, setRedo] = useState(Boolean(asked.redo));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  busy.current = sending;
  useEffect(() => area.current?.focus(), []);

  const typed = text.trim();
  const disabled = sending || (!meta.optional && !typed) || (asked.action === 'approve' && waitingCount(data, id) > 0);
  const send = async () => {
    if (busy.current || (!meta.optional && !typed)) return;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      if (meta.pr) {
        const what = asked.action as 'general' | 'approve';
        const done = await postPrDecision(id, what, typed);
        shell.toast(what === 'approve' ? `Finalizaste la revisión del PR #${pr}. ronin marca las fichas, abre sus issues y lo mergea.` : `Comentaste en el PR #${pr}. ronin lo va a aplicar y te responde ahí.`, done.url);
        reread(id);
      } else {
        const ficha = asked.ficha!;
        const done = await postFichaComment(id, ficha.key, asked.action, typed, redo);
        shell.toast(`Comentaste en ${ficha.key.split('/')[1]}. ronin lo va a aplicar y te responde en el hilo.`, done.url);
      }
      await queryClient.invalidateQueries({ queryKey: ['exploration', id] });
      busy.current = false;
      close();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      busy.current = false;
      setSending(false);
      setError(`No se pudo: ${(e as Error).message}`);
    }
  };
  const cancel = () => {
    if (!busy.current) close();
  };
  const me = session.me;
  const preview = asked.action === 'general' ? `@ronin-agent ${typed || '…'}` : fichaCommentText(asked.action, typed || '…', redo);

  return createPortal(
    <div id="flayer"><div className="scrim" onClick={(e) => {
      if ((e.target as HTMLElement).classList.contains('scrim')) cancel();
    }}><div className="dlg" role="dialog" aria-modal="true" aria-labelledby="fdlg-t">
      <p className="help">{meta.pr ? `PR #${pr}` : `${asked.ficha!.id} · ${asked.ficha!.titulo}`}</p>
      <h2 id="fdlg-t">{meta.title}</h2>
      {asked.action === 'approve' && <div id="fdlg-sum"><ApproveSummary id={id} /></div>}
      <label className="field"><span>{meta.field}</span><textarea id="fdlg-text" ref={area} rows={meta.optional ? 2 : 4} maxLength={4000} placeholder={meta.placeholder} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} /></label>
      {meta.quick && <div className="quick-r">{meta.quick.map((q) => <button key={q} className="pill" onClick={() => { setText(q); area.current?.focus(); }}>{q}</button>)}</div>}
      {meta.redo && <label className="check"><input type="checkbox" id="fdlg-redo" checked={redo} onChange={(e) => setRedo(e.target.checked)} /><span>Rehacer la captura del después<small>ronin levanta la app con el cambio borrador corregido y reemplaza la imagen. Tarda unos minutos.</small></span></label>}
      {asked.action !== 'approve' && <div className="prev"><div className="lbl">{asked.action === 'general' ? `Comentás como ${me} en el PR #${pr}` : `Comentás como ${me} en ${asked.ficha!.id}, en “Files changed” del PR #${pr}`}</div><div className="md" id="fdlg-prev" dangerouslySetInnerHTML={{ __html: markdown.html(preview, v.item.repo) }} /></div>}
      <p className="bad" id="fdlg-err" hidden={!error}>{error ?? ''}</p>
      <div className="foot-d"><span className="kbd-hint"><kbd>Ctrl</kbd> <kbd>Enter</kbd> para enviar</span><button className="btn-s" id="fdlg-no" onClick={cancel}>Cancelar</button><button className={`btn-s ${meta.cls === 'danger' ? 'danger-solid' : 'primary'}`} id="fdlg-yes" disabled={disabled} onClick={() => void send()}>{sending ? (asked.action === 'approve' ? 'Finalizando…' : 'Comentando…') : meta.btn}</button></div></div></div></div>,
    document.body,
  );
}
