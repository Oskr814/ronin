import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type Exploration } from '../../api.js';
import { fichaOf, type ItemView, showFicha, useSession, useShell } from '../../shell/hooks.js';
import { isMobile, when } from '../../lib/format.js';
import { Md } from '../../lib/markdown.js';
import { evidenceSrc } from '../../lib/md.js';
import { useViewState } from '../../lib/view-state.js';
import { short } from '../../../../../ui/time.js';
import { FICHA_DOT, FICHA_GROUPS, fichaKey, fichaStatus, postFichaComment, setLista, useExploration, visibleFichas, type FichaActionId, type FichaAsked, type FichaFilter, type FichaStatus, type FindingCard, type FindingImage } from './fichas.js';
import { Avatar } from './model.js';

// An exploration PR's Fichas tab (#93): the findings the PR brings, a list
// on the left and the finding on the right (one after the other on a
// phone), with its screenshots, its proposal and its thread.

const Dot = ({ cls }: { cls: string }) => <span className={`dot ${cls}`} aria-hidden="true" />;
const sevClass = (f: FindingCard) => (f.tipo === 'idea' ? 'pulido' : f.gravedad);
const sevLabel = (f: FindingCard) => (f.tipo === 'idea' ? 'idea' : f.gravedad);
const VP_ICON: Record<string, ReactElement> = {
  mobile: <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><rect x=".75" y=".75" width="8.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>,
  desktop: <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden="true"><rect x=".75" y=".75" width="11.5" height="7.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4 10.25h5" stroke="currentColor" strokeWidth="1.3" /></svg>,
};
const TALK_ICON = <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><path d="M1 1.5h9v6H4.5L2 9.8V7.5H1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
const Vp = ({ v }: { v: string }) => <span className="vp">{VP_ICON[v] ?? null}{v}</span>;

// Which screenshot of the before is shown, and whether the after shown is
// the one before ronin redid it, by finding; what's written in each
// finding's box. Kept while the person is elsewhere.
const drafts = new Map<string, string>();
type Shots = { antes: Record<string, number>; oldAfter: string[] };

// What the page asks of its Fichas tab: the keys it hands it (j, k, a, c, r).
export type FichaKeys = MutableRefObject<((key: string) => void) | null>;

export function Fichas({ v, ask, keys }: { v: ItemView; ask: (asked: FichaAsked) => void; keys: FichaKeys }) {
  const id = v.item.id;
  const { data, error } = useExploration(id, true);
  const [filter, setFilter] = useViewState<FichaFilter>('fichas:filter', { tipo: 'todas', vp: 'todos' });
  const [shots, setShots] = useViewState<Shots>('fichas:shots', { antes: {}, oldAfter: [] });
  const [sel, setSel] = useState(() => fichaOf(id));
  const [menu, setMenu] = useState(false);
  const [lightbox, setLightbox] = useState<{ ficha: string; antes: number; only: 'despues' | null } | null>(null);
  // A finding marked to approve (or not) changes its group: drawn again.
  const [, setMarks] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const picked = useRef(false);

  const shown = data ? visibleFichas(data, id, filter) : [];
  const f = data ? shown.find((x) => fichaKey(x) === sel.ficha) ?? data.fichas.find((x) => fichaKey(x) === sel.ficha) ?? shown[0] : undefined;

  // What was clicked in the tab lets go of the focus, as when the tab was
  // drawn again from scratch on each change.
  const letGo = () => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest('.doc.review') && el.tagName === 'BUTTON') el.blur();
  };
  const select = (key: string) => {
    letGo();
    showFicha(id, key, true);
    setSel({ ficha: key, open: true });
    picked.current = true;
  };
  // A finding picked starts at its top, its row in sight.
  useLayoutEffect(() => {
    if (!picked.current) return;
    picked.current = false;
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (isMobile()) scrollTo(0, 0);
    document.querySelector('.frow[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  // Another finding shown (picked, or the filters left the one before out) starts at its top.
  const current = f ? fichaKey(f) : '';
  const shownBefore = useRef(current);
  useLayoutEffect(() => {
    if (shownBefore.current === current) return;
    shownBefore.current = current;
    if (detailRef.current) detailRef.current.scrollTop = 0;
  });
  const move = (delta: number) => {
    if (!data?.fichas.length) return;
    const i = shown.findIndex((x) => f && fichaKey(x) === fichaKey(f));
    const next = shown[Math.max(0, Math.min(shown.length - 1, i + delta))];
    if (next) select(fichaKey(next));
  };
  const toggleLista = () => {
    if (!data || !f) return;
    const status = fichaStatus(f, data.ronin, id);
    if (status === 'esperando') return;
    letGo();
    setLista(id, fichaKey(f), status !== 'lista');
    setMarks((n) => n + 1);
    if (status === 'decidir') {
      // On to the next one still to decide.
      const next = visibleFichas(data, id, filter).find((x) => fichaStatus(x, data.ronin, id) === 'decidir');
      if (next) select(fichaKey(next));
    }
  };
  const act = (action: FichaActionId) => {
    if (!f) return;
    setMenu(false);
    ask({ action, ficha: { key: fichaKey(f), id: f.id, titulo: f.titulo } });
  };

  // The keys the page hands the tab: j/k go through the findings, a marks
  // one as looked at, c and r open the dialog (when its button is there).
  keys.current = (key) => {
    if (key === 'j' || key === 'k') move(key === 'j' ? 1 : -1);
    else if (key === 'a') toggleLista();
    else if (document.querySelector(`[data-fact="${key === 'c' ? 'cambios' : 'rechazar'}"]`)) act(key === 'c' ? 'cambios' : 'rechazar');
  };
  useEffect(() => () => { keys.current = null; }, [keys]);

  // The menu closes on a click elsewhere, or with Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!data) return <div className="doc" id="doc"><div className="empty">{error ? `No se pudieron leer las fichas: ${error.message}` : 'Leyendo las fichas…'}</div></div>;
  if (!data.fichas.length) return <div className="doc" id="doc"><div className="empty"><b>Este PR no trae fichas nuevas</b>{data.error ? data.error : 'Solo cambia el inventario o el registro de corridas.'}</div></div>;

  const reviewed = data.fichas.filter((x) => fichaStatus(x, data.ronin, id) !== 'decidir').length;
  const chip = (key: keyof FichaFilter, value: string, label: string) => <button className="fchip" aria-pressed={filter[key] === value} onClick={() => { letGo(); setFilter({ ...filter, [key]: value }); }}>{label}</button>;
  const groups = FICHA_GROUPS.map(([k, label]) => {
    const rows = shown.filter((x) => fichaStatus(x, data.ronin, id) === k);
    if (!rows.length) return null;
    return [<div className="fgrp" key={k}><span>{label}</span><span>{rows.length}</span></div>, ...rows.map((x) => (
      <button key={fichaKey(x)} className={`frow${k === 'rechazada' ? ' rej' : ''}`} aria-current={Boolean(f && fichaKey(x) === fichaKey(f))} onClick={() => select(fichaKey(x))}>
        <Dot cls={FICHA_DOT[k]} /><span className="tl">{x.titulo}</span>
        <span className="sub"><span className="id">{x.id}</span><span className={`sev ${sevClass(x)}`}>{sevLabel(x)}</span><Vp v={x.viewport} />{x.comments.length > 0 && <span className="vp">{TALK_ICON}{x.comments.length}</span>}</span></button>
    ))];
  }).filter(Boolean);
  const shotsOf = { antes: (key: string) => shots.antes[key] ?? 0, old: (key: string) => shots.oldAfter.includes(key) };
  return (
    <div className={`doc review${sel.open ? ' open' : ''}`} id="doc" data-key={`${id}:fichas`}>
      <div className="flist"><div className="fprog"><span className="fprog-bar"><i style={{ width: `${(reviewed / data.fichas.length) * 100}%` }} /></span>Revisadas {reviewed} de {data.fichas.length}</div>
        <div className="filters">{chip('tipo', 'todas', 'Todas')}{chip('tipo', 'hallazgo', 'Hallazgos')}{chip('tipo', 'idea', 'Ideas')}<span className="gap" />{chip('vp', 'todos', 'Todos')}{chip('vp', 'desktop', 'Desktop')}{chip('vp', 'mobile', 'Mobile')}</div>
        <div className="frows" id="frows">{groups.length ? groups : <p className="none">Ninguna ficha con esos filtros.</p>}</div>
        {data.runs.length > 0 && <div className="fruns">Corridas: {data.runs.map((run, i) => <span key={run.id}>{i > 0 && ', '}<a href={run.url} target="_blank" rel="noopener">{run.id}</a></span>)}</div>}</div>
      <div className="fdetail" id="fdetail" ref={detailRef} data-current={f ? fichaKey(f) : ''}>{f && (
        <Ficha v={v} data={data} f={f} shown={shown} menu={menu} setMenu={setMenu} act={act} toggleLista={toggleLista} move={move}
          back={() => { letGo(); showFicha(id, null, false); setSel({ ...sel, open: false }); }}
          antes={shotsOf.antes(fichaKey(f))} old={shotsOf.old(fichaKey(f))}
          setAntes={(k) => letGo() ?? setShots({ ...shots, antes: { ...shots.antes, [fichaKey(f)]: k } })}
          toggleOld={() => letGo() ?? setShots({ ...shots, oldAfter: shots.oldAfter.includes(fichaKey(f)) ? shots.oldAfter.filter((x) => x !== fichaKey(f)) : [...shots.oldAfter, fichaKey(f)] })}
          zoom={(only) => setLightbox({ ficha: fichaKey(f), antes: shots.antes[fichaKey(f)] ?? 0, only })} />
      )}</div>
      {lightbox && <Lightbox data={data} lb={lightbox} set={setLightbox} old={shotsOf.old(lightbox.ficha)} />}
    </div>
  );
}

function Ficha({ v, data, f, shown, menu, setMenu, act, toggleLista, move, back, antes, old, setAntes, toggleOld, zoom }: {
  v: ItemView; data: Exploration; f: FindingCard; shown: FindingCard[]; menu: boolean; setMenu: (open: boolean) => void;
  act: (action: FichaActionId) => void; toggleLista: () => void; move: (delta: number) => void; back: () => void;
  antes: number; old: boolean; setAntes: (k: number) => void; toggleOld: () => void; zoom: (only: 'despues' | null) => void;
}) {
  const { item } = v;
  const status = fichaStatus(f, data.ronin, item.id);
  const idx = shown.findIndex((x) => fichaKey(x) === fichaKey(f));
  // Who decided it in the review, and when (their GitHub login).
  const by = f.revisor ? <> <span className="m">por {f.revisor}{f.revisado ? `, hace ${short(Date.now() - Date.parse(f.revisado))}` : ''}</span></> : null;
  const banner = {
    rechazada: <div className="banner crit"><Dot cls="crit" /><div><b>Rechazada</b>{by}{f.motivo && <p>{f.motivo}</p>}</div></div>,
    aprobada: <div className="banner ok"><Dot cls="ok" /><div><b>Aprobada</b>{by}{f.issue ? <p>Issue <a href={`https://github.com/${item.repo}/issues/${f.issue}`} target="_blank" rel="noopener">#{f.issue}</a>.</p> : null}</div></div>,
    esperando: <div className="banner run"><Dot cls="live" /><div><b>Esperando a ronin</b><p>Hay un comentario que ronin todavía no respondió. Cuando lo aplique, su respuesta aparece abajo.</p></div></div>,
  }[status as 'rechazada' | 'aprobada' | 'esperando'] ?? null;
  const meta = [f.senal && f.senal !== f.gravedad && f.tipo !== 'idea' ? f.senal : '', `rol ${f.rol}`, f.functionName || f.funcion, f.entorno ? 'entorno de dev' : '', f.revisor && f.estado === 'propuesto' ? `editada por ${f.revisor}` : ''].filter(Boolean);
  const kinds = [...new Set(f.evidencia.map((e) => e.tipo))].join(', ');
  return (
    <div className="fwrap">
      <div className="fnav"><button className="pill fback" onClick={back}>← Fichas</button><Decisions status={status} menu={menu} setMenu={setMenu} act={act} toggleLista={toggleLista} /><span className="m">{idx >= 0 ? `${idx + 1} de ${shown.length}` : ''}</span>
        <button className="pill" disabled={idx <= 0} aria-label="Ficha anterior" onClick={() => move(-1)}>↑</button><button className="pill" disabled={idx < 0 || idx >= shown.length - 1} aria-label="Ficha siguiente" onClick={() => move(1)}>↓</button></div>
      <div className="fmeta"><span className="id">{f.id}</span><span className={`sev ${sevClass(f)}`}>{sevLabel(f)}</span><Vp v={f.viewport} />{meta.map((m, i) => <span key={i}>{m}</span>)}<a className="link fgh" href={f.url} target="_blank" rel="noopener">archivo ↗</a></div>
      <h2 className="ftitle">{f.titulo}</h2>
      {banner}
      {(f.observado || f.esperado) && <div className="obs">{f.observado && <div><h3>Qué pasa</h3><Md text={f.observado} repo={item.repo} /></div>}{f.esperado && <div className="exp"><h3>Qué se esperaba</h3><Md text={f.esperado} repo={item.repo} /></div>}</div>}
      <Compare f={f} antes={antes} old={old} setAntes={setAntes} toggleOld={toggleOld} zoom={zoom} />
      <div className="prop"><h3>Propuesta</h3><Md text={f.propuesta} repo={item.repo} /></div>
      {f.pasos.length > 0 && <details className="sec"><summary><h3>Cómo reproducirlo</h3><span className="m">{f.pasos.length} {f.pasos.length === 1 ? 'paso' : 'pasos'}</span></summary><ol className="in">{f.pasos.map((p, i) => <li key={i}>{p}</li>)}</ol></details>}
      {f.evidencia.length > 0 && <details className="sec"><summary><h3>Evidencia</h3><span className="m">{kinds}</span></summary><div className="in">{f.evidencia.map((e, i) => <div className="ev-row" key={i}><span className="k">{e.tipo}</span><span className="v">{e.detalle}</span></div>)}</div></details>}
      {f.parche && <details className="sec"><summary><h3>Cambio borrador del después</h3><span className="m">{diffStat(f.parche)}</span></summary><div className="in"><Diff patch={f.parche} /></div></details>}
      <Thread v={v} data={data} f={f} />
    </div>
  );
}

function Decisions({ status, menu, setMenu, act, toggleLista }: { status: FichaStatus; menu: boolean; setMenu: (open: boolean) => void; act: (action: FichaActionId) => void; toggleLista: () => void }) {
  if (status === 'rechazada' || status === 'aprobada') return null;
  const marked = status === 'lista';
  const button = (action: FichaActionId) => (e: React.MouseEvent) => {
    e.stopPropagation();
    act(action);
  };
  return (
    <span className="decide">{status !== 'esperando' && <button className="btn-s ok" data-flista aria-pressed={marked} title={marked ? 'Se aprueba cuando apruebes el PR. Clic para deshacer.' : 'Queda para aprobar: se aprueba cuando apruebes el PR.'} onClick={toggleLista}>{marked ? '✓ Para aprobar' : '✓ Aprobar'} <kbd>a</kbd></button>}
      <button className="btn-s" data-fact="cambios" onClick={button('cambios')}>Pedir cambios <kbd>c</kbd></button>
      <button className="btn-s danger" data-fact="rechazar" onClick={button('rechazar')}>Rechazar <kbd>r</kbd></button>
      <span className="actions"><button className="btn-s" id="fmore" aria-haspopup="menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>Más ▾</button>
        {menu && <div className="menu fmenu" role="menu">
          <button role="menuitem" data-fact="issue" onClick={button('issue')}><b>Pedir un issue aparte</b><small>Algo que surge de esta ficha pero no es su propuesta.</small></button>
          <button role="menuitem" data-fact="pregunta" onClick={button('pregunta')}><b>Preguntarle a ronin</b><small>Responde en el hilo, sin tocar la ficha.</small></button></div>}</span></span>
  );
}

// A screenshot ronin published, served from its clone; one that doesn't
// load leaves its label.
function Shot({ img, label, which, extra, zoom }: { img: FindingImage; label: string; which: 'antes' | 'despues'; extra?: React.ReactNode; zoom: () => void }) {
  const session = useSession();
  const local = evidenceSrc(session.repos, img.url);
  const text = `[imagen${img.nota ? `: ${img.nota}` : ''}]`;
  const [failed, setFailed] = useState(false);
  return (
    <figure className={`shot ${which === 'despues' ? 'after' : ''}`}><div className="lab"><b>{label}</b>{extra}</div>
      {local ? <button className="img" onClick={zoom}>{failed ? text : <img src={local} alt={img.nota ?? label} onError={() => setFailed(true)} />}</button>
        : <a className="img" href={img.url} target="_blank" rel="noopener noreferrer">{text}</a>}
      {img.nota && <figcaption>{img.nota}</figcaption>}</figure>
  );
}

function Thumb({ img, k, pressed, pick }: { img: FindingImage; k: number; pressed: boolean; pick: () => void }) {
  const session = useSession();
  const local = evidenceSrc(session.repos, img.url);
  const [failed, setFailed] = useState(false);
  return <button className="thumb" aria-pressed={pressed} title={img.nota ?? `Antes ${k + 1}`} onClick={pick}>{local && !failed ? <img src={local} alt="" onError={() => setFailed(true)} /> : k + 1}</button>;
}

function Compare({ f, antes, old: wantsOld, setAntes, toggleOld, zoom }: { f: FindingCard; antes: number; old: boolean; setAntes: (k: number) => void; toggleOld: () => void; zoom: (only: 'despues' | null) => void }) {
  const i = Math.min(antes, Math.max(0, f.antes.length - 1));
  const old = wantsOld && f.previousAfterImage;
  const after = f.despues && (old ? f.previousAfterImage : f.despues);
  const before = f.antes[i];
  if (!before && !after) return null;
  const cls = [f.viewport === 'desktop' ? 'wide' : '', before && after ? '' : 'one'].filter(Boolean).join(' ');
  return (
    <div className="compare"><div className="ctop"><h3>Antes y después</h3>{f.antes.length > 1 && <span className="thumbs">{f.antes.map((a, k) => <Thumb key={k} img={a} k={k} pressed={k === i} pick={() => setAntes(k)} />)}</span>}</div>
      <div className={`pair ${cls}`}>
        {before && <Shot img={before} label="Antes" which="antes" extra={f.antes.length > 1 ? <span>{i + 1} de {f.antes.length}</span> : undefined} zoom={() => zoom(null)} />}
        {after && <Shot img={after} label="Después" which="despues" extra={<>{old && <span>versión anterior</span>}{f.previousAfterImage && <button className="link tag" onClick={toggleOld}>{old ? 'ver la actual' : 'ver la anterior'}</button>}</>} zoom={() => zoom('despues')} />}</div>
      {!after && <p className="nodesp">Sin captura del después: ronin consideró que la propuesta se entiende sin ella.</p>}</div>
  );
}

function Diff({ patch }: { patch: string }) {
  return <pre className="diff">{patch.split('\n').map((l, i) => <span key={i} className={l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'd' : ''}>{l || ' '}</span>)}</pre>;
}
function diffStat(patch: string) {
  const lines = patch.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git')).length;
  return `+${lines.filter((l) => /^\+(?!\+\+)/.test(l)).length} −${lines.filter((l) => /^-(?!--)/.test(l)).length}${files ? ` · ${files} ${files === 1 ? 'archivo' : 'archivos'}` : ''}`;
}

// The finding's thread, and a box to comment on it, as on its file in
// "Files changed".
function Thread({ v, data, f }: { v: ItemView; data: Exploration; f: FindingCard }) {
  const shell = useShell();
  const session = useSession();
  const { item } = v;
  const key = fichaKey(f);
  const [text, setText] = useState(drafts.get(key) ?? '');
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(drafts.get(key) ?? ''), [key]);
  // A comment that comes in pushes the box down: it stays in sight while
  // it's being written in, as the focus put back on it did when the tab was
  // drawn again from scratch.
  const count = f.comments.length;
  useLayoutEffect(() => {
    const box = area.current;
    if (!box || document.activeElement !== box) return;
    box.blur();
    box.focus();
  }, [count]);
  const roots = f.comments.filter((c) => !c.replyTo || !f.comments.some((o) => o.id === c.replyTo));
  const ordered = roots.flatMap((root) => [root, ...f.comments.filter((c) => c.replyTo === root.id)]);
  const files = /^[\w.-]+\/[\w.-]+$/.test(item.repo) ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  const send = async () => {
    const said = text.trim();
    if (!said || sending) return area.current?.focus();
    setSending(true);
    try {
      const done = await postFichaComment(item.id, key, 'comentar', said, false);
      drafts.delete(key);
      setText('');
      shell.toast(`Comentaste en ${key.split('/')[1]}. ronin lo va a aplicar y te responde en el hilo.`, done.url);
      await queryClient.invalidateQueries({ queryKey: ['exploration', item.id] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      shell.toast(`No se pudo comentar: ${(e as Error).message}`);
    }
    setSending(false);
  };
  return (
    <div className="fthread"><h3>Conversación <span className="m">{f.comments.length ? `${f.comments.length} ${f.comments.length === 1 ? 'comentario' : 'comentarios'} en la ficha` : 'nadie comentó esta ficha'}</span></h3>
      {ordered.length > 0 && <div className="cms">{ordered.map((c) => (
        <article key={c.id} className={`cm${c.author === data.ronin ? ' bot' : ''}${c.replyTo ? ' reply' : ''}`}><header><Avatar login={c.author} /><b>{c.author}</b>{c.url ? <a href={c.url} target="_blank" rel="noopener">{when(c.createdAt)}</a> : <span>{when(c.createdAt)}</span>}</header><Md text={c.body} repo={item.repo} /></article>
      ))}</div>}
      <div className="composer"><textarea id="fcomment" ref={area} rows={3} maxLength={4000} placeholder="Comentar en la ficha… ronin lo lee como en GitHub: puede rechazarla, corregirla, abrir un issue o responder." value={text}
        onChange={(e) => { setText(e.target.value); drafts.set(key, e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} />
        <div className="cf"><span>Comentás como {session.me} sobre el archivo de la ficha{files && <>, en <a href={`${files}/files`} target="_blank" rel="noopener">“Files changed”</a></>}.</span><button className="btn-s" id="fcomment-send" disabled={sending} onClick={() => void send()}>{sending ? 'Comentando…' : 'Comentar'}</button></div></div></div>
  );
}

// The finding's screenshots in large: the before shown next to the after;
// ←/→ go through the befores. It has the keys while it's open.
function Lightbox({ data, lb, set, old }: { data: Exploration; lb: { ficha: string; antes: number; only: 'despues' | null }; set: (lb: { ficha: string; antes: number; only: 'despues' | null } | null) => void; old: boolean }) {
  const session = useSession();
  const f = data.fichas.find((x) => fichaKey(x) === lb.ficha);
  const live = useRef({ lb, f });
  live.current = { lb, f };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { lb, f } = live.current;
      event.stopPropagation();
      if (event.key === 'Escape') set(null);
      else if (event.key === 'ArrowRight' && f && lb.antes < f.antes.length - 1) set({ ...lb, antes: lb.antes + 1 });
      else if (event.key === 'ArrowLeft' && lb.antes > 0) set({ ...lb, antes: lb.antes - 1 });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [set]);
  if (!f) return null;
  const after = f.despues && (old && f.previousAfterImage ? f.previousAfterImage : f.despues);
  const before = f.antes[lb.antes];
  const shown: Array<[string, FindingImage | undefined]> = lb.only === 'despues' || !before ? [['Después', after]] : [[`Antes${f.antes.length > 1 ? ` ${lb.antes + 1} de ${f.antes.length}` : ''}`, before], ...(after ? [['Después', after] as [string, FindingImage]] : [])];
  return createPortal(
    <div id="lightbox" className="lightbox"><div className="lt"><b>{f.id}</b><span className="m">{f.titulo}</span>{f.antes.length > 1 && <span className="m keys"><kbd>←</kbd> <kbd>→</kbd> otra captura del antes</span>}<button id="lb-x" onClick={() => set(null)}>Cerrar ✕</button></div>
      <div className="lb">{shown.filter(([, img]) => img && evidenceSrc(session.repos, img.url)).map(([label, img]) => <figure key={label}><div><img src={evidenceSrc(session.repos, img!.url)!} alt={img!.nota ?? label} /></div><figcaption><b>{label}</b>{img!.nota ? ` · ${img!.nota}` : ''}</figcaption></figure>)}</div></div>,
    document.body,
  );
}
