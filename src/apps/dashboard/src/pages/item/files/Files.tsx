import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Fragment, useLayoutEffect, useReducer, useRef, type MutableRefObject } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useMarkdown, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { isMobile } from '@apps/dashboard/src/lib/format.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { itemParam, oneOr, type ItemPage } from '../model.js';
import { ReviewPanel, type Review } from '../Review.js';
import { BIG_DIFF_LINES, FILE_STATUS, fileAnchor, linesForSuggestion, pendingOf, threadsSeen, type PrFile } from './diff.js';
import { diffRows, DiffTable, FileThread, type Composing, type FilesCtx } from './Diff.js';
import { filesKey, rereadFiles, takeJump, type FilesRead } from './model.js';
import { clickTimer } from '@apps/dashboard/src/lib/click-timing.js';

// A PR's Archivos (#111): the files on the left, their diffs on the right,
// each review thread under the line it's on. Commenting, replying,
// resolving and "Viewed" are done as whoever is logged in, as in GitHub's
// "Files changed" (POST /files/actions).

// What the page's keys do in Archivos (j/k, v), and whether a comment is
// being written (Escape closes it).
export interface FilesKeys {
  move(step: 1 | -1): void;
  viewed(): void;
  composing(): boolean;
  closeComposer(): void;
}

// Unified or side by side, in this browser; a phone shows unified.
let mode: 'unified' | 'split' = 'unified';
try { mode = localStorage.getItem('ronin-diff-mode') === 'split' ? 'split' : 'unified'; } catch { /* sin storage */ }

// The files read whole for "show more lines", by item and path, at the head they were read at.
export interface Content { sha?: string; lines?: string[]; loading?: boolean; error?: string | null }
const contents = new Map<string, Content>();

const TALK = <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><path d="M1 1.5h9v6H4.5L2 9.8V7.5H1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;

export function Files({ v, q, review, keys }: { v: ItemPage; q: UseQueryResult<FilesRead>; review: Review; keys: MutableRefObject<FilesKeys | null> }) {
  const shell = useShell();
  const qc = useQueryClient();
  const key = v.item.id;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [cur, setCur] = useViewState<string | null>(`files:${key}:cur`, null);
  const [fold, setFold] = useViewState<Record<string, boolean>>(`files:${key}:fold`, {});
  const [exp, setExp] = useViewState<Record<string, Record<string, number>>>(`files:${key}:exp`, {});
  const [filter, setFilter] = useViewState(`files:${key}:q`, '');
  const [tree, setTree] = useViewState('files:tree', false);
  const [comp, setComp] = useViewState<Composing | null>(`files:${key}:comp`, null);
  const [busy, setBusy] = useViewState<string[]>(`files:${key}:busy`, []);
  const scrollTo = useRef<{ path: string; comment?: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const focusBox = useRef(false);
  const read = q.data;
  const data = read?.data;
  const viewed = new Set(read?.viewed ?? []);

  // A new head: the files read before are another version.
  for (const [k, c] of contents) if (k.startsWith(`${key}|`) && c.sha && data && c.sha !== data.headSha) contents.delete(k);

  const isFolded = (file: PrFile) => fold[file.path] ?? (viewed.has(file.path) || file.additions + file.deletions > BIG_DIFF_LINES);
  const go = (path: string, comment?: string) => {
    setCur(path);
    setTree(false);
    const file = data?.files.find((f) => f.path === path);
    if (file && isFolded(file) && !viewed.has(path)) setFold({ ...fold, [path]: false });
    scrollTo.current = { path, comment };
    redraw();
  };
  const jump = data && takeJump(key);
  if (jump) go(jump.path, jump.comment);
  useLayoutEffect(() => {
    const to = scrollTo.current;
    if (!to) return;
    scrollTo.current = null;
    document.getElementById(fileAnchor(to.path))?.scrollIntoView({ block: 'start' });
    if (to.comment) document.getElementById(`p-${to.comment}`)?.scrollIntoView({ block: 'center' });
  });
  // The composer takes the focus when it opens, the end of its text
  // selected, and still showing its start (a suggestion added below what was written).
  useLayoutEffect(() => {
    const el = box.current;
    if (!focusBox.current || !el) return;
    focusBox.current = false;
    const top = el.scrollTop;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = top;
  });

  const action = (body: Record<string, unknown>) => ok(client.api.items[':id'].files.actions.$post({ param: itemParam(key), json: body })) as Promise<{ url?: string }>;
  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      shell.unauthorized(e.message);
      return true;
    }
    return false;
  };
  const withBusy = async (id: string, run: () => Promise<void>) => {
    setBusy([...busy, id]);
    try {
      await run();
    } finally {
      setBusy(busy.filter((x) => x !== id));
    }
  };

  // "Viewed" shows at once and is undone if GitHub says no.
  const setViewed = async (path: string, on: boolean) => {
    if (!read) return;
    const mark = (yes: boolean) => qc.setQueryData<FilesRead>(filesKey(key), (old) => old && { ...old, viewed: yes ? [...old.viewed.filter((p) => p !== path), path] : old.viewed.filter((p) => p !== path) });
    mark(on);
    const { [path]: _, ...rest } = fold;
    setFold(rest);
    try {
      await action({ action: 'viewed', path, viewed: on });
    } catch (e) {
      if (failed(e)) return;
      mark(!on);
      shell.toast(`No se pudo marcar como visto: ${(e as Error).message}`);
    }
  };

  const openComposer = (spot: Omit<Composing, 'text' | 'preview'> & { text?: string }) => {
    // Re-opening on the same spot keeps what was written.
    const text = comp && !comp.sending && !comp.edit ? comp.text : '';
    setComp({ text, preview: false, ...spot });
    focusBox.current = true;
  };

  // `mode`: now (out at once), review (into the person's pending review, started if needed), edit (a pending one).
  const send = async (how?: 'now' | 'review' | 'edit') => {
    const c = comp;
    if (!c || c.sending || !data) return;
    const m = how ?? (c.edit ? 'edit' : 'review');
    if (!c.text.trim()) return setComp({ ...c, error: 'Escribí algo primero.' });
    const rev = m === 'review' ? { review: true } : {};
    const body = c.edit
      ? { action: 'pending-edit', commentId: c.edit, text: c.text }
      : c.reply
        ? { action: 'reply', commentId: c.commentId, text: c.text, ...rev }
        : { action: 'comment', path: c.path, commitId: data.headSha, subject: c.subject, text: c.text, ...rev, ...(c.subject === 'line' ? { side: c.side, line: c.line, ...(c.startLine ? { startLine: c.startLine } : {}) } : {}) };
    const started = m === 'review' && !read?.review;
    setComp({ ...c, sending: m, error: null });
    const shown = clickTimer('archivos');
    try {
      const posted = await action(body);
      setComp(null);
      if (m === 'now') shell.toast(c.reply ? 'Respondiste en el hilo.' : 'Comentaste en el PR.', posted?.url);
      else shell.toast(m === 'edit' ? 'Guardado en tu revisión.' : started ? `Empezaste una revisión: nadie la ve hasta que la mandes${v.decidable ? ' con Ajustar' : ''}.` : 'Sumado a tu revisión.');
      shown(rereadFiles(qc, shell, key));
    } catch (e) {
      if (failed(e)) return;
      setComp({ ...c, sending: false, error: `No se pudo: ${(e as Error).message}` });
    }
  };

  const resolve = (threadId: string, resolved: boolean) => withBusy(threadId, async () => {
    const shown = clickTimer('archivos');
    try {
      await action({ action: 'resolve', threadId, resolved });
      shell.toast(resolved ? 'Conversación resuelta.' : 'Conversación reabierta.');
      shown(rereadFiles(qc, shell, key));
    } catch (e) {
      if (!failed(e)) shell.toast(`No se pudo: ${(e as Error).message}`);
    }
  });
  const deletePending = (nodeId: string) => withBusy(nodeId, async () => {
    try {
      await action({ action: 'pending-delete', commentId: nodeId });
      shell.toast('Borrado de tu revisión.');
      rereadFiles(qc, shell, key);
    } catch (e) {
      if (!failed(e)) shell.toast(`No se pudo: ${(e as Error).message}`);
    }
  });

  // "Show more lines": the file at the PR's head is read the first time, then
  // each click opens MORE_LINES more.
  const showMore = async (path: string, at: string, more: number) => {
    const opened = { ...exp, [path]: { ...exp[path], [at]: (exp[path]?.[at] ?? 0) + more } };
    setExp(opened);
    const ck = `${key}|${path}`;
    const content = contents.get(ck) ?? {};
    contents.set(ck, content);
    if (content.lines || content.loading) return;
    content.loading = true;
    content.error = null;
    redraw();
    try {
      const got = await ok(client.api.items[':id'].files.content.$get({ param: itemParam(key), query: { path } })) as { sha: string; text: string };
      content.sha = got.sha;
      content.lines = got.text.split('\n');
      if (content.lines[content.lines.length - 1] === '') content.lines.pop();
    } catch (e) {
      if (failed(e)) return;
      content.error = (e as Error).message;
      setExp({ ...opened, [path]: { ...opened[path], [at]: opened[path][at] - more } });
    } finally {
      content.loading = false;
    }
    redraw();
  };

  const files = data?.files ?? [];
  const shown = cur ?? files[0]?.path;
  keys.current = {
    // j/k: the next file or the one before.
    move(step) {
      if (!files.length) return;
      const i = files.findIndex((f) => f.path === shown);
      go(files[Math.max(0, Math.min(files.length - 1, i + step))].path);
    },
    // v: the file in view goes viewed (or back), and the next one not viewed comes up.
    viewed() {
      if (!files.length || !shown) return;
      const now = !viewed.has(shown);
      void setViewed(shown, now);
      if (now) viewed.add(shown);
      const next = now && files.find((f) => !viewed.has(f.path));
      if (next) go(next.path);
    },
    composing: () => Boolean(comp),
    closeComposer() {
      if (comp && !comp.sending) setComp(null);
    },
  };

  if (!data) return <div className="doc" id="doc"><div className="empty">{q.error ? `No se pudieron leer los archivos: ${q.error.message}` : 'Leyendo los archivos de GitHub…'}</div></div>;
  if (!files.length) return <div className="doc" id="doc"><div className="empty">{data.error ? `GitHub no respondió: ${data.error}` : <b>Este PR no cambia ningún archivo</b>}</div></div>;

  const review0 = read?.review ?? null;
  const pending = pendingOf(review0);
  const open = (path: string) => data.threads.filter((t) => t.path === path && !t.isResolved).length;
  const pendingIn = (path: string) => pending.filter((x) => x.t.path === path).length;
  const lower = filter.toLowerCase();
  const byDir = new Map<string, PrFile[]>();
  for (const f of files.filter((x) => !lower || x.path.toLowerCase().includes(lower))) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }
  const rows = [...byDir].map(([dir, list]) => <Fragment key={dir}>{dir && <div className="fdir" title={dir}><bdi>{dir}/</bdi></div>}{list.map((f) => {
    const talk = open(f.path);
    const seen = viewed.has(f.path);
    const pd = pendingIn(f.path);
    return <button key={f.path} className={`ffile${seen ? ' seen' : ''}`} aria-current={f.path === shown} onClick={() => go(f.path)}><span className={`fst ${f.status}`} title={f.status}>{FILE_STATUS[f.status] ?? '?'}</span><span className="nm">{f.path.split('/').pop()}</span>{pd > 0 && <span className="pd" title={`${pd} en tu revisión`}>✎{pd}</span>}{talk > 0 && <span className="talk" title={`${talk} sin resolver`}>{TALK}{talk}</span>}{seen ? <span className="ck" title="Visto">✓</span> : <span className="addel"><span className="a">+{f.additions}</span> <span className="d">−{f.deletions}</span></span>}</button>;
  })}</Fragment>);
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const url = /^[\w.-]+\/[\w.-]+$/.test(v.item.repo) && data.pr ? `https://github.com/${v.item.repo}/pull/${data.pr}` : null;
  const setMode = (m: 'unified' | 'split') => {
    mode = m;
    try { localStorage.setItem('ronin-diff-mode', m); } catch { /* sin storage */ }
    redraw();
  };
  const seenCount = files.filter((f) => viewed.has(f.path)).length;
  const reviewOpen = review.p?.at === 'files';
  const rwrap = (button: React.ReactNode) => <div className="actions rwrap">{button}<div className="rpanel-slot">{reviewOpen && <ReviewPanel v={v} review={review} />}</div></div>;
  const openReview = (e: React.MouseEvent) => {
    e.stopPropagation();
    review.open('files');
  };
  const carry = v.decidable
    ? pending.length > 0 && <span className="m dcarry">{oneOr(pending.length, 'Un comentario', `${pending.length} comentarios`)} para ronin: los lleva <b>Ajustar</b> <kbd>P</kbd></span>
    : review0 ? rwrap(<button className="btn-s primary frevb" aria-haspopup="dialog" aria-expanded={reviewOpen} onClick={openReview}>Terminar revisión <span className="rn">{pending.length}</span> ▾</button>)
      : v.reviewable && rwrap(<button className="btn-s frevb" aria-haspopup="dialog" aria-expanded={reviewOpen} onClick={openReview}>Revisar ▾</button>);
  const ctx: FilesCtx = {
    item: v.item,
    data,
    ronin: v.detail?.data?.ronin,
    review: review0,
    comp,
    box,
    busy: new Set(busy),
    split: (isMobile() ? 'unified' : mode) === 'split',
    contents,
    exp,
    setComp,
    openComposer,
    focus: () => { focusBox.current = true; },
    send,
    resolve,
    deletePending,
    showMore,
    suggest() {
      const c = comp;
      const file = c && files.find((f) => f.path === c.path);
      if (!c || !file || c.line === undefined) return;
      setComp({ ...c, text: `${c.text.trim() ? `${c.text.replace(/\s+$/, '')}\n\n` : ''}\`\`\`suggestion\n${linesForSuggestion(file, { line: c.line, startLine: c.startLine }).join('\n')}\n\`\`\`\n`, preview: false });
      focusBox.current = true;
    },
  };
  // The file in view is the one marked in the tree.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const diffs = e.currentTarget;
    const top = diffs.getBoundingClientRect().top + 48;
    let at: string | null = null;
    for (const card of diffs.querySelectorAll<HTMLElement>('.fcard')) if (card.getBoundingClientRect().top <= top) at = card.dataset.file ?? null;
    if (at && at !== shown) setCur(at);
  };
  return (
    <div className={`doc files${tree ? ' tree' : ''}`} id="doc" data-key={`${key}:files`}>
      <div className="ftree"><div className="ftop"><input type="search" id="fq" placeholder="Filtrar archivos" value={filter} aria-label="Filtrar archivos" onChange={(e) => setFilter(e.target.value)} /><button className="btn-s ftreex" onClick={() => setTree(!tree)}>Cerrar</button></div>
        <div className="fseen"><span className="fprog-bar"><i style={{ width: `${(seenCount / files.length) * 100}%` }} /></span>{seenCount} de {files.length} vistos</div>
        <div className="frows" id="ftrows">{rows.length ? rows : <p className="none">Ningún archivo coincide.</p>}</div></div>
      <div className="fdiffs" id="fdiffs" onScroll={onScroll}>
        <div className="ftool"><button className="btn-s ftreebtn" onClick={() => setTree(!tree)}>Archivos ▾</button><span className="seg"><button aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>Unificado</button><button aria-pressed={mode === 'split'} onClick={() => setMode('split')}>Lado a lado</button></span>
          <span>{files.length} {files.length === 1 ? 'archivo' : 'archivos'} · <span className="addel"><span className="a">+{add}</span> <span className="d">−{del}</span></span></span>{data.error && <span className="bad">GitHub no respondió: {data.error}</span>}
          <span className="m hint-c">Clic en un número de línea para comentarla</span>{carry}{url && <a className="gh" href={`${url}/files`} target="_blank" rel="noopener">En GitHub ↗</a>}</div>
        <div className="fcards">{files.map((f) => <FileCard key={f.path} ctx={ctx} file={f} folded={isFolded(f)} seen={viewed.has(f.path)} explicit={fold[f.path] !== undefined}
          toggle={() => setFold({ ...fold, [f.path]: !isFolded(f) })} setViewed={(on) => void setViewed(f.path, on)} />)}</div></div>
    </div>
  );
}

function FileCard({ ctx, file, folded, seen, explicit, toggle, setViewed }: { ctx: FilesCtx; file: PrFile; folded: boolean; seen: boolean; explicit: boolean; toggle: () => void; setViewed: (on: boolean) => void }) {
  const parts = file.path.split('/');
  const name = parts.pop();
  const own = threadsSeen(ctx.data.threads, ctx.review, file.path);
  const c = ctx.comp;
  const header = <header><button className="fold" aria-expanded={!folded} aria-label={folded ? 'Abrir' : 'Plegar'} onClick={toggle}>{folded ? '▸' : '▾'}</button>
    <span className="p" title={file.path}>{file.previousPath && <span>{file.previousPath} → </span>}<span>{parts.length ? `${parts.join('/')}/` : ''}</span><b>{name}</b></span>
    <span className="addel"><span className="a">+{file.additions}</span> <span className="d">−{file.deletions}</span></span>
    <button className="btn-s fcfile" title="Comentar el archivo entero" onClick={() => ctx.openComposer({ path: file.path, subject: 'file' })}>Comentar archivo</button>
    <label className={`fviewed${seen ? ' on' : ''}`}><input type="checkbox" checked={seen} onChange={(e) => setViewed(e.target.checked)} /> Visto</label></header>;
  const comp = c && c.path === file.path && c.subject === 'file' ? <Composer ctx={ctx} file={file} /> : null;
  if (folded) {
    const big = !seen && file.additions + file.deletions > BIG_DIFF_LINES && !explicit;
    return <section className="fcard folded" id={fileAnchor(file.path)} data-file={file.path}>{header}{comp && <div className="ftop-threads">{comp}</div>}{big && <button className="fbig" onClick={toggle}>Diff grande ({file.additions + file.deletions} líneas): abrirlo</button>}</section>;
  }
  const body = file.patch ? diffRows(ctx, file, own) : null;
  // On top: what's about the whole file, and what's on lines no longer in the diff.
  const top = own.filter((t) => !body?.placed.has(t));
  const above = top.length > 0 || comp;
  return <section className="fcard" id={fileAnchor(file.path)} data-file={file.path}>{header}{above && <div className="ftop-threads">{top.map((t) => <FileThread key={t.url} ctx={ctx} t={t} Composer={Composer} />)}{comp}</div>}{body
    ? <DiffTable ctx={ctx} file={file} rows={body.rows} Composer={Composer} />
    : <p className="nodiff">GitHub no muestra el diff de este archivo{file.status === 'renamed' && !file.additions && !file.deletions ? ': solo se renombró' : ' (binario o demasiado grande)'}.</p>}</section>;
}

// Writing a comment: on a line or a range, on the file, a reply, or editing a pending one.
function Composer({ ctx, file }: { ctx: FilesCtx; file: PrFile | null }) {
  const session = useSession();
  const markdown = useMarkdown();
  const c = ctx.comp!;
  const where = c.reply || c.edit ? '' : c.subject === 'file' ? 'el archivo entero' : c.startLine ? `líneas ${c.startLine}–${c.line}${c.side === 'LEFT' ? ' (versión anterior)' : ''}` : `línea ${c.line}${c.side === 'LEFT' ? ' (versión anterior)' : ''}`;
  const canSuggest = !c.reply && !c.edit && c.subject === 'line' && c.side === 'RIGHT' && file;
  const send = (m: 'now' | 'review' | 'edit', label: string, primary: boolean) => <button className={`btn-s${primary ? ' primary' : ''}`} disabled={Boolean(c.sending)} onClick={() => void ctx.send(m)}>{c.sending === m ? 'Enviando…' : label}</button>;
  // As in GitHub: once a review is started, what's written goes into it.
  const buttons = c.edit
    ? send('edit', 'Guardar', true)
    : ctx.review
      ? send('review', 'Sumar a la revisión', true)
      : <>{send('now', c.reply ? 'Responder ya' : 'Comentar ya', false)}{send('review', 'Empezar una revisión', true)}</>;
  return (
    <div className="dcomp"><div className="dct"><button className="dtb" aria-selected={!c.preview} onClick={() => { ctx.setComp({ ...c, preview: false }); ctx.focus(); }}>Escribir</button><button className="dtb" aria-selected={Boolean(c.preview)} onClick={() => ctx.setComp({ ...c, preview: true })}>Vista previa</button>{canSuggest && <button className="dtool" title="Proponer el código que va en esas líneas" onClick={ctx.suggest}>± Sugerir cambio</button>}<span className="where">{where}</span></div>
      {c.preview
        ? <div className="dpv md" dangerouslySetInnerHTML={{ __html: c.text.trim() ? markdown.html(c.text, ctx.item.repo) : '<p class="m">Nada para mostrar.</p>' }} />
        : <textarea id="fcbox" ref={ctx.box} rows={4} placeholder={`${c.reply ? 'Respuesta' : 'Comentario'} (markdown). Ctrl+Enter ${c.edit ? 'lo guarda' : ctx.review ? 'lo suma a tu revisión' : 'empieza una revisión'}.`} value={c.text}
          onChange={(e) => ctx.setComp({ ...c, text: e.target.value })} onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ctx.send();
            if (e.key === 'Escape') {
              e.stopPropagation();
              ctx.setComp(null);
            }
          }} />}
      <div className="dfoot">{c.error ? <span className="bad">{c.error}</span> : <span className="m">{c.reply ? '' : c.subject === 'line' ? 'Shift+clic en otro número para elegir varias líneas. ' : ''}Comentás como {session.me}.</span>}<button className="btn-s" onClick={() => ctx.setComp(null)}>Cancelar</button>{buttons}</div></div>
  );
}
