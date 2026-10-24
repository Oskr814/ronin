import { useState, type MouseEvent, type ReactNode } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import type { ApproveOutcome } from '@domains/meetings/approve.js';
import { type LinearPlanning, refresh, useMarkdown, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { ICON } from '@apps/dashboard/src/lib/icons.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { approveItems, chosen, created, CYCLE, editable, newForm, noteLines, plural, type Detail, type Field, type Form, type Issue } from './model.js';

// What ronin proposes out of a meeting, and its review (#62, entrega 3): the
// person marks what goes, changes titles, descriptions and where each one
// goes in Linear, and creates it at their name, or sets the rest aside.

export interface Cites {
  open: Record<string, boolean>;
  toggle(key: string): void;
  // Shows a line in the notes.
  toLine(line: number): void;
}

const LinIcon = () => <svg width="12" height="12" viewBox="0 0 100 100" aria-hidden="true" style={{ verticalAlign: '-1px', flex: 'none' }}><path fill="currentColor" d="M1.2 61.5a50 50 0 0 0 37.3 37.3zM.1 48.9l51 51a50 50 0 0 0 9.3-1.4L1.5 39.6A50 50 0 0 0 .1 48.9zm3.6-17.8 65.2 65.2a50 50 0 0 0 7.2-3.9L7.6 23.9a50 50 0 0 0-3.9 7.2zm8.4-12.2a50 50 0 1 1 69 69z" /></svg>;
const cycleName = (c: { name?: string; number: number }) => c.name || `Ciclo ${c.number}`;
const arrow = (open: boolean | undefined) => <span className={`chev${open ? ' open' : ''}`}>▸</span>;

// Everything a proposal's parts need: the meeting, its review, and what's open.
interface Ctx {
  d: Detail;
  f: Form;
  cites: Cites;
  // The repo's Linear team, if it has one.
  planning: LinearPlanning | null;
  setOn(id: string, on: boolean): void;
  setField(field: Field, id: string, value: string): void;
}

const isOff = ({ d, f }: Ctx, id: string) => !created(d, id) && (editable(d) ? !f.on[id] : d.status === 'done' || d.status === 'discarded');
// Still being reviewed: it can be changed.
const changing = ({ d }: Ctx, id: string) => editable(d) && !created(d, id);

function FromNotes({ c, k, cites }: { c: Ctx; k: string; cites: number[] }) {
  if (!cites.length) return null;
  const lines = noteLines(c.d.text);
  const open = c.cites.open[k];
  return <>
    <button className="reu-x" onClick={() => c.cites.toggle(k)}>{arrow(open)} De las notas{cites.length > 1 ? ` (${cites.length})` : ''}</button>
    {open && cites.map((n, i) => <blockquote key={i} className="reu-q">{lines[n - 1] ?? ''}<button className="reu-src-l" onClick={() => c.cites.toLine(n)}>línea {n} en las notas</button></blockquote>)}
  </>;
}

function Markdown({ text, repo }: { text: string; repo: string }) {
  const shell = useShell();
  const markdown = useMarkdown();
  // A #123 the sidebar has opens here.
  const click = (e: MouseEvent) => {
    const ref = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-ref]')?.dataset.ref;
    if (ref && markdown.hasItem(ref)) {
      e.preventDefault();
      shell.openItem(ref);
    }
  };
  return <div className="md reu-md" onClick={click} dangerouslySetInnerHTML={{ __html: markdown.html(text, repo) }} />;
}

// The description: shown, or a textarea while editing it.
function Text({ c, k, id, label, body }: { c: Ctx; k: string; id: string; label: string; body: string }) {
  const open = c.cites.open[k];
  if (!changing(c, id)) return <><button className="reu-x" onClick={() => c.cites.toggle(k)}>{arrow(open)} {label}</button>{open && <Markdown text={body} repo={c.d.repo} />}</>;
  return <>
    <button className="reu-x" onClick={() => c.cites.toggle(k)}>{arrow(open)} {label}{c.f.body[id] !== undefined ? ' · editada' : ''}</button>
    {open && <textarea className="reu-ta" rows={8} value={c.f.body[id] ?? body} onChange={(e) => c.setField('body', id, e.target.value)} />}
  </>;
}

function Check({ c, id, label }: { c: Ctx; id: string; label: string }) {
  if (!changing(c, id)) return null;
  return <input type="checkbox" className="reu-chk" checked={Boolean(c.f.on[id])} aria-label={label} onChange={(e) => c.setOn(id, e.target.checked)} />;
}

function Title({ c, id, value, label }: { c: Ctx; id: string; value: string; label: string }) {
  if (!changing(c, id)) return <b>{value}</b>;
  return <input className="reu-ti" maxLength={256} value={c.f.title[id] ?? value} aria-label={label} onChange={(e) => c.setField('title', id, e.target.value)} />;
}

function Select({ c, field, id, value, options, label }: { c: Ctx; field: Field; id: string; value: string | undefined; options: Array<[string, string]>; label: ReactNode }) {
  return (
    <label className="reu-sel">{label} <select value={c.f[field][id] ?? value ?? ''} onChange={(e) => c.setField(field, id, e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select></label>
  );
}

function Meta({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter(Boolean);
  return shown.length ? <div className="reu-meta">{shown}</div> : null;
}

function cycleField(c: Ctx, id: string, value: string | undefined, label: ReactNode = <><LinIcon /> Ciclo</>): ReactNode {
  const planning = c.planning;
  if (!planning) return null;
  if (!changing(c, id)) return value ? <span key="cycle"><LinIcon /> {CYCLE[value] ?? value}</span> : null;
  // The current cycle and the next, by what the page knows of Linear.
  const current = planning.cycles.find((x) => x.current);
  const next = planning.cycles.find((x) => !x.current && (!current || x.startsAt >= current.endsAt));
  return <Select key="cycle" c={c} field="cycle" id={id} value={value} label={label} options={[['', 'sin ciclo'], ['current', current ? `${cycleName(current)} (el actual)` : 'El ciclo actual'], ['next', next ? `${cycleName(next)} (el próximo)` : 'El próximo ciclo']]} />;
}

// What became of it, once approved.
function Result({ c, id }: { c: Ctx; id: string }) {
  const shell = useShell();
  const { d } = c;
  const r = d.results[id];
  if (!r) return null;
  if (!r.ok) return <div className="reu-res bad">No se pudo crear: {r.error}</div>;
  const label = r.projectId ? 'Proyecto creado en Linear' : r.number && d.proposals!.comments.some((x) => x.id === id) ? `Comentado en #${r.number}` : `Creado #${r.number}`;
  const href = typeof r.url === 'string' && /^https:\/\/(github\.com|linear\.app)\//.test(r.url) ? r.url : null;
  return (
    <div className="reu-res ok">✓ {label}{href && <> <a href={href} target="_blank" rel="noopener">abrir ↗</a></>}
      {r.number && !r.projectId ? <> <button className="link" onClick={() => shell.openItem(`${d.repo}#${r.number}`)}>en el tablero</button></> : null}<span className="m"> · {r.by}</span></div>
  );
}

function IssueCard({ c, i, kid = false }: { c: Ctx; i: Issue; kid?: boolean }) {
  const planning = c.planning;
  const projectField = !kid && planning && changing(c, i.id)
    ? <Select key="project" c={c} field="project" id={i.id} value={i.project ?? ''} label={<><LinIcon /> Proyecto</>} options={[['', 'sin proyecto'], ...[...new Set([...(i.project ? [i.project] : []), ...planning.projects.map((x) => x.name)])].map((x): [string, string] => [x, x])]} />
    : i.project ? <span key="project"><LinIcon /> {i.project}</span> : null;
  return (
    <div className={`reu-pr ${kid ? 'reu-kid' : ''} ${isOff(c, i.id) ? 'off' : ''}`}>
      <div className="reu-h"><Check c={c} id={i.id} label="Incluir este issue" /><span className="reu-kind iss">issue</span><Title c={c} id={i.id} value={i.title} label="Título del issue" /></div>
      {i.why && <div className="reu-why">{i.why}</div>}
      <Meta parts={[projectField, cycleField(c, i.id, i.cycle)]} />
      <div className="reu-xs"><FromNotes c={c} k={`q-${i.id}`} cites={i.cites} /><Text c={c} k={`b-${i.id}`} id={i.id} label="Descripción" body={i.body} /></div>
      <Result c={c} id={i.id} />
    </div>
  );
}

function Section({ title, n, hint, children }: { title: string; n: number; hint?: string; children: ReactNode }) {
  if (!n) return null;
  return <section className="reu-sec"><h2>{title} <span className="c">{n}</span>{hint && <span className="hint">{hint}</span>}</h2>{children}</section>;
}

export function Proposals({ d, cites, onDone }: { d: Detail; cites: Cites; onDone: () => Promise<unknown> }) {
  const shell = useShell();
  const session = useSession();
  const [form, setForm] = useViewState<Form | null>(`meeting-form:${d.number}`, null);
  const [approving, setApproving] = useState(false);
  const p = d.proposals;
  if (!p) return <p className="note">Todavía no hay propuestas: ronin no terminó de leer las notas.</p>;
  const f = form ?? newForm(d);
  const planning = session.planning(d.repo);
  const c: Ctx = {
    d, f, cites, planning,
    setOn(id, on) {
      const next = { ...f.on, [id]: on };
      // A project's issues go with it.
      const project = p.projects.find((x) => x.id === id);
      if (project) for (const i of project.issues) if (!created(d, i.id)) next[i.id] = on;
      setForm({ ...f, on: next });
    },
    setField(field, id, value) {
      setForm({ ...f, [field]: { ...f[field], [id]: value } });
    },
  };
  const anyCreated = Object.values(d.results).some((r) => r.ok);

  const approve = async () => {
    if (approving) return;
    const items = approveItems(d, f);
    setApproving(true);
    try {
      // onlyJson, an untyped middleware, hides the route's answer from the client.
      const out = (await ok(client.api.meetings[':n'].approve.$post({ param: { n: String(d.number) }, json: { items } }))) as ApproveOutcome;
      shell.toast(out.failed ? `Se crearon ${out.created}; ${out.failed} no se pudieron crear: puedes intentarlo de nuevo.` : `Listo: se crearon ${out.created}.`);
      refresh();
    } catch (e) {
      setApproving(false);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      shell.toast(`No se pudo: ${(e as Error).message}`);
    }
    setApproving(false);
    setForm(null);
    await onDone();
  };
  const discard = async () => {
    if (!confirm('¿Descartar lo que queda de esta reunión? No se crea nada más.')) return;
    try {
      await ok(client.api.meetings[':n'].discard.$post({ param: { n: String(d.number) } }));
      shell.toast('Listo: la reunión quedó descartada.');
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      shell.toast(`No se pudo: ${(e as Error).message}`);
    }
    await onDone();
  };

  const projects = p.projects.map((x) => (
    <div key={x.id} className={`reu-pr proj ${isOff(c, x.id) ? 'off' : ''}`}>
      <div className="reu-h"><Check c={c} id={x.id} label="Incluir este proyecto" /><span className="reu-kind proj"><LinIcon /> proyecto nuevo</span><Title c={c} id={x.id} value={x.name} label="Nombre del proyecto" /></div>
      {x.why && <div className="reu-why">{x.why}</div>}
      <Meta parts={[
        <span key="state">Linear · estado Backlog</span>,
        editable(d) && planning && !created(d, x.id)
          ? <Select key="lead" c={c} field="lead" id={x.id} value={x.lead ?? ''} label="Líder" options={[['', 'sin líder'], ...planning.people.map((u): [string, string] => [u.name, u.name])]} />
          : x.lead ? <span key="lead">líder {x.lead}</span> : null,
      ]} />
      <div className="reu-xs"><FromNotes c={c} k={`q-${x.id}`} cites={x.cites} />{x.description && <Text c={c} k={`b-${x.id}`} id={x.id} label="Descripción" body={x.description} />}</div>
      <Result c={c} id={x.id} />
      <div className="reu-kids"><div className="reu-kids-h">Sus issues · en GitHub, dentro de este proyecto</div>{x.issues.map((i) => <IssueCard key={i.id} c={c} i={i} kid />)}</div>
    </div>
  ));
  const comments = p.comments.map((x) => (
    <div key={x.id} className={`reu-pr ${isOff(c, x.id) ? 'off' : ''}`}>
      <div className="reu-h"><Check c={c} id={x.id} label="Incluir este comentario" /><span className="reu-kind com">comentario</span><b>en <button className="link" onClick={() => shell.openItem(`${d.repo}#${x.issue}`)}>#{x.issue}</button> <span className="reu-it">{x.issueTitle}</span></b></div>
      {x.why && <div className="reu-why">{x.why}</div>}
      <Meta parts={[cycleField(c, x.id, x.cycle, <><LinIcon /> Pasarlo a</>)]} />
      <div className="reu-xs"><FromNotes c={c} k={`q-${x.id}`} cites={x.cites} /><Text c={c} k={`b-${x.id}`} id={x.id} label="Comentario" body={x.body} /></div>
      <Result c={c} id={x.id} />
    </div>
  ));
  const discarded = p.discarded.map((x, i) => (
    <div key={i} className="reu-disc"><b>{x.topic}</b><span className="reu-why">{x.why}</span><div className="reu-xs"><FromNotes c={c} k={`d-${i}`} cites={x.cites} /></div></div>
  ));
  return <>
    {d.status === 'done' && <div className="pd-now"><div className="k">{ICON.ok} Creado</div><div className="t">Se creó todo lo aprobado</div><div className="d">Lo que no se marcó quedó fuera. Los issues se crearon sin asignar: el equipo decide quién los toma.</div></div>}
    {d.status === 'discarded' && <div className="pd-now"><div className="k">{ICON.ok} Descartada</div><div className="t">{anyCreated ? 'Lo que faltaba quedó fuera' : 'No se creó nada de esta reunión'}</div></div>}
    {p.summary && <p className="reu-summary">{p.summary}</p>}
    <Section title="Proyectos" n={p.projects.length} hint="en Linear: GitHub no tiene proyectos">{projects}</Section>
    <Section title="Issues" n={p.issues.length}>{p.issues.map((i) => <IssueCard key={i.id} c={c} i={i} />)}</Section>
    <Section title="En issues que ya existen" n={p.comments.length}>{comments}</Section>
    <Section title="Descartado" n={p.discarded.length} hint="lo que se habló y no pide trabajo nuevo"><div className="reu-discs">{discarded}</div></Section>
    {editable(d) && <ApproveBar d={d} f={f} busy={approving} anyCreated={anyCreated} onApprove={approve} onDiscard={discard} />}
  </>;
}

function ApproveBar({ d, f, busy, anyCreated, onApprove, onDiscard }: { d: Detail; f: Form; busy: boolean; anyCreated: boolean; onApprove: () => void; onDiscard: () => void }) {
  const session = useSession();
  if (!session.can(d.repo, 'aprobar')) return <div className="reu-approve"><div className="sum">Lo que propone esta reunión lo aprueba alguien con permiso para aprobar en este repo.</div></div>;
  const { projects, issues, comments } = chosen(d, f);
  const parts = [projects ? plural(projects, 'proyecto', 'proyectos') : '', issues ? plural(issues, 'issue', 'issues') : '', comments ? plural(comments, 'comentario', 'comentarios') : ''].filter(Boolean);
  const what = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' y $1') : 'nada';
  return (
    <div className="reu-approve">
      <div className="sum">Crear <b>{what}</b><small>A tu nombre ({session.me}): los issues y los comentarios en GitHub con tu sesión{projects ? '; el proyecto en Linear con la key del repo' : ''}.</small></div>
      <button className="btn-s" disabled={busy} onClick={onDiscard}>Descartar {anyCreated ? 'el resto' : 'todo'}</button>
      <button className="btn-s primary" disabled={busy || !parts.length} onClick={onApprove}>{busy ? 'Creando…' : 'Crear seleccionados'}</button>
    </div>
  );
}
