import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { HostContext } from '../host.js';
import { Center, route } from './Center.js';
import { Context } from './Context.js';
import { tickClocks } from './Live.js';
import { ExploreNowLayer, KeysHelp, NewIssue, Relogin, Toast } from './Overlays.js';
import { pageHost } from './page-host.js';
import { Sidebar } from './Sidebar.js';
import { StatusBar } from './StatusBar.js';
import { boot, changed, closeNewIssue, followPath, movePr, queryClient, readSnapshot, S, SNAPSHOT_EVERY_MS, SNAPSHOT_KEY, subscribe, getVersion, toggleKeysHelp } from './state.js';

// The dashboard (#65): the login, or the shell (the sidebar, the page, the
// context column and the status bar) with what opens on top of it. All of
// it from the API, behind the GitHub login.

export const useShell = () => useSyncExternalStore(subscribe, getVersion);

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
        <a className="btn" href="/api/auth/login">Entrar con GitHub</a>
      </div>
    </div>
  );
}

export function Shell() {
  useShell();
  // The snapshot, again every SNAPSHOT_EVERY_MS while the page is seen.
  useQuery({ queryKey: SNAPSHOT_KEY, queryFn: readSnapshot, refetchInterval: SNAPSHOT_EVERY_MS, refetchOnMount: false, enabled: S.booted && !S.login });
  useEffect(() => {
    void boot();
    document.addEventListener('error', onError, true);
    document.addEventListener('keydown', onKey);
    addEventListener('popstate', followPath);
    const clocks = setInterval(tickClocks, 1000);
    // What the pages read that the sidebar shows: a deploy going, the projects of the cycles.
    const stop = queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey[0];
      if (event.type === 'updated' && event.action.type === 'success' && (key === 'deploys' || key === 'today')) changed();
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
    <HostContext.Provider value={pageHost}>
      <Login />
      <div className={`shell${at?.wide ? ' wide' : ''}${S.page === 'ajustes' ? ' aj' : ''}`} id="shell" data-m={S.m} hidden={!at || Boolean(S.login)}>
        {at ? <><Sidebar /><Center at={at} /><Context /><StatusBar /></> : null}
      </div>
      {at ? <><NewIssue /><KeysHelp /><ExploreNowLayer /></> : null}
      <Toast />
      <Relogin />
    </HostContext.Provider>
  );
}
