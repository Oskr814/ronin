import { useState } from 'react';
import type { Me, Summary } from './api.js';
import { initials, STATUS } from './text.js';

export function Chip({ status }: { status: string }) {
  const [cls, label] = STATUS[status] ?? ['idle', status];
  return <span className={`chip ${cls}`}>{label}</span>;
}

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
  return (
    <aside className="side">
      <div className="brand"><div className="seal" aria-hidden="true">浪人</div><b>Pedidos</b></div>
      <button className="btn primary new" onClick={onNew}>+ Nuevo pedido</button>
      <h3>Mis pedidos</h3>
      <div className="reqs">
        {requests.length
          ? requests.map((r) => (
            <button key={r.number} className="req" aria-current={current === r.number} onClick={() => onOpen(r.number)}>
              <span className="t">{r.title}</span><span className="pj">{r.appName}</span>
              <span className="m"><Chip status={r.status} /><span className="p">P-{r.number}</span></span>
            </button>
          ))
          : <div className="none">Todavía no tienes pedidos.</div>}
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
