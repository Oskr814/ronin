import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useShell } from '../../shell/hooks.js';
import { when } from '../../lib/format.js';
import { Dot, duration, money, RunDot, Since, Transcript, typeName } from '../../lib/runs.js';
import { useViewState } from '../../lib/view-state.js';
import { at, RUNS_EVERY_MS } from './model.js';

// An app's exploration runs (#155, 2/4), with the agents of each: one opens
// its transcript above the list. On the app's page, and on its exploration
// PR's (pages/item, in its Corridas tab).

const SNAPSHOT_EVERY_MS = 5000;
const TRIGGER: Record<string, string> = { noche: 'de noche', manual: 'a pedido', desconocido: 'sin registro' };
const STATE: Record<string, [string, string]> = { running: ['live', 'en curso'], ok: ['ok', 'terminó bien'], error: ['crit', 'falló'], cut: ['crit', 'se cortó'] };

type Runs = Awaited<ReturnType<typeof runsOf>>['corridas'];
type ExplorationRun = Runs[number];
const runsOf = (repo: string, app: string) => ok(client.api.explorations[':owner'][':name'][':app'].runs.$get(at(repo, app)));

const isUnauthorized = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 401;

function trigger(t: ExplorationRun['trigger']) {
  if (t.kind === 'issue' && 'issueNumber' in t) return `/explore en #${t.issueNumber}`;
  if (t.kind === 'manual' && 'by' in t && t.by) return `a pedido de ${t.by}`;
  return TRIGGER[t.kind] ?? t.kind;
}

function RunItem({ c, open, onOpen }: { c: ExplorationRun; open: string | null; onOpen: (runId: string) => void }) {
  const [tone, said] = STATE[c.state] ?? STATE.error;
  const took = c.state === 'running' ? <Since at={c.startedAt} /> : c.endedAt ? duration(Date.parse(c.endedAt) - Date.parse(c.startedAt)) : '';
  const facts: string[] = [];
  if (c.findings) facts.push(c.findings.length ? `${c.findings.length} ${c.findings.length === 1 ? 'ficha' : 'fichas'}: ${c.findings.map((f) => f.id).join(', ')}` : 'ninguna ficha');
  if (c.discarded) facts.push(`${c.discarded} ${c.discarded === 1 ? 'descartada' : 'descartadas'}`);
  if (c.prNumber) facts.push(`PR #${c.prNumber}`);
  if (c.seed !== undefined) facts.push(`semilla ${c.seed}`);
  if (c.legacy) facts.push('de antes del registro de corridas: sin semilla ni fichas');
  return (
    <div className="xr">
      <div className="xr-h"><Dot cls={tone} /><b>{when(c.startedAt)}</b><span className="tag">{trigger(c.trigger)}</span><span className="m">{said}</span><span className="st">{took}{c.costUsd ? ` · ${money(c.costUsd)}` : ''}</span></div>
      {c.functions.length > 0 && <div className="xr-fns">{c.functions.map((f) => (
        <span key={f.id} className={`xr-fn ${f.status === 'fallo' ? 'bad' : f.status === 'omitida' ? 'off' : ''}`} title={[f.status, f.reason && `motivo: ${f.reason}`, f.role && `rol: ${f.role}`, f.error].filter(Boolean).join(' · ')}>
          {f.id}{f.charter && <> <span className="m">{f.charter}{f.viewports?.length ? ` · ${f.viewports.join(', ')}` : ''}</span></>}
        </span>
      ))}</div>}
      {c.error && <div className="xr-err">{c.error}</div>}
      {facts.length > 0 && <div className="xr-f">{facts.map((f) => <span key={f}>{f}</span>)}</div>}
      {c.agents.length > 0 && <div className="xr-ags">{c.agents.map((a) => (
        <button key={a.runId} className={`xr-ag ${open === a.runId ? 'cur' : ''}`} onClick={() => onOpen(a.runId)}>
          <RunDot state={a.state} />{typeName(a.taskType)}{a.fn ? ` ${a.fn}` : ''}<span className="m">{a.state === 'running' ? 'en curso' : a.durationMs !== undefined ? duration(a.durationMs) : ''}</span>
        </button>
      ))}</div>}
    </div>
  );
}

export function ExplorationRuns({ repo, app }: { repo: string; app: string }) {
  const shell = useShell();
  const here = useRef<HTMLDivElement>(null);
  const key = `${repo}|${app}`;
  // The agent open, for the app it was opened on: another app's page doesn't show it.
  const [kept, keep] = useViewState<{ key: string; runId: string } | null>('exploration-run', null);
  const open = kept?.key === key ? kept.runId : null;
  useEffect(() => {
    if (kept && kept.key !== key) keep(null);
  }, [key]);

  const query = useQuery({ queryKey: ['exploration-runs', repo, app], queryFn: () => runsOf(repo, app), refetchInterval: RUNS_EVERY_MS });
  const run = useQuery({
    queryKey: ['run', open],
    queryFn: () => ok(client.api.runs[':runId'].$get({ param: { runId: open! } })),
    enabled: Boolean(open),
    // While it goes, read again with the snapshot.
    refetchInterval: (q) => (q.state.data?.summary.state === 'running' ? SNAPSHOT_EVERY_MS : false),
  });
  useEffect(() => {
    for (const e of [query.error, run.error]) if (isUnauthorized(e)) shell.unauthorized(e.message);
  }, [query.error, run.error, shell]);

  if (!query.data) return <div className="empty">{query.error ? `No se pudieron leer las corridas: ${query.error.message}` : 'Leyendo las corridas…'}</div>;
  const list = query.data.corridas;
  if (!list.length) return <p className="note">Sin corridas en los últimos 14 días.</p>;
  const summary = run.data?.summary.runId === open ? run.data.summary : null;
  const onOpen = (runId: string) => {
    keep({ key, runId });
    // Above the list: the page goes back up to it.
    const doc = here.current?.closest('#doc');
    if (doc) doc.scrollTop = 0;
  };
  return <>
    {open && <div className="pd-runview">
      <div className="pd-runbar"><b>{typeName(summary?.taskType ?? '')}</b><span className="m">{summary ? when(summary.startedAt) : ''}</span><button className="btn-s" onClick={() => keep(null)}>Cerrar</button></div>
      {summary ? <Transcript run={run.data!} /> : <div className="empty">{run.error ? run.error.message : 'Cargando la corrida…'}</div>}
    </div>}
    <div className="xr-list" ref={here}>{list.map((c) => <RunItem key={c.id} c={c} open={open} onOpen={onOpen} />)}</div>
  </>;
}
