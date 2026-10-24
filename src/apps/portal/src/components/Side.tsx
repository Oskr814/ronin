import { useState } from 'react';
import type { Me, Summary } from '../api.js';
import { FILTERS, initials } from '../lib/text.js';
import { Chip } from './Chip.js';

// The theme, on the page's root (theme.js puts it there before the first
// paint), and remembered in the browser.
function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(document.documentElement.dataset.theme !== 'light');
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('ronin-portal-theme', next);
    } catch {
      // No storage (private window): only for this visit.
    }
    setDark(!dark);
  };
  return [dark, toggle];
}

// A status no filter knows (a new one) counts as the team's, not lost.
const known = new Set(FILTERS.flatMap((f) => f.statuses));
const inFilter = (f: (typeof FILTERS)[number], status: string) => f.statuses.includes(status) || (f.id === 'team' && !known.has(status));

// The filters, with how many requests each one has: a click shows only
// those, a second one all again (like the tablero's Corriendo ahora).
function Filters({ requests, on, onPick }: {
  requests: Summary[];
  on: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="filters">
      {FILTERS.map((f) => {
        const n = requests.filter((r) => inFilter(f, r.status)).length;
        return (
          <button key={f.id} className={f.id} aria-pressed={on === f.id} onClick={() => onPick(f.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={f.icon} /></svg>{f.label}<span className="c">{n || ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Side({ me, requests, current, onNew, onOpen, onOut }: {
  me: Me;
  requests: Summary[];
  current: number | null;
  onNew: () => void;
  onOpen: (n: number) => void;
  onOut: () => void;
}) {
  const [dark, toggleTheme] = useTheme();
  const themeLabel = dark ? 'Tema claro' : 'Tema oscuro';
  const [filter, setFilter] = useState<string | null>(null);
  const pick = (id: string) => setFilter(filter === id ? null : id);
  const shown = FILTERS.find((f) => f.id === filter);
  const list = shown ? requests.filter((r) => inFilter(shown, r.status)) : requests;
  return (
    <aside className="side">
      <div className="brand"><div className="seal" aria-hidden="true">浪人</div><b>Pedidos</b></div>
      <button className="btn primary new" onClick={onNew}>+ Nuevo pedido</button>
      {requests.length ? <Filters requests={requests} on={filter} onPick={pick} /> : null}
      <h3>{shown ? shown.label : 'Mis pedidos'}</h3>
      <div className="reqs">
        {list.length
          ? list.map((r) => (
            <button key={r.number} className="req" aria-current={current === r.number} onClick={() => onOpen(r.number)}>
              <span className="t">{r.title}</span><span className="pj">{r.appName}</span>
              <span className="m"><Chip status={r.status} /><span className="p">P-{r.number}</span></span>
            </button>
          ))
          : <div className="none">{requests.length ? 'No tienes pedidos aquí.' : 'Todavía no tienes pedidos.'}</div>}
      </div>
      <div className="me">
        <div className="av" aria-hidden="true">{initials(me.name)}</div>
        <div className="who">{me.name}<small>{me.email}</small></div>
        <div className="acts">
          <button className="btn" title={themeLabel} aria-label={themeLabel} onClick={toggleTheme}>{dark ? '☀' : '☾'}</button>
          <button className="btn" onClick={onOut}>Salir</button>
        </div>
      </div>
    </aside>
  );
}
