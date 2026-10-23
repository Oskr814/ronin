import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ExploreNow } from '../pages/explorations/ExploreNow.js';
import { LinearIcon } from '../lib/github.js';
import { dayMonth } from '../lib/format.js';
import { endDay } from './Context.js';
import { cycleName } from './Sidebar.js';
import { changed, closeExploreNow, closeNewIssue, linearRepos, md, repoShort, S, sendNewIssue, toggleKeysHelp } from './state.js';

// What opens on top of the page, on the body: a note, the keys' help, a new
// issue, Explorar ahora, and the notice to log in again in another tab.

export function Toast() {
  const t = S.toast;
  if (!t) return null;
  return createPortal(<div key={t.id} className="toast" role="status">{t.message}{t.url && t.url.startsWith('https://github.com/') ? <> <a href={t.url} target="_blank" rel="noopener">Ver ↗</a></> : null}</div>, document.body);
}

export function Relogin() {
  if (!S.relogin) return null;
  return createPortal(<div id="relogin" className="relogin" role="alert"><span>{S.relogin} Lo que escribiste sigue acá: entrá en otra pestaña y volvé a enviarlo.</span><a className="btn-s primary" href="/api/auth/login" target="_blank" rel="noopener">Entrar con GitHub</a></div>, document.body);
}

const KEYS_HELP: Array<[string, Array<[string, string]>]> = [
  ['Moverse', [['1 – 9', 'Ir a una pestaña'], ['j / k', 'Siguiente / anterior sección, comentario, archivo o ficha'], ['d / u', 'Media página abajo / arriba'], ['gg / G', 'Al inicio / al final'], [']p / [p', 'Siguiente / anterior PR de ronin que espera una decisión']]],
  ['En un PR de ronin', [['A', 'Aprobar: aprueba y mergea (↵ confirma)'], ['P', 'Ajustar: le pide un cambio a ronin (Ctrl ↵ manda)'], ['X', 'Cerrar el PR (Ctrl ↵ confirma)'], ['1 – 3', 'Fuera del texto del ajuste: sumar una sugerencia'], ['I', 'Fuera del texto del cierre: cerrar también el issue, o no']]],
  ['Acciones', [['M', 'Abrir o cerrar el menú de acciones'], ['1 – 9', 'En el menú: pedir esa acción'], ['j / k', 'En el menú: la siguiente / anterior (también ↓ ↑, y ↵ la pide)'], ['Ctrl ↵', 'En el diálogo de la acción: comentar']]],
  ['En Issue o PR', [['c', 'Escribir un comentario al pie de la conversación (Ctrl ↵ lo manda, Esc sale del cuadro)']]],
  ['En Archivos', [['v', 'Marcar el archivo como visto'], ['r', 'Revisión, en los PRs de personas']]],
  ['General', [['?', 'Esta ayuda'], ['Esc', 'Cerrar lo que esté abierto']]],
];
const Keys = ({ k }: { k: string }) => <>{k.split(' ').flatMap((x, i) => [i ? ' ' : null, /^[/–]$/.test(x) ? x : <kbd key={i}>{x}</kbd>])}</>;

export function KeysHelp() {
  if (!S.keysHelp) return null;
  return createPortal(
    <div id="keys-help" className="scrim" onClick={(e) => { if (e.target === e.currentTarget) toggleKeysHelp(); }}><div className="dlg keys-dlg" role="dialog" aria-modal="true" aria-labelledby="keys-t"><h2 id="keys-t">Atajos</h2>{KEYS_HELP.map(([h, rows]) => <KeysGroup key={h} h={h} rows={rows} />)}</div></div>,
    document.body,
  );
}
const KeysGroup = ({ h, rows }: { h: string; rows: Array<[string, string]> }) => <><h3>{h}</h3><dl>{rows.map(([k, what]) => <KeysRow key={k + what} k={k} what={what} />)}</dl></>;
const KeysRow = ({ k, what }: { k: string; what: string }) => <><dt><Keys k={k} /></dt><dd>{what}</dd></>;

// A new issue (#100): created on GitHub as the person (never through
// Linear), and then, if asked, assigned to ronin or with a /spike or /spec
// commented as them.
const AFTER: Array<[string, string, string]> = [
  ['none', 'Solo crearlo', 'Queda en GitHub (y en Linear, por la sincronización) para quien lo tome.'],
  ['assign', 'Asignárselo a ronin', 'ronin lo toma como cualquier issue que le asignan: lo investiga, pregunta si le falta algo y abre un PR.'],
  ['spike', 'Pedir un /spike', 'ronin investiga en solo lectura y agrega una sección de contexto al issue.'],
  ['spec', 'Pedir un /spec', 'ronin lo convierte en un spec, te pregunta lo que falte y abre un PR draft con el spec.'],
];

export function NewIssue() {
  const n = S.newIssue;
  const title = useRef<HTMLInputElement>(null);
  const open = Boolean(n);
  useEffect(() => {
    if (open) title.current?.focus();
  }, [open]);
  if (!n) return null;
  const apps = (S.snap?.apps as Record<string, string[]> | undefined)?.[n.repo] ?? [];
  // With Linear (#101): the project and the cycle it goes in, both optional.
  const planning = linearRepos().find((l) => l.repo === n.repo)?.planning;
  const cycleLabel = (c: { name?: string; number: number; current?: boolean; startsAt: string; endsAt: string }) => `${cycleName(c)}${c.current ? ', el actual' : ''} (${dayMonth(c.startsAt)} – ${endDay(c.endsAt)})`;
  const set = (patch: Partial<typeof n>) => {
    Object.assign(n, patch);
    changed();
  };
  const preview = n.tab === 'preview';
  const command = n.after === 'spike' || n.after === 'spec';
  return createPortal(
    <div id="nlayer"><div className="scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('scrim')) closeNewIssue(); }}><div className="dlg dlg-new" role="dialog" aria-modal="true" aria-labelledby="ni-t">
      <h2 id="ni-t">Nuevo issue en {repoShort(n.repo)}</h2>
      <p className="help">Se crea en GitHub a tu nombre ({S.snap?.me ?? ''}).{linearRepos().some((l) => l.repo === n.repo) ? ' Con la sincronización, aparece también en Linear.' : ''}</p>
      <label className="field"><span>Título</span><input id="ni-title" ref={title} maxLength={256} autoComplete="off" placeholder="Qué pasa o qué hace falta" value={n.title} onChange={(e) => set({ title: e.target.value })} /></label>
      <div className="field"><div className="ni-tabs" role="tablist"><span>Descripción</span><button role="tab" data-nitab="write" aria-selected={!preview} onClick={() => set({ tab: 'write' })}>Escribir</button><button role="tab" data-nitab="preview" aria-selected={preview} onClick={() => set({ tab: 'preview' })}>Vista previa</button></div>
        <textarea id="ni-body" rows={7} placeholder="Contexto, pasos para reproducirlo, qué se espera. Acepta markdown." hidden={preview} value={n.body} onChange={(e) => set({ body: e.target.value })} /><div className="md ni-prev" id="ni-prev" hidden={!preview} dangerouslySetInnerHTML={preview ? { __html: n.body.trim() ? md(n.body, n.repo) : '<p class="note">Sin descripción.</p>' } : undefined} /></div>
      {planning ? <div className="ni-linear"><label className="field"><span><LinearIcon /> Proyecto</span><select id="ni-project" value={n.projectId} onChange={(e) => { n.projectId = e.target.value; changed(); }}><option value="">Sin proyecto</option>{planning.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span><LinearIcon /> Ciclo</span><select id="ni-cycle" value={n.cycleId} onChange={(e) => { n.cycleId = e.target.value; changed(); }}><option value="">Sin ciclo</option>{planning.cycles.map((c) => <option key={c.id} value={c.id}>{cycleLabel(c)}</option>)}</select></label></div> : null}
      <fieldset className="ni-after"><legend>Después de crearlo</legend>
        {AFTER.map(([id, label, help]) => {
          const off = (id === 'spike' || id === 'spec') && !apps.length;
          return <label key={id} className="check"><input type="radio" name="ni-after" value={id} disabled={off} checked={n.after === id} onChange={() => set({ after: id })} /><span>{label}<small>{off ? 'El repo no tiene ronin.app.json: no hay apps para pedirlo.' : help}</small></span></label>;
        })}
      </fieldset>
      <div className="ni-cmd" id="ni-cmd" hidden={!command}>
        <label className="field"><span>App</span><select id="ni-app" value={n.app} onChange={(e) => set({ app: e.target.value })}>{apps.map((a) => <option key={a}>{a}</option>)}</select></label>
        <label className="field"><span>Instrucción (opcional)</span><input id="ni-instr" maxLength={500} autoComplete="off" placeholder="En qué fijarse" value={n.instruction} onChange={(e) => set({ instruction: e.target.value })} /></label>
        <div className="prev"><div className="lbl">Comentás en el issue como {S.snap?.me ?? ''}</div><code id="ni-line">{command ? `@${S.snap?.ronin ?? 'ronin'} /${n.after} ${n.app}${n.instruction.trim() ? ` ${n.instruction.trim().replace(/\s+/g, ' ')}` : ''}` : ''}</code></div>
      </div>
      <p className="bad" id="ni-err" hidden={!n.error}>{n.error ?? ''}</p>
      <div className="foot-d"><button className="btn-s" id="ni-no" onClick={closeNewIssue}>Cancelar</button><button className="btn-s primary" id="ni-yes" disabled={n.sending || !n.title.trim() || (command && !n.app)} onClick={() => void sendNewIssue()}>{n.sending ? 'Creando…' : n.after === 'assign' ? 'Crear y asignar a ronin' : command ? `Crear y pedir /${n.after}` : 'Crear issue'}</button></div></div></div></div>,
    document.body,
  );
}

// Explorar ahora (pages/explorations/ExploreNow.tsx), on its own: the app's
// page and its exploration PR's head open it.
export function ExploreNowLayer() {
  if (!S.xnow) return null;
  return createPortal(<div id="xlayer"><ExploreNow repo={S.xnow.repo} app={S.xnow.app} onClose={closeExploreNow} /></div>, document.body);
}
