import { useLayoutEffect, useRef } from 'react';
import { type ItemView, showRun } from '@apps/dashboard/src/shell/hooks.js';
import { hhmm, isMobile } from '@apps/dashboard/src/lib/format.js';
import { duration, Ending, money, RUN_STATE, RunDot, Since, Steps, typeName } from '@apps/dashboard/src/lib/runs.js';
import { short } from '@ui/time.js';
import { entryRun, runEntries, runsOf, runNames } from './model.js';

// An item's runs (#85): the activity line under its head, with the run going
// on, and the transcript of one of them, which is the page of what has no
// page (a changelog entry).

const VERB: Record<string, string> = { Bash: 'Corrió', Read: 'Leyó', Edit: 'Editó', MultiEdit: 'Editó', Write: 'Escribió', NotebookEdit: 'Editó', Grep: 'Buscó', Glob: 'Buscó', WebFetch: 'Abrió', WebSearch: 'Buscó en la web', Task: 'Lanzó un agente', Agent: 'Lanzó un agente', TodoWrite: 'Anotó tareas' };
const arg = (summary: unknown) => String(summary ?? '').replace(/^\$ /, '');

export function Activity({ v }: { v: ItemView }) {
  const { item } = v;
  const runs = runsOf(v);
  const open = (i: number) => showRun(item.id, i, 'tx');
  if (runs.length === 0) return <div className="activity"><div className="act-line"><span className="lbl">Actividad</span><span className="m">{v.runs === null ? 'Cargando…' : 'Sin corridas de agentes en los últimos 14 días.'}</span></div></div>;
  const entries = runEntries(runs);
  // The latest run (a group of steps as one) is the line itself, or the card
  // below it; the older ones, pills that open their transcript.
  const latest = entryRun(runs, entries[0]);
  const older = entries.slice(1).map((entry) => {
    const run = entryRun(runs, entry);
    return <button key={entry.idx[0]} className="pill" onClick={() => open(entry.idx[0])}><RunDot state={run.state} />{runNames.entryName(item, runs, entry)}<span className="m">{short(Date.now() - Date.parse(run.endedAt ?? run.startedAt))}</span></button>;
  });
  let summary = null;
  if (latest.state !== 'running') {
    const label = (RUN_STATE[latest.state] ?? RUN_STATE.error)[2];
    const facts = [label, `hace ${short(Date.now() - Date.parse(latest.endedAt ?? latest.startedAt))}`, latest.durationMs !== undefined ? duration(latest.durationMs) : null, latest.costUsd !== undefined ? money(latest.costUsd) : null].filter(Boolean).join(' · ');
    summary = <span className="latest"><RunDot state={latest.state} /><b>{runNames.entryName(item, runs, entries[0])}</b><span className="m">{facts}</span></span>;
  }
  const line = <div className="act-line"><span className="lbl">Actividad</span>{summary}{older.length > 0 && <span className="pills">{older}</span>}<span className="sp"><button className="link" onClick={() => open(0)}>transcript →</button></span></div>;
  if (latest.state !== 'running') return <div className="activity">{line}{latest.state === 'error' && latest.error && <div className="last-err">{latest.error}</div>}</div>;
  // The run going on: what the agent last said and its last few steps.
  const lines = v.run?.runId === latest.runId ? v.run.lines : [];
  const said = [...lines].reverse().find((l) => l.type === 'text');
  const steps = lines.filter((l) => l.type === 'tool').slice(-4);
  return (
    <div className="activity">{line}<div className="livecard"><div className="top"><RunDot state="running" /><b>{runNames.name(item, latest)}{latest.sliceIndex !== undefined ? `, slice ${latest.sliceIndex + 1}` : ''}</b><Since className="clk" at={latest.startedAt} />{latest.model && <span className="m">{latest.model}</span>}</div>
      {said && <div className="say">{String(said.text)}</div>}
      {steps.length ? <ol>{steps.map((l, i) => <li key={i}><b>{VERB[String(l.name)] ?? String(l.name)}</b> <span className="arg">{arg(l.summary)}</span></li>)}</ol> : <div className="m">{v.run?.runId === latest.runId ? 'Arrancando…' : 'Cargando…'}</div>}</div></div>
  );
}

// One run's transcript, with the item's runs to pick another (a group's
// steps under its pill). Whoever was reading further up stays there,
// whoever was at the bottom of a run still going follows it.
export function Transcript({ v }: { v: ItemView }) {
  const { item } = v;
  const runs = runsOf(v);
  const tx = useRef<HTMLDivElement>(null);
  const shownRun = useRef<string | null>(null);
  const atBottom = useRef(true);
  const loaded = runs.length && v.run?.runId === runs[Math.min(v.runIdx, runs.length - 1)].runId ? v.run : null;
  useLayoutEffect(() => {
    const el = tx.current;
    if (!el || isMobile()) return;
    if (shownRun.current !== loaded?.runId || atBottom.current) el.scrollTop = el.scrollHeight;
    shownRun.current = loaded?.runId ?? null;
  });
  const back = item.kind !== 'other' ? <button className="pill back-ficha" onClick={() => showRun(item.id, 0, 'ficha')}>← Ficha</button> : null;
  if (runs.length === 0) {
    return <>{back && <div className="runs">{back}</div>}<div className="tx"><div className="empty">{v.runs === null ? 'Cargando…' : <b>Sin corridas de agentes en los últimos 14 días</b>}</div></div></>;
  }
  const index = Math.min(v.runIdx, runs.length - 1);
  const pill = (i: number, label: string, pressed: boolean, run = runs[i]) => (
    <button key={i} className="pill" aria-pressed={pressed} onClick={() => showRun(item.id, i, 'tx')}><RunDot state={run.state} />{label}<span className="m">{run.state === 'running' ? 'en curso' : `${hhmm(run.startedAt)}${run.durationMs !== undefined ? `, ${duration(run.durationMs)}` : ''}`}</span></button>
  );
  const entries = runEntries(runs);
  const open = entries.find((entry) => entry.idx.includes(index))!;
  return <>
    <div className="runs">{back}<span className="lbl">Corridas</span>{entries.map((entry) => pill(entry.idx[0], runNames.entryName(item, runs, entry), entry === open, entryRun(runs, entry)))}</div>
    {open.idx.length > 1 && <div className="runs steps"><span className="lbl">Pasos</span>{[...open.idx].reverse().map((i) => pill(i, typeName(runs[i].taskType), i === index))}</div>}
    {!loaded ? <div className="tx"><div className="empty">Cargando la corrida…</div></div> : <>
      <div className="tx" id="tx" ref={tx} onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      }}><Steps lines={loaded.lines} /><Ending summary={loaded.summary} /></div>
      <div className="foot">{loaded.summary.state === 'running'
        ? <><span className="w">● Trabajando</span><Since at={loaded.summary.startedAt} /></>
        : <span>{RUN_STATE[loaded.summary.state]?.[2] ?? loaded.summary.state}</span>}<span>{runNames.title(loaded.summary)}</span><span className="r">{[loaded.summary.model, loaded.summary.worktree].filter(Boolean).join('  ')}</span></div>
    </>}
  </>;
}
