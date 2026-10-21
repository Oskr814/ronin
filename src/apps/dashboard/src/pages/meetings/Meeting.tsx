import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, client, ok, type Run } from '../../api.js';
import { useHost } from '../../host.js';
import { hhmm, repoShort, when } from '../../lib/format.js';
import { ICON } from '../../lib/icons.js';
import { Dot, money, RunCard, Transcript } from '../../lib/runs.js';
import { useViewState } from '../../lib/view-state.js';
import { ago, useNow } from '../../../../../ui/time.js';
import { EVERY_MS, StatusChip } from './Meetings.js';
import { chars, citedBy, noteLines, plural, source, type Detail } from './model.js';
import { Proposals } from './Proposals.js';

// A meeting's page (#62): what ronin proposes out of it, its notes, what
// happened to it and its runs. app.js routes to it (/reuniones/<n>), and
// opens it on a run when one of its runs is picked elsewhere (`run`).

type Tab = 'props' | 'notas' | 'act' | 'runs';
// What stays while the person is elsewhere, for the meeting they were on.
interface View { n: number; tab: Tab | null; run: string | null; open: Record<string, boolean> }

const isUnauthorized = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 401;

export function Meeting({ n, run }: { n: number; run?: string | null }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const [kept, keep] = useViewState<View | null>('meeting', null);
  const [shown, setShown] = useState<View>(() => {
    const view = kept?.n === n ? kept : { n, tab: null, run: null, open: {} };
    return run ? { ...view, tab: 'runs', run } : view;
  });
  useEffect(() => keep(shown), [shown]);
  const set = (patch: Partial<View>) => setShown({ ...shown, ...patch });
  const [flash, setFlash] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ['meeting', n],
    queryFn: () => ok(client.api.meetings[':n'].$get({ param: { n: String(n) } })),
    refetchInterval: EVERY_MS,
  });
  const d = query.data;
  const runQuery = useQuery({
    queryKey: ['run', shown.run],
    queryFn: () => ok(client.api.runs[':runId'].$get({ param: { runId: shown.run! } })),
    enabled: Boolean(shown.run),
    // While it goes, read again with the meeting.
    refetchInterval: (q) => (!q.state.data || q.state.data.summary.state === 'running' ? EVERY_MS : false),
  });
  useEffect(() => {
    for (const e of [query.error, runQuery.error]) if (isUnauthorized(e)) host.unauthorized(e.message);
  }, [query.error, runQuery.error, host]);

  // A line the person asked to see in the notes, outlined for a moment.
  useEffect(() => {
    if (flash === null) return;
    document.getElementById(`reu-l${flash}`)?.scrollIntoView({ block: 'center' });
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  if (!d) {
    const error = query.error && !isUnauthorized(query.error) ? query.error.message : null;
    return <div className="today pd">{error ? <p className="bad">{error}</p> : <div className="empty">Cargando…</div>}</div>;
  }

  const reload = () => queryClient.invalidateQueries({ queryKey: ['meeting', n] });
  const openRun = (runId: string) => {
    set({ tab: 'runs', run: runId });
    body.current?.scrollTo(0, 0);
  };
  const toggle = (key: string) => set({ open: { ...shown.open, [key]: !shown.open[key] } });
  const toLine = (line: number) => {
    set({ tab: 'notas' });
    setFlash(line);
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await ok(client.api.meetings[':n'].retry.$post({ param: { n: String(n) } }));
      host.toast(`Listo: ronin vuelve a leer R-${n}.`);
    } catch (e) {
      if (isUnauthorized(e)) return host.unauthorized(e.message);
      host.toast(`No se pudo: ${(e as Error).message}`);
    }
    setRetrying(false);
    await reload();
  };

  const total = d.proposals ? d.proposals.projects.length + d.proposals.issues.length + d.proposals.comments.length : 0;
  const tabs: Array<[Tab, string, number?]> = [...(d.proposals ? [['props', 'Propuestas', total] as [Tab, string, number]] : []), ['notas', 'Notas'], ['act', 'Actividad'], ['runs', 'Corridas', d.runs.length]];
  const tab = tabs.some(([k]) => k === shown.tab) ? shown.tab! : tabs[0][0];
  const cites = { open: shown.open, toggle, toLine };
  return (
    <>
      <Head d={d} />
      <div className="doctabs" role="tablist">
        {tabs.map(([k, label, c]) => <button key={k} className="doctab" role="tab" aria-selected={tab === k} onClick={() => set({ tab: k })}>{label}{c ? <> <span className="c">{c}</span></> : null}</button>)}
      </div>
      <div className="pd-body" ref={body}>
        <div className="pd-cols">
          <div className="pd-main">
            {tab !== 'runs' && <Now d={d} onRun={openRun} retrying={retrying} onRetry={retry} />}
            {tab === 'props' ? <Proposals d={d} cites={cites} onDone={reload} />
              : tab === 'act' ? <Activity d={d} onRun={openRun} />
                : tab === 'runs' ? <Runs d={d} open={shown.run} view={runQuery.data} error={runQuery.error && !isUnauthorized(runQuery.error) ? runQuery.error.message : null} onRun={openRun} onClose={() => set({ run: null })} />
                  : <Notes d={d} flash={flash} />}
          </div>
          <Side d={d} />
        </div>
      </div>
    </>
  );
}

function Head({ d }: { d: Detail }) {
  const host = useHost();
  const now = useNow();
  return (
    <div className="head pd-head">
      <div className="crumb"><button className="link" onClick={() => host.openMeetings()}>Reuniones</button> / <i style={{ background: host.repoColor(d.repo) }} />{repoShort(d.repo)}</div>
      <div className="row"><h1>{d.title} <span className="n">R-{d.number}</span></h1></div>
      <div className="state"><StatusChip m={d} />{d.at && <span>{when(d.at)}</span>}<span className="m">subida por {d.by} {ago(d.createdAt, now)}</span></div>
    </div>
  );
}

function Now({ d, onRun, retrying, onRetry }: { d: Detail; onRun: (runId: string) => void; retrying: boolean; onRetry: () => void }) {
  const running = d.runs.find((run) => run.state === 'running');
  if (d.status === 'pending' || d.status === 'reading') {
    return (
      <div className="pd-now running">
        <div className="k"><Dot cls="live" />{` Ahora · ${d.status === 'reading' ? 'ronin la está leyendo' : 'en cola para ronin'}`}</div>
        <div className="t">{d.status === 'reading' ? 'Lee las notas contra los issues abiertos, Linear y el código' : 'Espera un lugar libre para leerla'}</div>
        {running ? <>
          <div className="feed">{running.lastStep ? `▸ ${running.lastStep}` : 'Arrancando…'}</div>
          <div className="acts"><button className="btn-s" onClick={() => onRun(running.runId)}>Ver la corrida</button></div>
        </> : <div className="d">Suele tardar unos minutos. Al terminar, el equipo del repo recibe un correo si hay algo que revisar.</div>}
      </div>
    );
  }
  if (d.status === 'failed') {
    const last = d.events.filter((e) => e.kind === 'failed').at(-1);
    return (
      <div className="pd-now failed">
        <div className="k">{ICON.crit} Ahora · falló la lectura</div><div className="t">ronin no pudo leer las notas</div>
        {last && <div className="err">{last.error}</div>}
        <div className="acts"><button className="btn-s primary" disabled={retrying} onClick={onRetry}>{retrying ? 'Pidiendo…' : 'Leerla de nuevo'}</button></div>
      </div>
    );
  }
  if (d.status === 'empty') {
    return <div className="pd-now"><div className="k">{ICON.ok} Leída</div><div className="t">No salió trabajo nuevo de esta reunión</div><div className="d">ronin no propuso nada y no mandó correo. Lo que se habló está abajo, con el motivo.</div></div>;
  }
  return null;
}

function Notes({ d, flash }: { d: Detail; flash: number | null }) {
  const by = citedBy(d);
  const path = `/api/meetings/${d.number}/original`;
  return <>
    {d.original
      ? <div className="reu-src"><span className="fi">{d.source.kind === 'docx' ? 'DOCX' : d.source.kind === 'pdf' ? 'PDF' : 'TXT'}</span><div><span className="nm">{d.source.name ?? ''}</span><small>{source(d)} · {chars(d.chars)}</small></div><a className="btn-s" href={path} download>Descargar original</a></div>
      : <p className="m pd-note">Pegadas en el tablero · {chars(d.chars)}.</p>}
    <div className="reu-notes">
      {noteLines(d.text).map((line, i) => {
        const tags = by[i + 1];
        return <div key={i} className={`reu-line ${tags ? 'cited' : ''}${flash === i + 1 ? ' flash' : ''}`} id={`reu-l${i + 1}`}><span className="n">{i + 1}</span><span className="t">{line}{tags && <span className="tags">{[...tags].join(', ')}</span>}</span></div>;
      })}
    </div>
  </>;
}

function Activity({ d, onRun }: { d: Detail; onRun: (runId: string) => void }) {
  const item = (key: string, cls: string, icon: keyof typeof ICON, title: ReactNode, at: string, extra: ReactNode = null) => ({
    at,
    el: <li key={key} className={`pd-ev ${cls}`}><span className="ic">{ICON[icon]}</span><div className="h"><b>{title}</b><span className="tm" title={when(at)}>{hhmm(at)}</span></div>{extra}</li>,
  });
  const counted = (e: { projects: number; issues: number; comments: number }) => [e.projects ? plural(e.projects, 'proyecto', 'proyectos') : '', e.issues ? plural(e.issues, 'issue', 'issues') : '', e.comments ? plural(e.comments, 'comentario', 'comentarios') : ''].filter(Boolean).join(', ') || 'nada';
  const events = d.events.map((e, i) => {
    const k = `e${i}`;
    switch (e.kind) {
      case 'uploaded': return item(k, 'person', 'person', `${e.by} subió las notas`, e.at);
      case 'retried': return item(k, 'person', 'person', `${e.by} pidió leerla de nuevo`, e.at);
      case 'worker': return item(k, 'small', 'wait', e.by === 'tick' ? 'El tick la vio sin worker y lanzó otro' : 'Lanzó el worker que la lee', e.at);
      case 'read': return item(k, 'ok', 'ok', `Propuso ${counted(e)}`, e.at, <div className="m">{plural(e.discarded, 'descartado', 'descartados')}</div>);
      case 'failed': return item(k, 'crit', 'crit', 'La lectura falló', e.at, <div className="bx err">{e.error}</div>);
      case 'mail': return item(k, e.ok ? 'small' : 'crit', 'mail', e.ok ? 'Correo al equipo del repo' : 'No salió el correo al equipo', e.at);
      case 'approved': return item(k, e.failed ? 'warn' : 'ok', e.failed ? 'crit' : 'ok', `${e.by} aprobó: ${plural(e.created, 'creado', 'creados')}${e.failed ? `, ${plural(e.failed, 'no se pudo crear', 'no se pudieron crear')}` : ''}`, e.at);
      case 'discarded': return item(k, 'small', 'person', `${e.by} descartó ${d.status === 'discarded' && Object.values(d.results).some((r) => r.ok) ? 'el resto' : 'la reunión'}`, e.at);
      default: return null;
    }
  }).filter((x) => x !== null);
  const runs = d.runs.map((run) => item(run.runId, 'run', 'run', 'ronin leyó las notas', run.startedAt, <RunCard run={run} onOpen={onRun} />));
  return <ol className="pd-tl">{[...events, ...runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((x) => x.el)}</ol>;
}

function Runs({ d, open, view, error, onRun, onClose }: { d: Detail; open: string | null; view: Run | undefined; error: string | null; onRun: (runId: string) => void; onClose: () => void }) {
  const host = useHost();
  if (!d.runs.length) return <p className="note">Sin corridas en los últimos 14 días.</p>;
  const list = d.runs.map((run) => <div key={run.runId} className={`pd-runrow ${open === run.runId ? 'cur' : ''}`}><span className="tm">{when(run.startedAt)}</span><RunCard run={run} onOpen={onRun} /></div>);
  if (!open) return <>{list}</>;
  const summary = view?.summary.runId === open ? view.summary : null;
  return <>
    <div className="pd-runview">
      <div className="pd-runbar"><b>{host.typeName(summary?.taskType ?? '')}</b><span className="m">{summary ? when(summary.startedAt) : ''}</span><button className="btn-s" onClick={onClose}>Cerrar</button></div>
      {summary ? <Transcript run={view!} /> : <div className="empty">{error ?? 'Cargando la corrida…'}</div>}
    </div>
    {list}
  </>;
}

function Side({ d }: { d: Detail }) {
  const host = useHost();
  return (
    <div className="pd-side">
      <div className="pd-card"><h3>Reunión</h3><dl className="kv">
        {d.at && <><dt>Cuándo</dt><dd>{when(d.at)}</dd></>}
        <dt>Repo</dt><dd>{d.repo}</dd>
        <dt>Subida</dt><dd>{d.by}<small>{when(d.createdAt)}</small></dd>
        <dt>Notas</dt><dd>{source(d)}<small>{chars(d.chars)}</small></dd>
        {d.link && /^https?:\/\//.test(d.link) && <><dt>Link</dt><dd><a href={d.link} target="_blank" rel="noopener noreferrer">{`${d.link.replace(/^https?:\/\//, '').slice(0, 40)} ↗`}</a></dd></>}
      </dl></div>
      {d.runs.length > 0 && <div className="pd-card"><h3>Corridas</h3><div className="pd-costs">{d.runs.slice().reverse().map((run) => <div key={run.runId}><span>{host.typeName(run.taskType)}</span><span>{run.costUsd !== undefined ? money(run.costUsd) : run.state === 'running' ? 'en curso' : '—'}</span></div>)}</div></div>}
    </div>
  );
}
