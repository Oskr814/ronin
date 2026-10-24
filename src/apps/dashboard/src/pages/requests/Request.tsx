import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useRepoColor, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { hhmm, when } from '@apps/dashboard/src/lib/format.js';
import { Ending, money, RunCard, Skeleton, Steps, typeName } from '@apps/dashboard/src/lib/runs.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { ago, useNow } from '@ui/time.js';
import { Activity } from './Activity.js';
import { ActionsContext, Chat, Repro, Team, useActions, type Actions } from './Docs.js';
import { GitHub } from './GitHub.js';
import { BugTag, EVERY_MS, PriorityTag, imagePath, issueUrl, prUrl, repoShort, REPRODUCTIONS, StatusChip, Stepper, type Detail } from './model.js';

// A portal request's page (#132): its activity, its conversation, what goes
// to the team, a reported error's reproduction, its issue and PR, and its
// runs, with the request's facts beside them.

const TABS: Array<[Tab, string]> = [['act', 'Actividad'], ['repro', 'Reproducción'], ['chat', 'Conversación'], ['team', 'Para el equipo'], ['gh', 'Issue'], ['runs', 'Corridas']];
type Tab = 'act' | 'repro' | 'chat' | 'team' | 'gh' | 'runs';

// What's open on it, kept while the person is elsewhere and dropped for
// another request.
interface View { n: number; tab: Tab; show: 'issue' | 'pr'; run: string | null }

function Side({ d }: { d: Detail }) {
  const shell = useShell();
  const mails = d.activity.entries.flatMap((e) => (e.type === 'event' && e.event.kind === 'mail' ? [{ at: e.at, event: e.event }] : []));
  const gh = (number: number, url: string, label: string) => <><a href={url} target="_blank" rel="noopener">{label}</a> <button className="link" onClick={() => shell.openItem(`${d.repo}#${number}`)}>en el tablero</button></>;
  return (
    <div className="pd-side">
      <div className="pd-card"><h3>Pedido</h3><dl className="kv">
        <dt>Quién</dt><dd>{d.person}{d.email && <small>{d.email}</small>}</dd>
        <dt>App</dt><dd>{d.appName} <small>{d.repo}</small></dd>
        <dt>Abierto</dt><dd>{when(d.createdAt)}</dd>
        <dt>Preguntas</dt><dd>{d.questions} de 3</dd>
        {d.bug ? <><dt>Reproducciones</dt><dd>{d.bug.reproductions.length} de {REPRODUCTIONS}</dd></> : <><dt>Propuestas</dt><dd>{d.prototypes.length + d.proposals} de 3{d.proposals > 0 && <small>{d.proposals === 1 ? '1 sin prototipo' : `${d.proposals} sin prototipo`}</small>}</dd></>}
        {d.issue && <><dt>Issue</dt><dd>{gh(d.issue.number, issueUrl(d.repo, d.issue.number) ?? '#', `#${d.issue.number}`)}</dd></>}
        {d.pr && <><dt>PR</dt><dd>{gh(d.pr, prUrl(d.repo, d.pr) ?? '#', `#${d.pr}`)}</dd></>}
      </dl></div>
      <div className="pd-card"><h3>Corridas</h3>{d.runs.length ? (
        <div className="pd-costs">{d.runs.slice().reverse().map((run) => <div key={run.runId}><span>{typeName(run.taskType)}</span><span>{run.costUsd !== undefined ? money(run.costUsd) : run.state === 'running' ? 'en curso' : '—'}</span></div>)}<div className="tot"><span>{d.runs.length} {d.runs.length === 1 ? 'corrida' : 'corridas'}</span><span>{money(d.costUsd)}</span></div></div>
      ) : <p className="m">Ninguna en los últimos 14 días.</p>}</div>
      {mails.length > 0 && <div className="pd-card"><h3>Correos</h3><div className="pd-mails">{mails.map((e, i) => <div key={i} className={e.event.ok ? '' : 'bad'}><span className="tm">{hhmm(e.at)}</span><span>{e.event.ok ? '' : 'no salió · '}a {e.event.to === 'team' ? 'el equipo' : d.person}</span></div>)}</div></div>}
    </div>
  );
}

// Its runs, and the one open with its transcript, read again while it goes.
function Runs({ d, open, close }: { d: Detail; open: string | null; close: () => void }) {
  const shell = useShell();
  const actions = useActions();
  const query = useQuery({
    queryKey: ['run', open],
    queryFn: () => ok(client.api.runs[':runId'].$get({ param: { runId: open! } })),
    enabled: Boolean(open),
    refetchInterval: (q) => (q.state.data && q.state.data.summary.state !== 'running' ? false : EVERY_MS),
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);
  if (!d.runs.length) return <p className="note">Sin corridas en los últimos 14 días.</p>;
  const list = d.runs.map((run) => <div key={run.runId} className={`pd-runrow ${open === run.runId ? 'cur' : ''}`}><span className="tm">{when(run.startedAt)}</span><RunCard run={run} onOpen={actions.run} /></div>);
  if (!open) return <>{list}</>;
  const data = query.data;
  return (
    <>
      <div className="pd-runview"><div className="pd-runbar"><b>{typeName(data?.summary.taskType ?? '')}</b><span className="m">{data ? when(data.summary.startedAt) : ''}</span><button className="btn-s" onClick={close}>Cerrar</button></div>
        {data ? <div className="tx pd-tx"><Steps lines={data.lines} /><Ending summary={data.summary} /></div>
          : query.error ? <div className="empty">{query.error.message}</div> : <Skeleton kind="tx" label="Cargando la corrida…" />}</div>
      {list}
    </>
  );
}

function Lightbox({ n, file, close }: { n: number; file: string; close: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  return createPortal(
    <div id="lightbox" className="lightbox"><div className="lt"><b>P-{n}</b><span className="m">{file}</span><button id="lb-x" onClick={close}>Cerrar ✕</button></div><div className="lb"><figure><div><img src={imagePath(n, file)} alt="" /></div></figure></div></div>,
    document.body,
  );
}

export function Request({ n, run }: { n: number; run?: string | null }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const now = useNow();
  const fresh: View = { n, tab: 'act', show: 'issue', run: null };
  const [kept, setView] = useViewState<View>('request', fresh);
  const view = kept.n === n ? kept : fresh;
  const set = (change: Partial<View>) => setView({ ...view, ...change });
  const [zoom, setZoom] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // A run asked for from elsewhere (Hoy's timeline), on Corridas.
  useEffect(() => {
    if (run) setView({ ...view, tab: 'runs', run });
  }, [run]);

  const query = useQuery({
    queryKey: ['request', n],
    queryFn: () => ok(client.api.requests[':n'].$get({ param: { n: String(n) } })),
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);

  const d = query.data;
  if (!d) {
    const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? query.error.message : null;
    return <div className="today pd">{error ? <p className="bad">{error}</p> : <div className="empty">Cargando…</div>}</div>;
  }
  const actions: Actions = {
    tab: (tab) => set({ tab: tab as Tab }),
    run: (runId) => {
      set({ tab: 'runs', run: runId });
      body.current?.scrollTo(0, 0);
    },
    zoom: setZoom,
  };
  const counts: Partial<Record<Tab, number>> = { chat: d.messages.length, runs: d.runs.length, repro: d.bug?.reproductions.length };
  // Reproducción, only for a reported error; Issue, once it has one, and its PR with it.
  const tabs = TABS.filter(([k]) => (k !== 'repro' || d.bug) && (k !== 'gh' || d.issue)).map(([k, label]): [Tab, string] => [k, k === 'gh' && d.pr ? 'Issue y PR' : label]);
  const tab = tabs.some(([k]) => k === view.tab) ? view.tab : 'act';
  const main = tab === 'chat' ? <Chat d={d} /> : tab === 'team' ? <Team d={d} /> : tab === 'gh' ? <GitHub d={d} show={view.show} setShow={(show) => set({ show })} />
    : tab === 'runs' ? <Runs d={d} open={view.run} close={() => set({ run: null })} /> : tab === 'repro' ? <Repro d={d} /> : <Activity d={d} />;
  return (
    <ActionsContext.Provider value={actions}>
      <div className="head pd-head"><div className="crumb"><button className="link" onClick={() => shell.openRequests()}>Portal de pedidos</button> / <i style={{ background: repoColor(d.repo) }} />{repoShort(d.repo)} · {d.appName}</div>
        <div className="row"><h1>{d.title} <span className="n">P-{d.number}</span></h1></div>
        <div className="state"><StatusChip p={d} /><PriorityTag p={d} /><BugTag p={d} />{d.deployed && <span className="chip ok" title={when(d.deployed.at)}>en la app desde {d.deployed.tag}</span>}<span>{d.person}</span><span className="m">abierto {ago(d.createdAt, now)}</span>{d.issue && <button className="link" onClick={() => shell.openItem(`${d.repo}#${d.issue!.number}`)}>#{d.issue.number}</button>}{d.pr && <button className="link" onClick={() => shell.openItem(`${d.repo}#${d.pr}`)}>PR #{d.pr}</button>}</div>
        <Stepper p={d} /></div>
      <div className="doctabs" role="tablist">{tabs.map(([k, label]) => <button key={k} className="doctab" role="tab" aria-selected={tab === k} onClick={() => set({ tab: k })}>{label}{counts[k] ? <> <span className="c">{counts[k]}</span></> : null}</button>)}</div>
      <div className="pd-body" ref={body}><div className="pd-cols"><div className="pd-main">{main}</div><Side d={d} /></div></div>
      {zoom && <Lightbox n={d.number} file={zoom} close={() => setZoom(null)} />}
    </ActionsContext.Provider>
  );
}
