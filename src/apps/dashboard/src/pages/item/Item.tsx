import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { shellLayer, showDoc, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { short } from '@ui/time.js';
import { Skeleton } from '@apps/dashboard/src/lib/runs.js';
import { ExplorationInventory } from '../explorations/Inventory.js';
import { ExplorationRuns } from '../explorations/Runs.js';
import { ActionDialog, ActionsMenu, menuKey, type Asked } from './Actions.js';
import { decideKey, useDecide, type DecideKind } from './Decide.js';
import { DocPage } from './Doc.js';
import { Files, type FilesKeys } from './files/Files.js';
import { useFiles, type FilesRead } from './files/model.js';
import { FichaDialog } from './FichaDialog.js';
import { Fichas, type FichaKeys } from './Fichas.js';
import { useExploration, type FichaAsked } from './fichas.js';
import { Head } from './Head.js';
import { KEY_SEQ_MS, markUnit, moveUnit } from './Keys.js';
import { useItem, type Action, type ItemPage } from './model.js';
import { Questions } from './Questions.js';
import { useReview, type Review } from './Review.js';
import { Activity, History, Transcript } from './Runs.js';

// An item's page (#85): an issue's or a PR's, with its head, its activity
// and its tabs (the issue, the PR, Archivos; an exploration PR's Fichas,
// Corridas and Inventario), or a run's transcript. What's read of the item
// (useItem) is in the cache the shell reads too; the page draws all of it,
// and has the keys while it's open.

// Where j/k is, per tab of an item: kept while the person is elsewhere.
let kunit: { key: string; i: number } | null = null;

function DocBar({ v }: { v: ItemPage }) {
  const shell = useShell();
  const session = useSession();
  const d = v.detail!.data!;
  const fichas = useExploration(v.item.id, Boolean(d.exploration)).data?.fichas.length ?? null;
  const cur = v.doc;
  const count = (k: string) => {
    const doc = k === 'issue' ? d.issue : k === 'pr' ? d.pr : undefined;
    return doc ? doc.comments.length + (doc.reviews?.length ?? 0) + (doc.threads?.length ?? 0) : 0;
  };
  // The conversation's size; how many findings or files, once read.
  const counter = (k: string) => {
    const n = k === 'issue' || k === 'pr' ? count(k) || null : k === 'fichas' ? fichas : k === 'files' ? v.files.data?.count ?? null : null;
    return n === null ? null : <span className="c">{n}</span>;
  };
  const hint = cur === 'fichas' ? <><kbd>j</kbd> <kbd>k</kbd> otra ficha</>
    : cur === 'files' ? <><kbd>j</kbd> <kbd>k</kbd> otro archivo · <kbd>v</kbd> visto{v.decidable ? '' : <> · <kbd>r</kbd> revisión</>}</>
      : <><kbd>j</kbd> <kbd>k</kbd> sección o comentario{session.can(v.item.repo, 'acciones') && <> · <kbd>c</kbd> comentar</>}</>;
  return (
    <div className="doctabs" role="tablist">{v.tabs.map(([k, label]) => <button key={k} className="doctab" role="tab" aria-selected={k === cur} onClick={() => showDoc(v.item.id, k)}>{label}{counter(k)}</button>)}
      <span className="keys"><kbd>1</kbd>–<kbd>{v.tabs.length}</kbd> pestaña · {hint} <button className="kh" title="Atajos (?)" aria-label="Atajos" onClick={() => shell.keysHelp()}>?</button></span><span className="src">{d.error && <><span className="bad">GitHub no respondió: {d.error}</span>, </>}{d.fetchedAt ? `leído hace ${short(Date.now() - Date.parse(d.fetchedAt))}` : ''}</span></div>
  );
}

function Tab({ v, files, review, keys, ask, fichaKeys }: { v: ItemPage; files: UseQueryResult<FilesRead>; review: Review; keys: MutableRefObject<FilesKeys | null>; ask: (asked: FichaAsked) => void; fichaKeys: FichaKeys }) {
  const d = v.detail?.data;
  if (!d) return <div className="doc" id="doc">{v.detail?.error ? <div className="empty">No se pudo leer de GitHub: {v.detail.error}</div> : <Skeleton kind="ficha" label="Cargando de GitHub…" />}</div>;
  const cur = v.doc!;
  let body;
  if (cur === 'files') body = <Files key={cur} v={v} q={files} review={review} keys={keys} />;
  else if (cur === 'fichas') body = <Fichas key={cur} v={v} ask={ask} keys={fichaKeys} />;
  else if ((cur === 'corridas' || cur === 'inventario') && v.exploration) {
    const { repo, app } = v.exploration;
    body = <div className="doc" id="doc" key={cur}><div className="xpl-doc">{cur === 'corridas' ? <ExplorationRuns repo={repo} app={app} /> : <ExplorationInventory repo={repo} app={app} />}</div></div>;
  } else body = <div className="doc" id="doc" key={cur}><DocPage item={v.item} d={d} tab={cur === 'issue' ? 'issue' : 'pr'} /></div>;
  return <><DocBar v={v} />{body}</>;
}

export function Item({ id }: { id: string }) {
  const shell = useShell();
  const session = useSession();
  const view = useItem(id);
  // Archivos is read when shown, or when the review panel or Ajustar ask.
  const files = useFiles(id, view?.view === 'ficha' && view.doc === 'files');
  const v: ItemPage | null = view && { ...view, files: files.view };
  const filesKeys = useRef<FilesKeys | null>(null);
  const [menu, setMenu] = useState(false);
  const menuFocus = useRef(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const dialogBusy = useRef(false);
  // An exploration PR's dialog (a finding's, or the whole PR's), and the
  // keys its Fichas tab takes.
  const [fasked, setFasked] = useState<FichaAsked | null>(null);
  const fichaBusy = useRef(false);
  const fichaKeys: FichaKeys = useRef(null);
  const decide = useDecide(v);
  const review = useReview(v);
  const seq = useRef<{ key: string | null; timer: number }>({ key: null, timer: 0 });

  const pick = (action: Action) => {
    setMenu(false);
    setAsked({ item: id, action });
  };
  const toggleMenu = () => {
    menuFocus.current = true;
    setMenu((open) => !open);
  };

  // The menu opened from the keyboard starts on its first action; closed, on its button.
  useLayoutEffect(() => {
    if (!menuFocus.current) return;
    menuFocus.current = false;
    (menu ? document.querySelector<HTMLElement>('.menu [data-action]') : document.getElementById('act'))?.focus();
  }, [menu]);
  // The unit j/k is on, marked again after each draw.
  useLayoutEffect(() => markUnit(v?.doc ?? null, kunit, `${id}:${v?.doc ?? ''}`));

  // The keys, before the shell's (which has what it opens on top): what
  // the page takes doesn't reach the shell.
  const live = useRef({ v, menu, asked, decide, review, fasked });
  live.current = { v, menu, asked, decide, review, fasked };
  useEffect(() => {
    const navigate = (event: KeyboardEvent, v: ItemPage): boolean => {
      const prev = seq.current.key;
      seq.current.key = null;
      clearTimeout(seq.current.timer);
      if ((prev === ']' || prev === '[') && event.key === 'p') {
        event.preventDefault();
        shell.movePr(prev === ']' ? 1 : -1);
        return true;
      }
      const wait = (key: string) => {
        seq.current.key = key;
        seq.current.timer = window.setTimeout(() => { seq.current.key = null; }, KEY_SEQ_MS);
        return true;
      };
      if (event.key === ']' || event.key === '[') return wait(event.key);
      const d = v.detail?.data;
      if (!d || v.item.kind === 'other' || v.view !== 'ficha') return false;
      const tab = v.doc ?? '';
      const scroller = document.getElementById(tab === 'files' ? 'fdiffs' : 'doc');
      if (prev === 'g' && event.key === 'g') {
        event.preventDefault();
        scroller?.scrollTo({ top: 0 });
        return true;
      }
      if (event.key === 'g') return wait('g');
      if (event.key === 'G') {
        event.preventDefault();
        scroller?.scrollTo({ top: scroller.scrollHeight });
        return true;
      }
      if (event.key === 'd' || event.key === 'u') {
        event.preventDefault();
        scroller?.scrollBy({ top: ((event.key === 'd' ? 1 : -1) * scroller.clientHeight) / 2 });
        return true;
      }
      if (/^[1-9]$/.test(event.key) && v.tabs[Number(event.key) - 1]) {
        event.preventDefault();
        showDoc(v.item.id, v.tabs[Number(event.key) - 1][0]);
        return true;
      }
      // c: the box under the issue's or the PR's conversation.
      const box = document.getElementById('dcomment');
      if (event.key === 'c' && (tab === 'issue' || tab === 'pr') && box) {
        event.preventDefault();
        box.focus();
        return true;
      }
      if ((event.key === 'j' || event.key === 'k') && tab !== 'files' && tab !== 'fichas') {
        event.preventDefault();
        kunit = moveUnit(tab, `${v.item.id}:${tab}`, kunit, event.key === 'j' ? 1 : -1);
        return true;
      }
      return false;
    };
    const onKey = (event: KeyboardEvent) => {
      const { v, menu, asked, decide, review, fasked } = live.current;
      if (!v || document.getElementById('keys-help')) return;
      if (shellLayer()) return;
      const taken = () => event.stopPropagation();
      // A finding's dialog: Escape closes it, unless it's sending; its text has the rest.
      if (fasked) {
        if (event.key !== 'Escape') return;
        if (!fichaBusy.current) setFasked(null);
        return taken();
      }
      const typing = event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      const page = v.view === 'ficha';
      // An open adjustment or closing first: what's typed is for its text.
      if (!asked && decideKey(event, decide)) return taken();
      // The Actions menu: M opens it, and while it's open its keys come first.
      const free = !typing && !asked && !decide.p && !review.p;
      if (free && menu && menuKey(event, (action) => {
        const found = v.detail?.data?.actions?.find((a) => a.id === action);
        if (found) pick(found);
      }, toggleMenu)) return taken();
      if (free && !menu && event.key.toLowerCase() === 'm' && document.getElementById('act')) {
        event.preventDefault();
        toggleMenu();
        return taken();
      }
      // Archivos' r opens the review under its toolbar (#111); j and k go
      // from one file to the next, v marks it as viewed.
      const inFiles = page && v.doc === 'files';
      if (!typing && !asked && inFiles && !v.decidable && event.key === 'r') {
        event.preventDefault();
        review.open('files');
        return taken();
      }
      if (!typing && !asked && !decide.p && !menu && inFiles && ['j', 'k', 'v'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'v') filesKeys.current?.viewed();
        else filesKeys.current?.move(event.key === 'j' ? 1 : -1);
        return taken();
      }
      const composing = Boolean(inFiles && filesKeys.current?.composing());
      // On a PR ronin opened: A, P and X decide (#195); Enter confirms an approval.
      const deciding = !typing && !asked && !review.p && v.decidable;
      if (deciding && event.key === 'Enter' && decide.p?.kind === 'approve') {
        event.preventDefault();
        void decide.send();
        return taken();
      }
      const kind = ({ a: 'approve', p: 'adjust', x: 'close' } as Record<string, DecideKind>)[event.key.toLowerCase()];
      if (deciding && kind && !seq.current.key && !decide.p?.sending) {
        event.preventDefault();
        setMenu(false);
        review.close();
        decide.open(kind);
        return taken();
      }
      // On an exploration PR's findings: j/k go through them, a marks one as
      // looked at, c and r open its dialog (#93).
      if (page && v.doc === 'fichas' && !typing && !asked && !menu && !decide.p && ['j', 'k', 'a', 'c', 'r'].includes(event.key)) {
        event.preventDefault();
        fichaKeys.current?.(event.key);
        return taken();
      }
      // ? is the shell's (the whole dashboard's).
      if (event.key === '?') return asked && !typing ? taken() : undefined;
      if (!typing && !asked && !decide.p && !review.p && !composing && navigate(event, v)) return taken();
      if (event.key !== 'Escape') return;
      if (decide.p && !decide.p.sending) {
        decide.close();
        return taken();
      }
      if (review.p && !review.p.sending) {
        review.close();
        return taken();
      }
      // A comment being written in Archivos closes, unless it's being sent.
      if (composing) {
        filesKeys.current?.closeComposer();
        return taken();
      }
      if (asked) {
        if (!dialogBusy.current) setAsked(null);
        return taken();
      }
      if (menu) {
        menuFocus.current = true;
        setMenu(false);
        return taken();
      }
    };
    // A click outside the review panel, the decision's dropdown or the menu closes it.
    const onClick = (event: MouseEvent) => {
      const { menu, decide, review } = live.current;
      const target = event.target as Element;
      if (review.p && !review.p.sending && target.isConnected && !target.closest('.rpanel')) {
        review.close();
        setMenu(false);
        return;
      }
      if (decide.p && !decide.p.sending && target.isConnected && !target.closest('.drop')) {
        decide.close();
        return;
      }
      if (menu) setMenu(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onClick);
    };
  }, [shell]);

  if (!v) return null;
  if (v.view === 'history') return <History v={v} />;
  if (v.view === 'tx') return <Transcript v={v} />;
  const actions = v.detail?.data?.actions;
  const menuEl = actions?.length && session.can(v.item.repo, 'acciones') ? <ActionsMenu actions={actions} open={menu} setOpen={setMenu} pick={pick} /> : null;
  return <>
    <Head v={v} actions={menuEl} decide={decide} review={review} explore={(action) => setFasked({ action })} />
    <Activity v={v} />
    <Questions key={id} v={v} />
    {v.item.kind !== 'other' && <Tab v={v} files={files.q} review={review} keys={filesKeys} ask={setFasked} fichaKeys={fichaKeys} />}
    {asked && <ActionDialog key={asked.retry ? `retry:${asked.retry.error}` : 'ask'} v={v} asked={asked} busy={dialogBusy} close={() => setAsked(null)} reopen={(again) => {
      // Only on the item it was about: elsewhere, the toast says it.
      if (live.current.v?.item.id === again.item) setAsked(again);
    }} />}
    {fasked && <FichaDialog key={`${fasked.action}:${fasked.ficha?.key ?? ''}`} v={v} asked={fasked} busy={fichaBusy} close={() => setFasked(null)} />}
  </>;
}
