import { useLayoutEffect, useRef } from 'react';
import { useHost } from '../host.js';

// An agent's run as the pages that list them show it (a portal request's):
// its card, its transcript and how it ended, written as app.js writes them.

const MIN = 60e3;

// [the dot's class, a chip's, in words].
export const RUN_STATE: Record<string, [string, string, string]> = {
  running: ['live', 'run', 'trabajando'],
  ok: ['ok', 'ok', 'terminó bien'],
  error: ['crit', 'crit', 'falló'],
  timeout: ['crit', 'crit', 'se pasó del tiempo'],
  usage_limit: ['warn', 'warn', 'sin cuota de Claude'],
  cut: ['crit', 'crit', 'se cortó'],
  blocked: ['crit', 'crit', 'bloqueado'],
  waiting: ['warn', 'warn', 'esperando a alguien'],
  open: ['pending', 'idle', 'abierto'],
};
const VERB: Record<string, string> = { Bash: 'Corrió', Read: 'Leyó', Edit: 'Editó', MultiEdit: 'Editó', Write: 'Escribió', NotebookEdit: 'Editó', Grep: 'Buscó', Glob: 'Buscó', WebFetch: 'Abrió', WebSearch: 'Buscó en la web', Task: 'Lanzó un agente', Agent: 'Lanzó un agente', TodoWrite: 'Anotó tareas' };
// Runs that are steps of one thing (platform/agents/run-group.ts).
const GROUP_NAME: Record<string, string> = { preview: 'Preview' };

export function duration(ms: number): string {
  const m = Math.round(ms / MIN);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const money = (usd: number) => (usd < 0.01 ? 'menos de US$0,01' : `US$${usd.toFixed(2).replace('.', ',')}`);
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const Dot = ({ cls }: { cls: string }) => <span className={`dot ${cls}`} aria-hidden="true" />;
export const RunDot = ({ state }: { state: string }) => <Dot cls={(RUN_STATE[state] ?? RUN_STATE.error)[0]} />;

// How long it's been going: app.js's clock (tickClocks) moves every
// [data-since] each second; this only writes the first.
export function Since({ at }: { at: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = clock(Date.now() - Date.parse(at));
  }, [at]);
  return <span ref={ref} data-since={at} />;
}

export interface RunLike {
  runId: string;
  taskType: string;
  state: string;
  group?: string;
  issueNumber?: number;
  prNumber?: number;
  startedAt: string;
  durationMs?: number;
  costUsd?: number;
  lastStep?: string;
}

// What a run is, a group's step saying which one: "Preview: Revisión de los seeds".
export function useRunTitle() {
  const host = useHost();
  return (run: RunLike) => {
    const group = run.group ? GROUP_NAME[run.group.split(':')[0]] : undefined;
    return group ? `${group}: ${host.typeName(run.taskType)}` : host.typeName(run.taskType);
  };
}

export function RunCard({ run, onOpen }: { run: RunLike; onOpen: (runId: string) => void }) {
  const host = useHost();
  const live = run.state === 'running';
  const facts = [run.durationMs !== undefined ? duration(run.durationMs) : null, run.costUsd !== undefined ? money(run.costUsd) : null, RUN_STATE[run.state]?.[2]].filter(Boolean).join(' · ');
  return (
    <div className="pd-run"><RunDot state={run.state} /><span className="nm">{host.typeName(run.taskType)}{run.issueNumber ? ` · #${run.issueNumber}` : run.prNumber ? ` · PR #${run.prNumber}` : ''}</span>
      <span className="st">{live ? <Since at={run.startedAt} /> : facts}</span>
      <button className="go" onClick={() => onOpen(run.runId)}>{live ? 'Ver en vivo' : 'Ver corrida'} →</button>
      {run.lastStep && <span className="last">{live ? '▸' : 'último:'} {run.lastStep}</span>}</div>
  );
}

export interface RunLine {
  type: string;
  text?: string;
  name?: string;
  summary?: unknown;
}

function Step({ line }: { line: RunLine }) {
  if (line.type === 'text') return <div className="say">{line.text}</div>;
  if (line.type === 'tool_error') return <div className="out">{line.text}</div>;
  if (line.type === 'tool') {
    const summary = String(line.summary ?? '').replace(/^\$ /, '');
    return <div className="step"><b>{VERB[line.name ?? ''] ?? line.name}</b> <span className="arg">{summary}</span></div>;
  }
  return null;
}

// A run's transcript: its steps, or that there are none yet.
export function Steps({ lines }: { lines: RunLine[] }) {
  const shown = lines.filter((line) => ['text', 'tool_error', 'tool'].includes(line.type));
  return shown.length ? <>{shown.map((line, i) => <Step key={i} line={line} />)}</> : <div className="empty">El agente todavía no hizo nada.</div>;
}

export function Ending({ summary }: { summary: { state: string; durationMs?: number; costUsd?: number; error?: string } }) {
  const extra = [summary.durationMs !== undefined ? duration(summary.durationMs) : null, summary.costUsd !== undefined ? money(summary.costUsd) : null].filter(Boolean).join(', ');
  switch (summary.state) {
    case 'ok': return <div className="end ok"><b>Terminó bien.</b> {extra}</div>;
    case 'timeout': return <div className="end crit"><b>Se pasó del tiempo límite</b> y se cortó. {extra}</div>;
    case 'usage_limit': return <div className="end warn"><b>Se quedó sin cuota de Claude.</b> Se reintenta cuando la cuenta se reinicie.</div>;
    case 'cut': return <div className="end crit"><b>Se cortó:</b> el proceso de ronin terminó sin cerrar la corrida.</div>;
    case 'error': return <div className="end crit"><b>Falló.</b> {summary.error ?? ''}</div>;
    default: return null;
  }
}
