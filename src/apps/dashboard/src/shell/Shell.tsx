import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { onAnnounce } from '../lib/motion.js';
import { shellActions } from './actions.js';
import { Center, route } from './Center.js';
import { Context } from './Context.js';
import { tickClocks } from './Live.js';
import { ExploreNowLayer, KeysHelp, NewIssue, Relogin, Toast } from './Overlays.js';
import { ShellContext, useShellVersion } from './hooks.js';
import { Sidebar } from './Sidebar.js';
import { StatusBar } from './StatusBar.js';
import {
  boot, changed, closeNewIssue, EXPLORATIONS_KEY, followPath, loginHref, movePr, queryClient, readExplorations, readSnapshot, S, SNAPSHOT_EVERY_MS, SNAPSHOT_KEY,
  toggleKeysHelp, XPL_EVERY_MS, XPL_PAGE_EVERY_MS, xplRows,
} from './state.js';

// The dashboard (#65): the login, or the shell (the sidebar, the page, the
// context column and the status bar) with what opens on top of it. All of
// it from the API, behind the GitHub login.

// ]p and [p, the next or the previous PR that waits on a decision, from
// anywhere: the second key of a sequence is waited for a moment. True when
// the key was one of them (or its first half). An item's page has its own
// keys first (pages/item).
const KEY_SEQ_MS = 900;
const seq = { key: null as string | null, timer: 0 };
function nextPrKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const prev = seq.key;
  seq.key = null;
  clearTimeout(seq.timer);
  if ((prev === ']' || prev === '[') && event.key === 'p') {
    event.preventDefault();
    movePr(prev === ']' ? 1 : -1);
    return true;
  }
  if (event.key === ']' || event.key === '[') {
    seq.key = event.key;
    seq.timer = window.setTimeout(() => { seq.key = null; }, KEY_SEQ_MS);
    return true;
  }
  return false;
}

function onKey(event: KeyboardEvent) {
  if (!S.booted) return;
  const typing = event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (event.key === '?' && !typing && !S.newIssue) {
    event.preventDefault();
    toggleKeysHelp();
    return;
  }
  if (!typing && !S.newIssue && !S.xnow && nextPrKey(event)) return;
  if (event.key !== 'Escape') return;
  if (S.keysHelp) toggleKeysHelp();
  else if (S.newIssue) closeNewIssue();
}

// A screenshot that didn't load (lib/md.ts) goes back to being a label; an
// avatar that didn't load (Métricas) leaves its circle.
function onError(event: Event) {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.classList.contains('ev')) img.replaceWith(img.dataset.label ?? '[imagen]');
  if (img instanceof HTMLImageElement && img.classList.contains('mt-av')) img.replaceWith(Object.assign(document.createElement('span'), { className: 'mt-av' }));
}

function Login() {
  return (
    <div id="login" className="login" hidden={!S.login}>
      <div className="login-card">
        <span className="seal seal-lg" aria-hidden="true">浪人</span>
        <h1>ronin</h1>
        <p>Entrá con tu cuenta de GitHub para ver lo que está haciendo ronin. Lo que pidas desde acá, GitHub lo muestra a tu nombre.</p>
        <p className="bad" id="login-why" hidden={!S.login?.why}>{S.login?.why ?? ''}</p>
        <a className="btn" href={loginHref()}>Entrar con GitHub</a>
      </div>
    </div>
  );
}

// What changed on screen by itself, said to a screen reader (lib/motion.ts):
// the last thing, emptied a moment later so the same words say it again.
function Announcer() {
  const [text, setText] = useState('');
  useEffect(() => {
    let timer = 0;
    const stop = onAnnounce((said) => {
      setText(said);
      clearTimeout(timer);
      timer = window.setTimeout(() => setText(''), 4000);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);
  return <div className="sr" aria-live="polite">{text}</div>;
}

// The queries whose answers the shell shows.
const SHOWN = new Set(['deploys', 'today', 'explorations', 'item']);

export function Shell() {
  useShellVersion();
  const live = S.booted && !S.login;
  // The snapshot, again every SNAPSHOT_EVERY_MS while the page is seen.
  useQuery({ queryKey: SNAPSHOT_KEY, queryFn: readSnapshot, refetchInterval: SNAPSHOT_EVERY_MS, refetchOnMount: false, enabled: live });
  // The apps' findings, more often while their pages are open: the sidebar counts them too.
  const xplPage = S.page === 'exploraciones' || S.page === 'exploracion';
  useQuery({ queryKey: EXPLORATIONS_KEY, queryFn: readExplorations, refetchInterval: xplPage ? XPL_PAGE_EVERY_MS : XPL_EVERY_MS, staleTime: xplPage ? XPL_PAGE_EVERY_MS : XPL_EVERY_MS, enabled: live && xplRows().length > 0 });
  useEffect(() => {
    void boot();
    document.addEventListener('error', onError, true);
    document.addEventListener('keydown', onKey);
    addEventListener('popstate', followPath);
    const clocks = setInterval(tickClocks, 1000);
    // What the pages read that the shell shows: a deploy going, the projects
    // of the cycles (the sidebar), the apps' findings, an item's tabs (the
    // center's width) and its runs (the context column).
    const stop = queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey[0] as string;
      if (event.type === 'updated' && event.action.type === 'success' && SHOWN.has(key)) changed();
    });
    return () => {
      document.removeEventListener('error', onError, true);
      document.removeEventListener('keydown', onKey);
      removeEventListener('popstate', followPath);
      clearInterval(clocks);
      stop();
    };
  }, []);
  const at = S.booted && S.snap ? route() : null;
  return (
    <ShellContext.Provider value={shellActions}>
      <Login />
      <div className={`shell${at?.wide ? ' wide' : ''}${S.page === 'ajustes' ? ' aj' : ''}`} id="shell" data-m={S.m} hidden={!at || Boolean(S.login)}>
        {at ? <><Sidebar /><Center at={at} /><Context /><StatusBar /></> : null}
      </div>
      {at ? <><NewIssue /><KeysHelp /><ExploreNowLayer /></> : null}
      <Toast />
      <Relogin />
      <Announcer />
    </ShellContext.Provider>
  );
}
