import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useHost } from '../../host.js';
import { isMobile } from '../../lib/format.js';
import { Dot } from '../../lib/runs.js';
import { useViewState } from '../../lib/view-state.js';
import { ago, useNow } from '../../../../../ui/time.js';
import { BugTag, CLOSED, EVERY_MS, Mini, repoShort, StatusChip, waitsLabel, type Row } from './model.js';

// Pedidos del portal (#132): what people ask through the portal and where
// each request stands, for anyone who sees its repo. The accounts are in
// Ajustes → Usuarios (#174), for admins only.

// Pendientes first and by default (#158): the closed ones, in Cerrados or
// Todos. Null, a separator between the groups.
const FILTERS: Array<[Filter, string] | null> = [['pend', 'Pendientes'], null, ['person', 'Esperan a la persona'], ['ronin', 'ronin trabajando'], ['team', 'Esperan al equipo'], null, ['cerrados', 'Cerrados'], ['todos', 'Todos']];
type Filter = 'pend' | 'person' | 'ronin' | 'team' | 'cerrados' | 'todos';
const PAGE = 25;

// The Pedidos | Usuarios tabs atop the portal's page; Usuarios, only for admins.
function PortalTabs() {
  const host = useHost();
  return (
    <div className="doctabs pd-ptabs" role="tablist"><button className="doctab" role="tab" aria-selected="true" onClick={() => host.openPedidos()}>Pedidos <span className="c">{host.requestsTotal()}</span></button>{host.portalAdmin() && <button className="doctab" role="tab" title="Las cuentas del portal están en Ajustes → Usuarios" onClick={() => host.openPortalAccounts()}>Usuarios ↗</button>}</div>
  );
}

function Pager({ total, pages, page, go }: { total: number; pages: number; page: number; go: (page: number) => void }) {
  const from = (page - 1) * PAGE + 1;
  const to = Math.min(page * PAGE, total);
  // Every number up to 7 pages; past that, the first, the last and the ones around this one.
  const nums = Array.from({ length: pages }, (_, i) => i + 1).filter((n) => pages <= 7 || n === 1 || n === pages || Math.abs(n - page) <= 1);
  return (
    <nav className="pd-pager" aria-label="Páginas"><span>{from}–{to} de {total}</span><span className="pg"><button disabled={page === 1} aria-label="Anterior" onClick={() => go(page - 1)}>‹</button>{nums.map((n, i) => [
      i && n - nums[i - 1] > 1 ? <span key={`g${n}`} className="gap">…</span> : null,
      <button key={n} aria-current={n === page ? 'page' : 'false'} onClick={() => go(n)}>{n}</button>,
    ])}<button disabled={page === pages} aria-label="Siguiente" onClick={() => go(page + 1)}>›</button></span></nav>
  );
}

export function Requests() {
  const host = useHost();
  const now = useNow();
  const [filter, setFilter] = useViewState<Filter>('requests.filter', 'pend');
  const [page, setPage] = useViewState('requests.page', 1);
  const scroller = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['requests'],
    queryFn: () => ok(client.api.requests.$get()).then((d) => d.requests),
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) host.unauthorized(query.error.message);
  }, [query.error, host]);

  const head = (
    <>
      <h1>Portal de pedidos</h1><p className="lead">Lo que la gente pide desde el portal y en qué va cada pedido: la conversación, lo que hizo ronin, y el issue y el PR cuando los hay.</p><PortalTabs />
    </>
  );
  const list = query.data;
  if (!list) {
    const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? query.error.message : null;
    return <div className="today pd">{head}{error ? <p className="bad">{error}</p> : <div className="empty">Cargando…</div>}</div>;
  }
  const groups: Record<Filter, Row[]> = {
    pend: list.filter((p) => !CLOSED.includes(p.status)),
    todos: list,
    person: list.filter((p) => p.waitsOn === 'person'),
    ronin: list.filter((p) => p.waitsOn === 'ronin'),
    team: list.filter((p) => p.waitsOn === 'team'),
    cerrados: list.filter((p) => CLOSED.includes(p.status)),
  };
  const all = groups[filter] ?? list;
  // The page, kept while the list reloads, inside it if it got shorter.
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const cur = Math.min(Math.max(1, page), pages);
  const shown = all.slice((cur - 1) * PAGE, cur * PAGE);
  const many = host.repos().length > 1;
  const pick = (f: Filter) => {
    setFilter(f);
    setPage(1);
  };
  const go = (n: number) => {
    setPage(n);
    if (isMobile()) scrollTo(0, 0);
    else scroller.current?.scrollTo(0, 0);
  };
  return (
    <div className="today pd" ref={scroller}>{head}
      <div className="pd-filters">{FILTERS.map((f, i) => (f ? <button key={f[0]} aria-pressed={filter === f[0]} onClick={() => pick(f[0])}>{f[1]}<span className="c">{groups[f[0]].length}</span></button> : <span key={i} className="sep" />))}</div>
      {shown.length ? (
        <table className="padm-t pd-t"><thead><tr><th></th><th>Pedido</th><th>Estado</th><th className="hide-m">Espera a</th><th className="hide-m">GitHub</th><th className="hide-m">Último movimiento</th></tr></thead><tbody>{shown.map((p) => (
          <tr key={p.number} tabIndex={0} onClick={() => host.openPedido(p.number)} onKeyDown={(event) => { if (event.key === 'Enter') host.openPedido(p.number); }}><td className="pn">P-{p.number}</td>
            <td><span className="tt">{p.title}</span><BugTag p={p} /><small>{p.person} · {p.appName}{many ? ` · ${repoShort(p.repo)}` : ''}</small><Mini p={p} /></td>
            <td><StatusChip p={p} /></td>
            <td className="hide-m"><span className="pd-waits">{p.running && <Dot cls="live" />}{waitsLabel(p)}</span></td>
            <td className="hide-m pd-gh">{p.issue ? `#${p.issue}` : <span className="m">—</span>}{p.pr ? ` · PR #${p.pr}` : ''}</td>
            <td className="hide-m m">{ago(p.lastAt, now)}</td></tr>
        ))}</tbody></table>
      ) : (
        <p className="note">{!list.length ? 'Todavía nadie pidió nada por el portal.' : filter === 'pend' ? <>Nada pendiente: todos los pedidos están cerrados. Los anteriores están en <button className="link" onClick={() => pick('todos')}>Todos</button>.</> : 'Ningún pedido aquí.'}</p>
      )}
      {pages > 1 && <Pager total={all.length} pages={pages} page={cur} go={go} />}
    </div>
  );
}
