import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { client, isStale, ok, onStale, setUnauthorized, type Me } from './api.js';
import { Login, Password } from './Gate.js';
import { NewRequest } from './NewRequest.js';
import { RequestView } from './RequestView.js';
import { Side } from './Side.js';

// The page's routes: / (a new request), /p/<n> (one), /contrasena#t=… (the
// password from an emailed link). The token comes after the #, so it never
// reaches a server log; it's taken off the address right away.
type View = { kind: 'checking' } | { kind: 'login' } | { kind: 'password'; token: string | null } | { kind: 'app' };

function firstView(): View {
  if (location.pathname !== '/contrasena') return { kind: 'checking' };
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  history.replaceState(null, '', '/contrasena');
  return { kind: 'password', token };
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>(firstView);

  const toLogin = useCallback(() => {
    queryClient.clear();
    history.replaceState(null, '', '/');
    setView({ kind: 'login' });
  }, [queryClient]);
  setUnauthorized(toLogin);

  const enter = useCallback((me: Me) => {
    queryClient.setQueryData(['me'], me);
    setView({ kind: 'app' });
  }, [queryClient]);

  useEffect(() => {
    if (view.kind !== 'checking') return;
    queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => ok(client.me.$get()) })
      .then(() => setView({ kind: 'app' }), () => setView({ kind: 'login' }));
  }, [view.kind, queryClient]);

  if (view.kind === 'checking') return null;
  if (view.kind === 'login') return <Login onIn={enter} />;
  if (view.kind === 'password') return <Password token={view.token} onIn={(me) => { history.replaceState(null, '', '/'); enter(me); }} />;
  return <Shell onOut={toLogin} />;
}

// The address as a route, kept with the browser's back and forward.
function usePath(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const back = () => setPath(location.pathname);
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  const go = useCallback((to: string, replace = false) => {
    if (location.pathname !== to) history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setPath(to);
  }, []);
  return [path, go];
}

function Shell({ onOut }: { onOut: () => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => ok(client.me.$get()) }).data;
  const requests = useQuery({ queryKey: ['requests'], queryFn: () => ok(client.requests.$get()) }).data ?? [];
  const [path, go] = usePath();
  const [menu, setMenu] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  // Why a request couldn't be opened, shown on the new request's page.
  const [flash, setFlash] = useState<string | null>(null);
  const stale = useSyncExternalStore(onStale, isStale);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoom(null);
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, []);

  if (!me) return null;
  const n = /^\/p\/(\d+)$/.exec(path)?.[1];
  const open = (to: string) => {
    setMenu(false);
    setFlash(null);
    go(to);
  };

  return (
    <>
      <div className={`app ${menu ? 'menu' : ''}`}>
        <Side me={me} requests={requests} current={n ? Number(n) : null} onNew={() => open('/')} onOpen={(r) => open(`/p/${r}`)} onOut={async () => {
          await ok(client.logout.$post()).catch(() => {});
          onOut();
        }} />
        <main className="main">
          {stale && <div className="stale" role="status">Hay una versión nueva del portal. <button className="btn" onClick={() => location.reload()}>Recargar</button></div>}
          {n
            ? <RequestView key={n} n={Number(n)} me={me} onMenu={() => setMenu(!menu)} onZoom={setZoom} onMissing={(why) => { setFlash(why); go('/', true); }} />
            : <NewRequest me={me} flash={flash} onMenu={() => setMenu(!menu)} onSent={(r) => go(`/p/${r}`)} />}
        </main>
      </div>
      {zoom && <button className="lb" aria-label="Cerrar imagen" onClick={() => setZoom(null)}><img src={zoom} alt="" /></button>}
    </>
  );
}

export const MenuButton = ({ onClick }: { onClick: () => void }) => (
  <button className="menu-btn" aria-label="Mis pedidos" onClick={onClick}><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
);
