import { createContext, useContext, type ReactNode } from 'react';
import { ApiError } from '@apps/dashboard/src/api.js';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';

// The pieces every section of Ajustes is made of, as app.js wrote them (the
// data-aj* attributes too: the CSS and the keyboard find some of them).

export function Sec({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return <section className="aj-sec"><h2>{title}</h2>{lead ? <p className="aj-d">{lead}</p> : null}<div className="aj-card">{children}</div></section>;
}

// `sub`: a setting of the row above it, indented under it.
export function Row({ label, desc, ctl, src, sub }: { label: ReactNode; desc?: ReactNode; ctl: ReactNode; src?: ReactNode; sub?: boolean }) {
  return (
    <div className={sub ? 'aj-row sub' : 'aj-row'}>
      <div className="l"><b>{label}</b>{desc ? <small>{desc}</small> : null}</div>
      <div className="ctl">{ctl}</div>
      {src ? <div className="src">{src}</div> : null}
    </div>
  );
}

// Where something that isn't edited here is changed: .env, or repos.json.
export const Source = ({ name, file = '.env' }: { name: string; file?: '.env' | 'repos.json' }) => (
  <><span className="aj-env">{file}</span><code>{name}</code><span>· se cambia en {file === '.env' ? 'el servidor' : 'el archivo'}</span></>
);

// Something only .env changes: shown, never edited here.
export const Fixed = ({ label, value, env }: { label: string; value: string; env: string }) => (
  <Row label={label} ctl={<span className="aj-ro">{value}</span>} src={<Source name={env} />} />
);

export function Switch({ on, label, onToggle, disabled, ...data }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean; title?: string; [attr: `data-${string}`]: string }) {
  return <button className="aj-sw" role="switch" aria-checked={on} {...data} disabled={disabled} aria-label={label} onClick={onToggle} />;
}

// Another section, at its address.
export function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  const shell = useShell();
  return <a href={`/ajustes/${to}`} data-aj-link={to} onClick={(event) => { event.preventDefault(); shell.openSettings(to); }}>{children}</a>;
}

// A field saves when it's left, as app.js did: the element's own change
// event, not React's on every key.
export const onCommit = <E extends HTMLInputElement | HTMLSelectElement>(save: (el: E) => void) => (el: E | null) => {
  if (el) el.onchange = () => save(el);
};

// A change: `run` sends it and puts what the server answers where the page
// reads it. Then the section is drawn again from that (what was typed and
// not saved goes back), unless the session ended.
export type Change = (run: () => Promise<void>, fail?: (message: string) => string) => Promise<void>;
export const ChangeContext = createContext<Change>(async () => {});
export const useChange = () => useContext(ChangeContext);

export function makeChange(unauthorized: (message: string) => void, toast: (message: string) => void, redraw: () => void): Change {
  return async (run, fail = (message) => `No se guardó. ${message}`) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return unauthorized(error.message);
      toast(fail((error as Error).message));
    }
    redraw();
  };
}
